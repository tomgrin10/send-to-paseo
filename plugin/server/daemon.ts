import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BridgeError } from "../shared/contracts";
import { settings } from "./settings";

/**
 * Short-lived Paseo SDK connections for the HTTP bridge.
 *
 * Only RPC handlers receive a `paseo` handle, and the bridge serves requests
 * that arrive long before any surface is opened, so it opens its own SDK
 * connection per request and closes it again. That is deliberate on two counts:
 * a long-lived reconnecting socket in this subprocess would keep the event loop
 * alive and hang Paseo's "Stopping plugin" step, and a per-request connection
 * cannot go stale between sends.
 */

const CONNECT_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 2_000;
const STATUS_TTL_MS = 15_000;

function timeoutSignal(ms: number): AbortSignal {
  return (
    AbortSignal as typeof AbortSignal & {
      timeout(milliseconds: number): AbortSignal;
    }
  ).timeout(ms);
}

type ClientModule = typeof import("@getpaseo/client");

let clientModule: ClientModule | null = null;

/**
 * Borrows Paseo's own SDK from the host at runtime.
 *
 * The specifier is assembled rather than written as a literal so the plugin
 * compiler cannot resolve it at build time. That keeps the plugin installable
 * from a directory or from Git without a package manager step, and it removes
 * any chance of a protocol version skew between a bundled copy of the SDK and
 * the daemon actually running.
 */
