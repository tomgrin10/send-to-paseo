import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  BridgeError,
  CONTRACT_VERSION,
  ERROR_STATUS,
  PLUGIN_NAME,
  externalBridgeUrlProblem,
  normalizeExternalBridgeUrl,
  type AdditionalMachine,
  type ErrorBody,
  type ErrorCode,
  type PingResponse,
  type ResolveRequest,
  type ResolveResponse,
  type ResolveRoute,
  type SendRequest,
  type SendResponse,
} from "../shared/contracts";
import { resolveBinary, runProcess } from "./deps";
import { previewToken, settings, type Settings } from "./settings";

const CONNECTION_CODE_PREFIX = "stp1_";
/**
 * The extension gives resolve 10 seconds and send 60 seconds. A routed
 * operation performs an authenticated ping before the real request, so these
 * are total route budgets shared by both calls rather than per-fetch timers.
 * That keeps a dead Additional machine from making the Primary miss the
 * browser's deadline, while allowing workspace creation to take longer than
 * the old 12-second per-request limit.
 */
const RESOLVE_ROUTE_TIMEOUT_MS = 9_000;
const SEND_ROUTE_TIMEOUT_MS = 55_000;

type SavedMachine = Settings["additionalMachines"][number];

interface ConnectionCodePayload {
  v: 1;
  url: string;
  token: string;
  label: string;
}

export interface ConnectionCodeResult {
  ready: boolean;
  code: string | null;
  bridgeUrl: string | null;
  command: string;
  error: string | null;
}

export function encodeConnectionCode(payload: ConnectionCodePayload): string {
  return `${CONNECTION_CODE_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decodeConnectionCode(code: string): ConnectionCodePayload {
  const trimmed = code.trim();
  if (!trimmed.startsWith(CONNECTION_CODE_PREFIX)) {
    throw new Error("This is not a Send to Paseo connection code (expected stp1_…).");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(trimmed.slice(CONNECTION_CODE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("The connection code is damaged or incomplete. Copy it again.");
  }
  if (raw === null || typeof raw !== "object") throw new Error("The connection code is invalid.");
  const payload = raw as Partial<ConnectionCodePayload>;
  if (payload.v !== 1 || typeof payload.url !== "string" || typeof payload.token !== "string") {
    throw new Error("The connection code uses an unsupported format.");
  }
  if (payload.token.trim() === "") throw new Error("The connection code has no pairing token.");
  const problem = externalBridgeUrlProblem(payload.url);
  if (problem !== null) throw new Error(`The connection code has an invalid private bridge address: ${problem}`);
  return {
    v: 1,
    url: normalizeExternalBridgeUrl(payload.url),
    token: payload.token,
    label: typeof payload.label === "string" ? payload.label.trim().slice(0, 120) : "",
  };
}

function displayName(machine: SavedMachine): string {
  return machine.label.trim() || machine.machineName.trim() || new URL(machine.bridgeUrl).host;
}

export function publicMachine(machine: SavedMachine): AdditionalMachine {
  return {
    id: machine.id,
    label: machine.label,
    bridgeUrl: machine.bridgeUrl,
    enabled: machine.enabled,
    machineName: machine.machineName,
    tokenPreview: previewToken(machine.token),
  };
}

export async function addMachineFromCode(code: string): Promise<AdditionalMachine> {
  const payload = decodeConnectionCode(code);
  const current = await settings.read();
  const duplicate = current.additionalMachines.find((machine) => machine.bridgeUrl === payload.url);
  const machine: SavedMachine = {
    id: duplicate?.id ?? randomUUID(),
    label: payload.label || duplicate?.label || "",
    bridgeUrl: payload.url,
    token: payload.token,
    enabled: true,
    machineName: duplicate?.machineName ?? "",
  };
  await settings.addAdditionalMachine(machine);
  return publicMachine(machine);
}

function connectionCodeFor(current: Settings): string | null {
  if (current.externalBridgeUrl === null) return null;
  return encodeConnectionCode({
    v: 1,
    url: current.externalBridgeUrl,
    token: current.token,
    label: hostname() || new URL(current.externalBridgeUrl).hostname,
  });
}

export async function getMachineConnectionCode(): Promise<ConnectionCodeResult> {
  const current = await settings.read();
  const command = `tailscale serve --bg ${current.port}`;
  const code = connectionCodeFor(current);
  return {
    ready: code !== null,
    code,
    bridgeUrl: current.externalBridgeUrl,
    command,
    error:
      code === null
        ? "Private access is not enabled yet. Enable it here, or run the command on this Paseo machine."
        : null,
  };
}

function processMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const withStderr = error as Error & { stderr?: string };
  return (withStderr.stderr ?? error.message).trim() || error.message;
}

export async function enableMachinePrivateAccess(): Promise<ConnectionCodeResult> {
  const current = await settings.read();
  const command = `tailscale serve --bg ${current.port}`;
  const tailscale = await resolveBinary("tailscale", [process.env.SEND_TO_PASEO_TAILSCALE_PATH ?? ""]);
  if (tailscale === null) {
    return {
      ready: false,
      code: null,
      bridgeUrl: current.externalBridgeUrl,
      command,
      error: "Tailscale was not found. Install it, then run the command on this Paseo machine.",
    };
  }

  try {
    await runProcess(tailscale, ["serve", "--bg", String(current.port)], { timeoutMs: 12_000 });
    const { stdout } = await runProcess(tailscale, ["status", "--json"], { timeoutMs: 8_000 });
    const parsed = JSON.parse(stdout) as { Self?: { DNSName?: unknown } };
    const dnsName = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.replace(/\.$/, "") : "";
    if (dnsName === "") throw new Error("Tailscale did not report this machine's private DNS name.");
    const bridgeUrl = normalizeExternalBridgeUrl(`https://${dnsName}`);
    const next = await settings.update({ externalBridgeUrl: bridgeUrl });
    return {
      ready: true,
      code: connectionCodeFor(next),
      bridgeUrl,
      command,
      error: null,
    };
  } catch (error) {
    return {
      ready: false,
      code: null,
      bridgeUrl: current.externalBridgeUrl,
      command,
      error: `Tailscale could not enable private access: ${processMessage(error)}`,
    };
  }
}

