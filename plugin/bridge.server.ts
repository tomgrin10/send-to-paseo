import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  BridgeError,
  CONTRACT_VERSION,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  ResolveRequestSchema,
  SendRequestSchema,
  type BridgeStatus,
  type ErrorBody,
  type ModeOption,
  type PingResponse,
  type ProviderOption,
} from "./contracts.shared";
import { readDaemonStatus, withPaseo } from "./daemon.server";
import { logDependencySelfCheck } from "./deps.server";
import { lifecycle } from "./lifecycle.shared";
import {
  handleResolve,
  listEffectiveProviders,
  listModes,
  resolveSelectedProfile,
} from "./resolve.server";
import { handleSend, isDryRun, recordFailedSend } from "./send.server";
import { previewToken, settings, tokenMatches } from "./settings.server";

/**
 * The local HTTP bridge the Chrome extension talks to.
 *
 * This endpoint can start agents that run arbitrary code on this machine, so it
 * is treated as a real privilege boundary rather than a convenience:
 *
 *  - it binds `127.0.0.1` only, never `0.0.0.0`;
 *  - it rejects any request carrying a non-extension `Origin`, on the preflight
 *    as well as the real request, because CORS only stops a page *reading* a
 *    response and would not stop the side effect;
 *  - it rejects any `Host` that is not the loopback address it bound, which
 *    closes DNS rebinding;
 *  - it requires a bearer token everywhere except `GET /v1/ping`;
 *  - it caps bodies and rate limits per origin.
 *
 * It also owns the reload story. A listening HTTP server keeps the plugin
 * subprocess event loop alive, which wedges Paseo's "Stopping plugin" step, so
 * teardown closes the listener *and* every keep-alive socket and waits for the
 * close to complete. That teardown is handed to `index.ts` through
 * `lifecycle.shared`, never by name, because Paseo strips `*.server` imports
 * out of the client bundle.
 */

const BIND_HOST = "127.0.0.1";
/** Bounded drain so an oversized upload gets a real 413 instead of a reset. */
const DRAIN_CEILING_BYTES = MAX_BODY_BYTES * 16;
const SHUTDOWN_GRACE_MS = 3_000;

type BridgeState = "starting" | "running" | "failed" | "stopped";

interface Runtime {
  server: Server;
  sockets: Set<Socket>;
  port: number;
}

let runtime: Runtime | null = null;
let startPromise: Promise<void> | null = null;
let stopping = false;

const status = {
  state: "starting" as BridgeState,
  port: DEFAULT_PORT,
  configuredPort: DEFAULT_PORT,
  error: null as string | null,
  startedAt: null as string | null,
  lastRequestAt: null as string | null,
  requestCount: 0,
};

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Sliding window per origin. Pruned lazily on each request rather than on a
 * timer, because a live `setInterval` in this subprocess is exactly what hangs
 * plugin teardown.
 */
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const window = (hits.get(key) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (window.length >= RATE_LIMIT_MAX) {
    hits.set(key, window);
    return true;
  }
  window.push(now);
  hits.set(key, window);
  if (hits.size > 64) {
    for (const [otherKey, timestamps] of hits) {
      if (timestamps.every((at) => now - at >= RATE_LIMIT_WINDOW_MS)) hits.delete(otherKey);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

function writeJson(
  res: ServerResponse,
  code: number,
  body: unknown,
  headers: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // Sent on every response, allowed or not, so no cache can mix them up.
    Vary: "Origin",
    ...headers,
  });
  res.end(payload);
}

/** CORS echo for an origin that already passed the extension-origin check. */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    // Deliberately no Access-Control-Allow-Credentials.
  };
}

function fail(
  res: ServerResponse,
  error: BridgeError,
  headers: Record<string, string> = {},
): void {
  const body: ErrorBody = error.toBody();
  writeJson(res, error.status, body, headers);
}

function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const allowed = [`${BIND_HOST}:${port}`, `localhost:${port}`];
  if (port === 80) allowed.push(BIND_HOST, "localhost");
  return allowed.includes(host.toLowerCase());
}

