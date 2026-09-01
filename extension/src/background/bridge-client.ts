/**
 * The only place in the extension that speaks HTTP to the bridge, and the only
 * place the bearer token is read. Implements the client half of CONTRACT.md v1.
 */

import {
  CONTRACT_VERSION,
  type PingResponse,
  type ResolveRequest,
  type ResolveResponse,
  type SendRequest,
  type SendResponse,
} from "../shared/contract";
import type { FailurePayload, Result } from "../shared/messages";
import { readSettings } from "./settings";

const PING_TIMEOUT_MS = 4000;
const RESOLVE_TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 60000;

function fail(
  code: string,
  message: string,
  extra?: { hint?: string; status?: number },
): { ok: false; error: FailurePayload } {
  return { ok: false, error: { code, message, ...extra } };
}

/**
 * Turn a Response into either its parsed body or a FailurePayload carrying the
 * bridge's own `code`/`message`/`hint` so the UI can be specific.
 */
async function readResponse<T>(res: Response): Promise<Result<T>> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const body = parsed as { error?: { code?: string; message?: string; hint?: string } } | null;
    const err = body?.error;
    if (err?.code) {
      return fail(err.code, err.message ?? `Bridge returned ${res.status}.`, {
        hint: err.hint,
        status: res.status,
      });
    }
    // A non-conforming error body. Still map the well-known statuses so the user
    // gets a real sentence instead of a number.
    const byStatus: Record<number, string> = {
      401: "unauthorized",
      403: "forbidden_host",
      404: "pr_not_found",
      413: "payload_too_large",
      429: "rate_limited",
      500: "internal",
      502: "agent_create_failed",
      503: "daemon_unreachable",
    };
    const code = byStatus[res.status] ?? "bad_response";
    return fail(
      code,
      `Bridge returned HTTP ${res.status} without a contract error body.`,
      { status: res.status },
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    return fail("bad_response", "Bridge returned a body that wasn't a JSON object.", {
      status: res.status,
    });
  }
  return { ok: true, data: parsed as T };
}

async function request<T>(
  path: string,
  init: {
    method: "GET" | "POST";
    body?: unknown;
    /** "required" fails locally without a token; "optional" just omits the header. */
    auth: "required" | "optional" | "none";
    timeoutMs: number;
  },
): Promise<Result<T>> {
  const settings = await readSettings();

  if (init.auth === "required" && !settings.token) {
    return fail(
      "not_configured",
      "No pairing token is stored for the Paseo bridge.",
    );
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth !== "none" && settings.token) {
    headers["Authorization"] = `Bearer ${settings.token}`;
  }

  let url: string;
  try {
    url = `${settings.bridgeUrl}${path}`;
    // Validate early so a typo'd bridge URL is a clear message, not a TypeError.
    new URL(url);
  } catch {
    return fail(
      "not_configured",
      `"${settings.bridgeUrl}" is not a valid bridge URL.`,
    );
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // No cookies, ever: the bridge does not send
      // Access-Control-Allow-Credentials and must not be reachable ambiently.
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return fail(
        "bridge_unreachable",
        `The bridge at ${settings.bridgeUrl} didn't answer within ${Math.round(
          init.timeoutMs / 1000,
        )}s.`,
      );
    }
    return fail(
      "bridge_unreachable",
      `Couldn't connect to the bridge at ${settings.bridgeUrl}.`,
    );
  }

  return readResponse<T>(res);
}

/* -------------------------------------------------------------------------- */
/* GET /v1/ping — auth is OPTIONAL                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ping. Auth is optional per CONTRACT.md, and the three outcomes are all
 * meaningful:
 *
 *   - no token sent          -> 200, paired: false, providers: []
 *   - valid token sent       -> 200, paired: true,  providers: [...]
 *   - invalid token sent     -> 401 unauthorized
 *
 * `authenticated: false` forces the unauthenticated form even when a token is
 * stored, which is how the options page separates "bridge down" from "bad token".
 *
 * This function does NOT enforce the contract version — callers that are about
 * to mutate go through `requireCompatibleContract()`, and the options page wants
 * to *report* a mismatch rather than be blocked by it.
 */
export function ping(
  { authenticated = true }: { authenticated?: boolean } = {},
): Promise<Result<PingResponse>> {
  return request<PingResponse>("/v1/ping", {
    method: "GET",
    auth: authenticated ? "optional" : "none",
    timeoutMs: PING_TIMEOUT_MS,
  });
}

/* -------------------------------------------------------------------------- */
/* contract version gate                                                      */
/* -------------------------------------------------------------------------- */

function mismatchFailure(theirs: number) {
  return fail(
    "contract_mismatch",
    `The Paseo plugin speaks bridge contract v${theirs}; this extension was built for v${CONTRACT_VERSION}.`,
  );
}

/**
 * CONTRACT.md Clarifications, "`contract` mismatch": the extension compares
 * `contract` from /v1/ping against the value it was built for, and on mismatch
 * MUST refuse to send and tell the user to update, rather than guessing.
 *
 * Enforced before /v1/resolve as well as before /v1/send, so a stale plugin is
 * caught before the user has typed anything — not only after they hit Send.
 *
 * Deliberately NOT cached. An earlier draft memoised the result for 60 s, which
 * meant a plugin updated while the composer was open could still be sent to.
 * "Refuse to send" is a guarantee, and one loopback round trip is far cheaper
 * than the resolve or send it guards.
 */
export async function requireCompatibleContract(): Promise<Result<number>> {
  const res = await ping();
  if (!res.ok) return res; // bridge_unreachable / unauthorized / ... surface as-is

  return res.data.contract === CONTRACT_VERSION
    ? { ok: true, data: res.data.contract }
    : mismatchFailure(res.data.contract);
}

/* -------------------------------------------------------------------------- */
/* mutating / PR-scoped endpoints                                             */
/* -------------------------------------------------------------------------- */

export function resolve(body: ResolveRequest): Promise<Result<ResolveResponse>> {
  return request<ResolveResponse>("/v1/resolve", {
    method: "POST",
    body,
    auth: "required",
    timeoutMs: RESOLVE_TIMEOUT_MS,
  });
}

export function send(body: SendRequest): Promise<Result<SendResponse>> {
  return request<SendResponse>("/v1/send", {
    method: "POST",
    body,
    auth: "required",
    timeoutMs: SEND_TIMEOUT_MS,
  });
}