async function fetchJson(
  machine: SavedMachine,
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetch(`${machine.bridgeUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${machine.token}`,
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch {
    throw new Error(
      controller.signal.aborted
        ? `${displayName(machine)} did not answer at its private bridge address within ${Math.ceil(timeoutMs / 1000)}s.`
        : `Can't reach ${displayName(machine)} at its private bridge address.`,
    );
  } finally {
    clearTimeout(timeout);
  }
  const json = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const body = json as Partial<ErrorBody> | null;
    const code = body?.error?.code;
    if (typeof code === "string" && code in ERROR_STATUS) {
      throw new BridgeError(
        code as ErrorCode,
        body?.error?.message ?? `${displayName(machine)} returned HTTP ${response.status}.`,
        body?.error?.hint,
      );
    }
    throw new Error(body?.error?.message ?? `${displayName(machine)} returned HTTP ${response.status}.`);
  }
  return json;
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function checkedPing(machine: SavedMachine, deadline: number): Promise<PingResponse> {
  const json = (await fetchJson(
    machine,
    "/v1/ping",
    undefined,
    remainingMs(deadline),
  )) as Partial<PingResponse>;
  if (json.ok !== true || json.name !== PLUGIN_NAME || typeof json.contract !== "number") {
    throw new Error(`${displayName(machine)} did not return a Send to Paseo bridge response.`);
  }
  if (json.contract !== CONTRACT_VERSION) {
    throw new Error(
      `${displayName(machine)} uses bridge contract v${json.contract}; this machine uses v${CONTRACT_VERSION}. Update the older plugin.`,
    );
  }
  if (json.paired !== true) throw new Error(`${displayName(machine)} rejected its connection code.`);
  return json as PingResponse;
}

export async function testMachine(machine: SavedMachine): Promise<{
  ok: boolean;
  machineName: string | null;
  detail: string;
}> {
  try {
    const ping = await checkedPing(machine, Date.now() + RESOLVE_ROUTE_TIMEOUT_MS);
    const machineName = ping.machine?.name?.trim() || null;
    if (machineName !== null && machineName !== machine.machineName) {
      await settings.updateAdditionalMachine(machine.id, { machineName });
    }
    return {
      ok: ping.daemon.reachable,
      machineName,
      detail: ping.daemon.reachable
        ? `Connected to ${machineName ?? displayName(machine)}; Paseo daemon ${ping.daemon.version ?? "version unknown"}.`
        : `The bridge on ${machineName ?? displayName(machine)} answered, but its Paseo daemon is unreachable.`,
    };
  } catch (error) {
    return { ok: false, machineName: null, detail: error instanceof Error ? error.message : String(error) };
  }
}

function looksResolved(value: unknown): value is ResolveResponse {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ResolveResponse>;
  return (
    candidate.pr !== undefined &&
    candidate.project !== undefined &&
    Array.isArray(candidate.candidates) &&
    Array.isArray(candidate.providers)
  );
}

export async function resolveOnMachine(
  machine: SavedMachine,
  request: ResolveRequest,
  timeoutMs = RESOLVE_ROUTE_TIMEOUT_MS,
): Promise<ResolveRoute> {
  const route: ResolveRoute = {
    routeId: machine.id,
    routeLabel: displayName(machine),
    bridgeAuthority: new URL(machine.bridgeUrl).host,
    resolved: null,
    error: null,
  };
  try {
    const deadline = Date.now() + timeoutMs;
    const ping = await checkedPing(machine, deadline);
    const machineName = ping.machine?.name?.trim() || "";
    if (machineName && machineName !== machine.machineName) {
      await settings.updateAdditionalMachine(machine.id, { machineName });
      if (!machine.label.trim()) route.routeLabel = machineName;
    }
    const json = await fetchJson(
      machine,
      "/v1/resolve?local=1",
      {
        method: "POST",
        body: JSON.stringify(request),
      },
      remainingMs(deadline),
    );
    if (!looksResolved(json)) throw new Error(`${displayName(machine)} returned an invalid resolve response.`);
    // A primary machine never imports another primary's routes. The explicit
    // local-only request prevents loops; deleting defensively also handles a
    // bridge that does not understand the query yet.
    const { routes: _nested, ...local } = json;
    route.resolved = local;
  } catch (error) {
    route.error =
      error instanceof BridgeError
        ? error.toBody().error
        : {
            code: "bridge_unreachable",
            message: error instanceof Error ? error.message : String(error),
          };
  }
  return route;
}

export async function sendToMachine(
  machine: SavedMachine,
  request: SendRequest,
  timeoutMs = SEND_ROUTE_TIMEOUT_MS,
): Promise<SendResponse> {
  const deadline = Date.now() + timeoutMs;
  await checkedPing(machine, deadline);
  const target = { ...request.target };
  delete target.routeId;
  const json = await fetchJson(
    machine,
    "/v1/send?local=1",
    {
      method: "POST",
      body: JSON.stringify({ ...request, target }),
    },
    remainingMs(deadline),
  );
  if (json === null || typeof json !== "object" || (json as Partial<SendResponse>).ok !== true) {
    throw new BridgeError("daemon_unreachable", `${displayName(machine)} returned an invalid send response.`);
  }
  return json as SendResponse;
}

export async function machineById(id: string): Promise<SavedMachine | null> {
  return (await settings.read()).additionalMachines.find((machine) => machine.id === id) ?? null;
}