/**
 * Reads at most `MAX_BODY_BYTES`, but keeps draining past that so an oversized
 * request still receives its 413 rather than a connection reset.
 */
function readBody(req: IncomingMessage): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "");
    let tooLarge = Number.isFinite(declared) && declared > MAX_BODY_BYTES;
    const chunks: Buffer[] = [];
    let total = 0;
    let drained = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      drained += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        if (drained > DRAIN_CEILING_BYTES) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ body: Buffer.concat(chunks), tooLarge }));
    req.on("error", reject);
    req.on("aborted", () => resolve({ body: Buffer.alloc(0), tooLarge }));
  });
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) {
    throw new BridgeError("bad_request", "A JSON body is required.");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new BridgeError("bad_request", "The request body is not valid JSON.");
  }
}

/** Turns a Zod failure into one readable sentence for the popover. */
function badRequest(issues: { path: PropertyKey[]; message: string }[]): BridgeError {
  const first = issues[0];
  const where = first === undefined ? "" : first.path.map(String).join(".");
  const detail =
    first === undefined
      ? "The request body did not match the expected shape."
      : where === ""
        ? first.message
        : `${where}: ${first.message}`;
  return new BridgeError("bad_request", detail);
}

/** True when the caller sent any `Authorization` header at all. */
function hasAuthHeader(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === "string" && header.trim() !== "";
}

async function requireToken(req: IncomingMessage): Promise<void> {
  const header = req.headers.authorization;
  const presented =
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (presented === "") {
    throw new BridgeError(
      "unauthorized",
      "This request needs the Send to Paseo pairing token.",
      "Copy the token from Paseo -> Send to Paseo into the extension options page.",
    );
  }
  const current = await settings.read();
  if (!tokenMatches(current.token, presented)) {
    throw new BridgeError(
      "unauthorized",
      "That pairing token is not valid for this Paseo bridge.",
      "Copy the current token from Paseo -> Send to Paseo.",
    );
  }
  if (!current.paired) await settings.markPaired().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Health, and the one place the extension can validate a pasted token.
 *
 * Auth is optional but not ignored, per CONTRACT.md "Token validation on ping":
 * no header is the unauthenticated liveness check (so the options page can tell
 * "bridge down" from "bad token"), a valid token also returns the provider list,
 * and an invalid token is a 401 rather than a cheerful 200.
 */
async function ping(authenticated: boolean): Promise<PingResponse> {
  const daemon = await readDaemonStatus();
  let providers: ProviderOption[] = [];
  let modes: ModeOption[] = [];
  if (authenticated) {
    try {
      ({ providers, modes } = await withPaseo(async (paseo) => {
        // The same effective default the popover preselects, so ping and
        // resolve never disagree about which model is "the" default.
        const profile = await resolveSelectedProfile(paseo);
        const [providerResult, catalog] = await Promise.all([
          listEffectiveProviders(paseo, profile),
          listModes(paseo),
        ]);
        return { providers: providerResult.providers, modes: catalog.modes };
      }));
    } catch (error) {
      // Ping reports status; it does not fail. An unreachable daemon already
      // shows up in `daemon.reachable`.
      console.error("[send-to-paseo] could not list providers for ping", String(error));
    }
  }
  return {
    ok: true,
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    contract: CONTRACT_VERSION,
    daemon,
    paired: authenticated,
    providers,
    modes,
  };
}

async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const cors = corsHeaders(req.headers.origin);

  if (path === "/v1/ping") {
    if (req.method !== "GET") throw methodNotAllowed();
    // An Authorization header, once sent, is validated: a garbage token must not
    // come back as a 200 that the options page would read as "paired".
    const authenticated = hasAuthHeader(req);
    if (authenticated) await requireToken(req);
    writeJson(res, 200, await ping(authenticated), cors);
    return;
  }

  if (path === "/v1/resolve" || path === "/v1/send") {
    if (req.method !== "POST") throw methodNotAllowed();
    const { body, tooLarge } = await readBody(req);
    if (tooLarge) {
      throw new BridgeError(
        "payload_too_large",
        `The request body is larger than the ${MAX_BODY_BYTES / 1024} KiB limit.`,
      );
    }
    await requireToken(req);
    const json = parseJsonBody(body);

    if (path === "/v1/resolve") {
      const parsed = ResolveRequestSchema.safeParse(json);
      if (!parsed.success) throw badRequest(parsed.error.issues);
      writeJson(res, 200, await handleResolve(parsed.data), cors);
      return;
    }

    const parsed = SendRequestSchema.safeParse(json);
    if (!parsed.success) throw badRequest(parsed.error.issues);
    try {
      writeJson(res, 200, await handleSend(parsed.data), cors);
    } catch (error) {
      // Validation noise does not belong in the surface's send history; a real
      // failure to create a workspace or an agent does.
      const isValidation = error instanceof BridgeError && error.code === "bad_request";
      if (error instanceof Error && !isValidation) await recordFailedSend(parsed.data, error);
      throw error;
    }
    return;
  }

  // The path is not echoed back: it is caller-controlled, and a response body
  // is no place to reflect it.
  throw new BridgeError(
    "bad_request",
    "No such endpoint on this bridge.",
    "Valid paths are /v1/ping, /v1/resolve and /v1/send.",
  );
}