function loadClientModule(): ClientModule {
  if (clientModule !== null) return clientModule;
  const specifier = ["@getpaseo", "client"].join("/");
  // Paseo compiles plugin backends to CommonJS, so `require` is normally right
  // here. `createRequire` keeps this working if a host ever loads the module as
  // real ESM instead, where `require` is not defined.
  const load: NodeRequire =
    typeof require === "function" ? require : createRequire(join(process.cwd(), "noop.cjs"));
  try {
    clientModule = load(specifier) as ClientModule;
  } catch (error) {
    throw new BridgeError(
      "daemon_unreachable",
      `This Paseo host does not expose its client SDK (${specifier}), which the Send to Paseo bridge needs: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return clientModule;
}

let cachedListen: string | null = null;

/** `host:port` the daemon listens on, from config or the documented default. */
async function resolveListen(): Promise<string> {
  if (cachedListen !== null) return cachedListen;
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  let listen: string | undefined;
  try {
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      daemon?: { listen?: string };
    };
    listen = raw.daemon?.listen;
  } catch {
    // Fall through to the documented default.
  }
  cachedListen = listen ?? "127.0.0.1:6767";
  return cachedListen;
}

async function resolveUrl(): Promise<string> {
  const fromEnv = process.env.PASEO_DAEMON_URL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return `ws://${await resolveListen()}/ws`;
}

/**
 * The daemon password, when this daemon requires one.
 *
 * A daemon that listens on anything other than loopback turns on
 * `daemon.auth.password`, and then it rejects an unauthenticated WebSocket with
 * `Password required` and answers `/api/status` with `401` — so without this the
 * plugin lists no providers, no modes, reports the daemon unreachable, and every
 * send fails. Measured against a daemon on `0.0.0.0:6767`.
 *
 * It cannot be recovered from `config.json`: what is stored there is a bcrypt
 * hash (`$2b$12$…`), by design. The plaintext has to be supplied. Three sources,
 * in order:
 *
 *   1. `SEND_TO_PASEO_DAEMON_PASSWORD` — this plugin's own override.
 *   2. `PASEO_PASSWORD` — the standard Paseo variable, the same one the `paseo`
 *      CLI reads. Honoured for the same reason `PASEO_HOME` and
 *      `PASEO_DAEMON_URL` are: a machine already configured for the CLI should
 *      not need configuring again for this.
 *   3. `daemonPassword` in the plugin's own `settings.json`.
 *
 * The env vars are checked first, but the settings file is the usable one: the
 * plugin subprocess inherits the daemon's environment, which is fixed at daemon
 * start, and restarting the daemon kills running agents. A settings change is
 * picked up by `paseo plugin reload`.
 *
 * File-only with no UI, exactly like `allowedExtensionIds` and `allowedHosts`.
 * Never logged, never echoed into an error, and never included in a status
 * payload — the same treatment as the pairing token.
 */
async function resolvePassword(): Promise<string | undefined> {
  for (const key of ["SEND_TO_PASEO_DAEMON_PASSWORD", "PASEO_PASSWORD"] as const) {
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  }
  const stored = await settings.read().catch(() => null);
  const password = stored?.daemonPassword ?? null;
  return password === null || password === "" ? undefined : password;
}

/** Runs `work` against an SDK connection that is always closed before returning. */
export async function withPaseo<T>(work: (paseo: PaseoApi) => Promise<T>): Promise<T> {
  const { createPaseoClient } = loadClientModule();
  const password = await resolvePassword();
  const client = createPaseoClient({
    url: await resolveUrl(),
    clientId: "send-to-paseo-bridge",
    reconnect: { enabled: false },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    suppressSendErrors: true,
    // Omitted rather than passed as "" when there is none, so a daemon without
    // auth is unaffected.
    ...(password === undefined ? {} : { password }),
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    // A daemon that wants a password is REACHABLE and refusing, which is a
    // different fix from "start Paseo". The hint has to say which.
    if (/password/i.test(detail)) {
      throw new BridgeError(
        "daemon_unreachable",
        "The Paseo daemon requires a password and the plugin does not have it.",
        "Set daemonPassword in the plugin's settings.json (or SEND_TO_PASEO_DAEMON_PASSWORD), then run: paseo plugin reload send-to-paseo",
      );
    }
    throw new BridgeError(
      "daemon_unreachable",
      "The Paseo daemon is not reachable from the plugin.",
      detail,
    );
  }
  try {
    return await work(client);
  } finally {
    // Teardown must not mask the original result or error.
    await client.close().catch(() => undefined);
  }
}

export interface DaemonStatus {
  reachable: boolean;
  version: string | null;
  serverId: string | null;
}

let statusCache: { at: number; status: DaemonStatus } | null = null;

/**
 * This machine's `serverId`, straight off disk.
 *
 * `$PASEO_HOME/server-id` is the daemon's own copy of the value agent deep links
 * are keyed on, and reading it needs no daemon and no credential. That matters:
 * `/api/status` is behind auth on a daemon that has a password, so a deep link
 * used to be unbuildable there even though the id was sitting in a file the
 * plugin can already read.
 *
 * Returns null rather than throwing; the caller falls back to `/api/status`.
 */
async function readServerIdFile(): Promise<string | null> {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  try {
    const raw = (await readFile(join(home, "server-id"), "utf8")).trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/**
 * Daemon identity over its plain HTTP status endpoint.
 *
 * `/api/status` is far cheaper than a WebSocket handshake, and `serverId` from
 * it is what agent deep links are keyed on. Cached briefly because `/v1/ping`
 * is polled by the extension's options page.
 *
 * Two things this deliberately gets right, both measured against a daemon with
 * `daemon.auth.password` set (which is what any non-loopback `listen` turns on):
 *
 *  - **`401` is not `unreachable`.** That endpoint requires auth on such a
 *    daemon, and reporting the daemon as down because we were refused is simply
 *    a false statement — the options page said "Paseo daemon unreachable" about
 *    a daemon that was running perfectly. `/api/health` is unauthenticated, so
 *    it is what liveness is actually decided by.
 *  - **`serverId` does not depend on being authorized**, because it is on disk.
 */
export async function readDaemonStatus(): Promise<DaemonStatus> {
  if (statusCache !== null && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.status;
  }
  const base = `http://${await resolveListen()}`;
  let status: DaemonStatus = { reachable: false, version: null, serverId: null };
  try {
    const response = await fetch(`${base}/api/status`, {
      signal: timeoutSignal(STATUS_TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.json()) as { version?: unknown; serverId?: unknown };
      status = {
        reachable: true,
        version: typeof body.version === "string" ? body.version : null,
        serverId: typeof body.serverId === "string" ? body.serverId : null,
      };
    } else if (response.status === 401 || response.status === 403) {
      // It answered. It just would not tell us. Liveness comes from the
      // unauthenticated endpoint, and the id from disk.
      const health = await fetch(`${base}/api/health`, {
        signal: timeoutSignal(STATUS_TIMEOUT_MS),
      }).catch(() => null);
      status = {
        reachable: health?.ok === true,
        version: null,
        serverId: await readServerIdFile(),
      };
    }
  } catch {
    // Unreachable is a reported state, not an error: /v1/ping still returns 200.
  }
  if (status.serverId === null) status.serverId = await readServerIdFile();
  statusCache = { at: Date.now(), status };
  return status;
}

/**
 * The daemon's `serverId`, which an agent deep link cannot be built without.
 * Bypasses the cache when it is missing so a send does not fail just because a
 * stale "unreachable" answer is still warm.
 */
export async function requireServerId(): Promise<string> {
  let status = await readDaemonStatus();
  if (status.serverId === null) {
    statusCache = null;
    status = await readDaemonStatus();
  }
  if (status.serverId === null) {
    throw new BridgeError(
      "daemon_unreachable",
      "The Paseo daemon did not report a server id, so an agent link cannot be built.",
    );
  }
  return status.serverId;
}

export function clearDaemonCaches(): void {
  statusCache = null;
  cachedListen = null;
}
