import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { BridgeError } from "../shared/contracts";
import { resolveDaemonPassword } from "./daemon-password";
import { settings } from "./settings";
import { invokeFollowUp } from "./follow-up-id";
import { sharedDaemon } from "./shared-daemon";

/**
 * The plugin's one held daemon connection (one-held-daemon-connection, AGENTS.md).
 *
 * Only RPC handlers receive a `paseo` handle, and the bridge serves requests
 * that arrive long before any surface is opened, so it keeps its own
 * connection. Every bridge request (`withPaseo`) and every optional Follow Up
 * call (`callFollowUp`) runs on the same held DaemonClient: a request gets a
 * scoped SDK view (`createPaseoApi`) that is disposed when it ends, never a new
 * socket. A drop retires the connection and the next request opens one fresh;
 * `closeDaemon` in the plugin's teardown closes it, so a held socket never
 * hangs Paseo's "Stopping plugin" step. 2026-11-17 live: a connection per
 * request meant about 20 hellos a minute for each of the two client names
 * while a browser had the extension open.
 */

const CONNECT_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 2_000;
/** An optional Follow Up call, connect included, gives up after this long. */
const FOLLOW_UP_TIMEOUT_MS = 2_000;
const STATUS_TTL_MS = 15_000;

function timeoutSignal(ms: number): AbortSignal {
  return (
    AbortSignal as typeof AbortSignal & {
      timeout(milliseconds: number): AbortSignal;
    }
  ).timeout(ms);
}

type PaseoApi = PluginHandlerContext["paseo"];

/** The subset of Paseo's DaemonClient this plugin uses. */
interface DaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  invokePluginRpc(plugin: string, method: string, input: unknown): Promise<unknown>;
}

interface ClientModule {
  createPaseoApi(client: DaemonClient): PaseoApi & { dispose(): Promise<void> };
  DaemonClient: new (options: {
    url: string;
    clientId: string;
    clientType: "cli";
    reconnect: { enabled: boolean };
    connectTimeoutMs: number;
    suppressSendErrors: boolean;
    password?: string;
  }) => DaemonClient;
}

let clientModule: ClientModule | null = null;

/**
 * Borrows Paseo's own SDK and daemon client from the host at runtime.
 *
 * The specifiers are assembled rather than written as literals so the plugin
 * compiler cannot resolve them at build time. That keeps the plugin installable
 * from a directory or from Git without a package manager step, and it removes
 * any chance of a protocol version skew between a bundled copy of the SDK and
 * the daemon actually running.
 */
function loadClientModule(): ClientModule {
  if (clientModule !== null) return clientModule;
  const sdk = ["@getpaseo", "client"].join("/");
  const internal = [sdk, "internal", "daemon-client"].join("/");
  // Paseo compiles plugin backends to CommonJS, so `require` is normally right
  // here. `createRequire` keeps this working if a host ever loads the module as
  // real ESM instead, where `require` is not defined.
  const load: NodeRequire =
    typeof require === "function" ? require : createRequire(join(process.cwd(), "noop.cjs"));
  try {
    const { createPaseoApi } = load(sdk) as Pick<ClientModule, "createPaseoApi">;
    const { DaemonClient } = load(internal) as Pick<ClientModule, "DaemonClient">;
    clientModule = { createPaseoApi, DaemonClient };
  } catch (error) {
    throw new BridgeError(
      "daemon_unreachable",
      `This Paseo host does not expose its client SDK (${sdk}), which the Send to Paseo bridge needs: ${
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
 * hash (`$2b$12$…`), by design. The plaintext has to be supplied. Four sources,
 * in order:
 *
 *   1. `SEND_TO_PASEO_DAEMON_PASSWORD` — this plugin's own override.
 *   2. `PASEO_PASSWORD` — the standard Paseo variable, the same one the `paseo`
 *      CLI reads. Honoured for the same reason `PASEO_HOME` and
 *      `PASEO_DAEMON_URL` are: a machine already configured for the CLI should
 *      not need configuring again for this.
 *   3. `~/paseo-hub/secrets/daemon-password` — the Paseo VM convention.
 *   4. `daemonPassword` in the plugin's own `settings.json`.
 *
 * The env vars are checked first, but the two files are reloadable: the plugin
 * subprocess inherits the daemon's environment, which is fixed at daemon
 * start, and restarting the daemon kills running agents. A file change is
 * picked up by `paseo plugin reload`.
 *
 * Password values are never logged, echoed into an error, or included in a
 * status payload — the same treatment as the pairing token.
 */
async function resolvePassword(): Promise<string | undefined> {
  return resolveDaemonPassword(async () => (await settings.read()).daemonPassword);
}

/**
 * Builds and connects the one client. The only place a DaemonClient is built;
 * a failure here is a `daemon_unreachable` BridgeError.
 */
async function openDaemon(): Promise<DaemonClient> {
  const { DaemonClient } = loadClientModule();
  const password = await resolvePassword();
  const client = new DaemonClient({
    url: await resolveUrl(),
    clientId: "send-to-paseo",
    clientType: "cli",
    reconnect: { enabled: false },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    suppressSendErrors: true,
    // Omitted rather than passed as "" when there is none, so a daemon without
    // auth is unaffected.
    ...(password === undefined ? {} : { password }),
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    // A daemon that wants a password is REACHABLE and refusing, which is a
    // different fix from "start Paseo". The hint has to say which.
    if (/password/i.test(detail)) {
      throw new BridgeError(
        "daemon_unreachable",
        "The Paseo daemon requires a password and the plugin does not have it.",
        "Set SEND_TO_PASEO_DAEMON_PASSWORD, ~/paseo-hub/secrets/daemon-password, or daemonPassword in the plugin settings, then run: paseo plugin reload send-to-paseo",
      );
    }
    throw new BridgeError(
      "daemon_unreachable",
      "The Paseo daemon is not reachable from the plugin.",
      detail,
    );
  }
}

const shared = sharedDaemon(openDaemon);

/** Closes the held connection. The plugin's teardown runs it after the bridge stops. */
export function closeDaemon(): Promise<void> {
  return shared.close();
}

/** Optional companion RPCs always target this daemon, never a browser-selected host. */
export async function callFollowUp(method: "follow.pr-owner" | "follow.pr-workspaces" | "follow.browser-exchange", input: unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      shared.run((client) => invokeFollowUp((plugin, m, i) => client.invokePluginRpc(plugin, m, i), method, input)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Optional Follow Up request timed out.")), FOLLOW_UP_TIMEOUT_MS); timer.unref?.(); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Runs `work` against a scoped SDK view of the held connection, released before returning. */
export async function withPaseo<T>(work: (paseo: PaseoApi) => Promise<T>): Promise<T> {
  const { createPaseoApi } = loadClientModule();
  return shared.run(async (client) => {
    const paseo = createPaseoApi(client);
    try {
      return await work(paseo);
    } finally {
      // Releases this request's handles and listeners, never the socket.
      await paseo.dispose().catch(() => undefined);
    }
  });
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