function methodNotAllowed(): BridgeError {
  return new BridgeError("bad_request", "That method is not allowed on this endpoint.");
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const port = runtime?.port ?? status.port;
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  // 1. Origin. A page origin is refused outright, on the preflight too, so the
  //    real request is never even sent by the browser.
  if (origin !== undefined) {
    const current = await settings.read().catch(() => null);
    const pinned = current?.allowedExtensionIds ?? [];
    const isExtension = origin.startsWith("chrome-extension://");
    const isPinned =
      pinned.length === 0 || pinned.some((id) => origin === `chrome-extension://${id}`);
    if (!isExtension || !isPinned) {
      console.error(`[send-to-paseo] refused a request from a non-extension origin`);
      fail(
        res,
        new BridgeError(
          "forbidden_origin",
          "This bridge only accepts requests from the Send to Paseo browser extension.",
        ),
      );
      return;
    }
  }

  // 2. Host. Closes DNS rebinding from a page that resolves a name to 127.0.0.1.
  if (!hostAllowed(req.headers.host, port)) {
    fail(
      res,
      new BridgeError("forbidden_host", "This bridge only answers on 127.0.0.1 or localhost."),
      cors,
    );
    return;
  }

  // 3. Rate limit, before any work is done. Keyed on Origin when there is one
  //    and on the remote address otherwise, so a curl flood from the CLI cannot
  //    consume the extension's budget.
  if (rateLimited(origin ?? `ip:${req.socket.remoteAddress ?? "unknown"}`)) {
    fail(res, new BridgeError("rate_limited", "Too many requests; slow down."), {
      ...cors,
      "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
    });
    return;
  }

  status.requestCount += 1;
  status.lastRequestAt = new Date().toISOString();

  // 4. Preflight. Browsers never attach Authorization to it.
  if (req.method === "OPTIONS") {
    res.writeHead(204, { Vary: "Origin", "Cache-Control": "no-store", ...cors });
    res.end();
    return;
  }

  const path = new URL(req.url ?? "/", `http://${BIND_HOST}:${port}`).pathname;
  try {
    await route(req, res, path);
  } catch (error) {
    if (error instanceof BridgeError) {
      fail(res, error, cors);
      return;
    }
    // Anything unexpected is generic on the wire; the detail goes to the log.
    console.error("[send-to-paseo] request failed", String(error));
    fail(res, new BridgeError("internal", "The Send to Paseo bridge hit an unexpected error."), cors);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function describeListenError(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === "EADDRINUSE") {
    return `Port ${port} is already in use, so the Send to Paseo bridge did not start. Pick another port in Paseo -> Send to Paseo.`;
  }
  if (error.code === "EACCES") {
    return `Port ${port} needs elevated privileges, so the Send to Paseo bridge did not start. Pick a port above 1024.`;
  }
  return `The Send to Paseo bridge could not listen on 127.0.0.1:${port}: ${error.message}`;
}

async function startBridge(): Promise<void> {
  if (stopping) return;
  const current = await settings.read().catch(() => null);
  const port = current?.port ?? DEFAULT_PORT;
  status.configuredPort = port;
  status.port = port;
  status.state = "starting";
  status.error = null;

  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void onRequest(req, res).catch((error: unknown) => {
      console.error("[send-to-paseo] request handler crashed", String(error));
      if (!res.headersSent) {
        fail(res, new BridgeError("internal", "The Send to Paseo bridge hit an unexpected error."));
      }
    });
  });
  // Keep-alive sockets are what hold a plugin subprocess open; keep them short
  // lived and track every one so teardown can destroy them.
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, BIND_HOST);
    });
  } catch (error) {
    status.state = "failed";
    status.error = describeListenError(error as NodeJS.ErrnoException, port);
    console.error(`[send-to-paseo] ${status.error}`);
    server.close();
    return;
  }

  // A late error must not take the subprocess down with it.
  server.on("error", (error) => {
    console.error("[send-to-paseo] bridge server error", String(error));
  });

  runtime = { server, sockets, port };
  status.state = "running";
  status.startedAt = new Date().toISOString();
  console.log(
    `[send-to-paseo] bridge listening on http://${BIND_HOST}:${port}${isDryRun() ? " (dry run)" : ""}`,
  );

  // One line per external command, once, to `paseo plugin logs send-to-paseo`.
  // Deliberately not awaited: the bridge is already serving, and a slow
  // `gh auth status` must not delay that. Runs once per plugin start.
  void logDependencySelfCheck();

  if (stopping) await stopBridge();
}

