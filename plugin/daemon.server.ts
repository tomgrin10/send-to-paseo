import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BridgeError } from "./contracts.shared";

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

/** Runs `work` against an SDK connection that is always closed before returning. */
export async function withPaseo<T>(work: (paseo: PaseoApi) => Promise<T>): Promise<T> {
  const { createPaseoClient } = loadClientModule();
  const client = createPaseoClient({
    url: await resolveUrl(),
    clientId: "send-to-paseo-bridge",
    reconnect: { enabled: false },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    suppressSendErrors: true,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new BridgeError(
      "daemon_unreachable",
      "The Paseo daemon is not reachable from the plugin.",
      error instanceof Error ? error.message : undefined,
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
 * Daemon identity over its plain HTTP status endpoint.
 *
 * `/api/status` is far cheaper than a WebSocket handshake, and `serverId` from
 * it is what agent deep links are keyed on. Cached briefly because `/v1/ping`
 * is polled by the extension's options page.
 */
export async function readDaemonStatus(): Promise<DaemonStatus> {
  if (statusCache !== null && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.status;
  }
  let status: DaemonStatus = { reachable: false, version: null, serverId: null };
  try {
    const response = await fetch(`http://${await resolveListen()}/api/status`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.json()) as { version?: unknown; serverId?: unknown };
      status = {
        reachable: true,
        version: typeof body.version === "string" ? body.version : null,
        serverId: typeof body.serverId === "string" ? body.serverId : null,
      };
    }
  } catch {
    // Unreachable is a reported state, not an error: /v1/ping still returns 200.
  }
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