async function stopBridge(): Promise<void> {
  const active = runtime;
  runtime = null;
  if (active === null) {
    status.state = "stopped";
    return;
  }
  const closed = new Promise<void>((done) => {
    active.server.close(() => done());
  });
  // `close()` alone waits forever on idle keep-alive sockets, which is exactly
  // the failure that wedges "Stopping plugin".
  active.server.closeAllConnections();
  for (const socket of active.sockets) socket.destroy();
  active.sockets.clear();

  const timeout = new Promise<void>((done) => {
    const timer = setTimeout(done, SHUTDOWN_GRACE_MS);
    timer.unref?.();
  });
  await Promise.race([closed, timeout]);
  status.state = "stopped";
  console.log("[send-to-paseo] bridge stopped");
}

/** Rebinds the listener, used when the port changes from the Paseo surface. */
export async function restartBridge(): Promise<BridgeStatus> {
  await startPromise?.catch(() => undefined);
  await stopBridge();
  stopping = false;
  startPromise = startBridge();
  await startPromise;
  return getBridgeStatus();
}

export async function getBridgeStatus(): Promise<BridgeStatus> {
  const [current, daemon] = await Promise.all([settings.read(), readDaemonStatus()]);
  return {
    state: status.state,
    port: status.port,
    configuredPort: current.port,
    error: status.error,
    startedAt: status.startedAt,
    lastRequestAt: status.lastRequestAt,
    requestCount: status.requestCount,
    paired: current.paired,
    dryRun: isDryRun(),
    tokenPreview: previewToken(current.token),
    defaultProvider: current.defaultProvider,
    defaultProfileId: current.defaultProfileId,
    defaultModeId: current.defaultModeId,
    daemon,
  };
}

/**
 * Starts as an import side effect and registers teardown through the shared
 * lifecycle object. `contribute()` cannot do either: Paseo strips `*.server`
 * imports from the client bundle while keeping the surrounding statements, so
 * naming anything in this module from the cleanup returned by `index.ts` would
 * throw a ReferenceError in the app and break every contribution.
 */
lifecycle.teardown = async () => {
  stopping = true;
  await startPromise?.catch(() => undefined);
  await stopBridge();
};

startPromise = startBridge().catch((error: unknown) => {
  status.state = "failed";
  status.error = error instanceof Error ? error.message : String(error);
  console.error("[send-to-paseo] bridge failed to start", status.error);
});
