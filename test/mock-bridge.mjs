#!/usr/bin/env node
/**
 * Mock Paseo bridge — a faithful implementation of CONTRACT.md v1.
 *
 * Two jobs:
 *   1. Let the extension's e2e suite drive every success and failure path
 *      without the real plugin.
 *   2. Double as a contract-conformance reference. If this file and CONTRACT.md
 *      disagree, THIS FILE IS WRONG. Fix it here; never "fix" the contract.
 *
 * Implemented exactly as specified:
 *   - bind 127.0.0.1 only
 *   - bearer token required on /v1/resolve and /v1/send; OPTIONAL on GET /v1/ping
 *     (absent -> paired:false + providers:[] + modes:[]; valid -> paired:true +
 *      providers + modes; invalid -> 401 unauthorized)
 *   - flat, provider-tagged `modes` on /v1/ping and /v1/resolve, plus
 *     `resolvedModeId` on /v1/resolve; optional `modeId` on /v1/send
 *   - Origin must be absent or start with chrome-extension:// (preflight AND real)
 *   - Host must be 127.0.0.1:<port> or localhost:<port>
 *   - CORS echo without Access-Control-Allow-Credentials, with Vary: Origin
 *   - 64 KiB body cap -> 413 payload_too_large
 *   - 60 requests / 10 s per origin -> 429 rate_limited (keyed on Origin when
 *     present, else the remote address, so a curl flood can't eat the
 *     extension's budget)
 *
 * CLI:
 *   node test/mock-bridge.mjs [--port 7788] [--token abc] [--fail <code>]
 *                             [--dry-run] [--daemon-down] [--contract N] [--no-gh]
 *                             [--quiet]
 *
 * Env: MOCK_PORT, MOCK_TOKEN, MOCK_FAIL, SEND_TO_PASEO_DRY_RUN=1
 *
 * Test-only control surface (refused if an Origin header is present, so a
 * browser can never reach it):
 *   POST /__test/fail   {"code": "project_not_found" | null, "once": true?}
 *   POST /__test/config {"contract": 2?, "dryRun": true?, "daemonDown": true?,
 *                        "noGh": true?}
 *   POST /__test/reset
 *   GET  /__test/log    -> [{ method, path, origin, hasAuth, authState, body }]
 */

import { createServer } from "node:http";

/* -------------------------------------------------------------------------- */
/* config                                                                     */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

export const DEFAULT_TOKEN = "mock-token-2f8c1d9ab3e74c05";

const CONFIG = {
  port: Number(arg("port", process.env.MOCK_PORT ?? 7788)),
  token: arg("token", process.env.MOCK_TOKEN ?? DEFAULT_TOKEN),
  dryRun: flag("dry-run") || process.env.SEND_TO_PASEO_DRY_RUN === "1",
  daemonDown: flag("daemon-down"),
  quiet: flag("quiet"),
  // Overridable so the extension's contract-mismatch refusal can be exercised.
  contract: Number(arg("contract", process.env.MOCK_CONTRACT ?? 1)),
  /**
   * Reproduces the real bridge with `gh` unavailable: it deliberately never
   * guesses, so `pr.headBranch` comes back as "" rather than a plausible name.
   * The extension must treat "" as UNKNOWN, not as "a different branch".
   */
  noGh: flag("no-gh"),
};

const MAX_BODY = 64 * 1024; // CONTRACT.md: 64 KiB
const RATE_WINDOW_MS = 10_000;
// CONTRACT.md item 6: raised from 30 to 60 because the extension's uncached
// contract-mismatch gate costs 4 requests per completed send. GET /v1/ping stays
// counted rather than exempt, to keep the bound total.
const RATE_MAX = 60;

const SERVER_ID = "srv_Ab3xY9pQ2mNt";
const DAEMON_VERSION = "0.7.0";
const PLUGIN_VERSION = "0.1.0";

/* -------------------------------------------------------------------------- */
/* error table — one entry per row of CONTRACT.md's error-code table           */
/* -------------------------------------------------------------------------- */

const ERRORS = {
  unauthorized: [401, "Missing or invalid bearer token.", "Copy the pairing token from the Paseo plugin surface."],
  forbidden_origin: [403, "Requests from web page origins are refused.", undefined],
  forbidden_host: [403, "Unexpected Host header.", "Use http://127.0.0.1:PORT or http://localhost:PORT."],
  bad_request: [400, "Request body failed validation.", undefined],
  payload_too_large: [413, "Request body exceeds 64 KiB.", undefined],
  rate_limited: [429, "Too many requests.", "Max 60 requests per 10 seconds."],
  project_not_found: [
    404,
    'acmegizmos/gizmo-poc is not a registered Paseo project.',
    "Add the repository as a project in Paseo, then retry.",
  ],
  pr_not_found: [404, "PR #942 was not found on github/acmegizmos/gizmo-poc.", undefined],
  // CONTRACT.md Clarifications: `message` is plain prose with no markup, and
  // `hint` carries shell commands BARE. Presentation is the extension's job.
  forge_unauthenticated: [
    502,
    "The GitHub CLI is not authenticated.",
    "Run: gh auth login",
  ],
  workspace_create_failed: [
    502,
    "checkout-pr failed: fatal: could not read from remote repository.",
    undefined,
  ],
  agent_create_failed: [502, "Daemon refused: no provider configured for claude/claude-opus-5.", undefined],
  daemon_unreachable: [503, "Paseo daemon unreachable.", "Start the Paseo app and retry."],
  internal: [500, "Unexpected error.", undefined],
};

/* -------------------------------------------------------------------------- */
/* mutable test state                                                         */
/* -------------------------------------------------------------------------- */

const state = {
  forcedFail: arg("fail", process.env.MOCK_FAIL ?? null),
  forcedFailOnce: false,
  paired: false,
  log: [],
  rate: new Map(),
  agentSeq: 0,
};

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PRS = {
  942: {
    number: 942,
    title:
      "GIZ-1133: Legacy tally engine retirement #3 - Make the inventory-audit rule widget-backed",
    headBranch: "giz-1133-widget-backed-inventory-audit-rule",
    baseBranch: "graphite-base/942",
    state: "OPEN",
  },
  948: {
    number: 948,
    title: "GIZ-1132: Extract widget status calculator seam",
    headBranch: "giz-1132-extract-widget-status-seam",
    baseBranch: "graphite-base/948",
    state: "OPEN",
  },
};

function prFor(number) {
  if (CONFIG.noGh) {
    // Byte-for-byte what plugin/gh.server produces on an outage: no title, no
    // branches, nothing invented.
    return { number, title: `PR #${number}`, headBranch: "", baseBranch: "", state: "UNKNOWN" };
  }
  return (
    PRS[number] ?? {
      number,
      title: `Synthetic mock PR #${number}`,
      headBranch: `mock/pr-${number}`,
      baseBranch: "main",
      state: "OPEN",
    }
  );
}

/**
 * Candidate list. PR 942 has an exact workspace match. Any PR with stack
 * siblings also gets a rank-2 "stack" workspace, so a PR that is not 942 but is
 * in a stack defaults to that — the one-workspace-per-stack case. A PR with
 * neither falls through to the synthetic "create" entry.
 */
function candidatesFor(number, stackPrNumbers) {
  const pr = prFor(number);
  const out = [];

  // Without gh there is no head branch to compare against, so nothing can be
  // ranked "exact" — but the workspaces themselves still report real branches,
  // exactly as measured against the live daemon (VERIFICATION §16.5).
  if (number === 942 && !CONFIG.noGh) {
    out.push({
      kind: "existing",
      workspaceId: "wks_4d1a8b7c2e0f9351",
      label: "brawny-dodo",
      branch: pr.headBranch,
      cwd: "~/.paseo/worktrees/pj4k2wxb/brawny-dodo",
      isolation: "worktree",
      rank: 1,
      reason: "exact",
      agentCount: 2,
    });
  }

  const stackPr = (stackPrNumbers ?? [])[0];
  if (stackPr !== undefined && !CONFIG.noGh) {
    out.push({
      kind: "existing",
      workspaceId: "wks_7b3e5c9a1d8f6042",
      label: "candid-otter",
      branch: `giz-1132-stack-sibling-${stackPr}`,
      cwd: "~/.paseo/worktrees/pj4k2wxb/candid-otter",
      isolation: "worktree",
      rank: 2,
      reason: "stack",
      stackPrNumber: stackPr,
      agentCount: 0,
    });
  }

  out.push({
    kind: "existing",
    workspaceId: "wks_9c8b2a6e3f5d07b1",
    label: "gizmo-poc (main checkout)",
    branch: "main",
    cwd: "~/Projects/gizmo-poc",
    isolation: "none",
    rank: 3,
    reason: "project",
    agentCount: 1,
  });

  out.push({
    kind: "create",
    label: `Create worktree for PR #${number}`,
    branch: pr.headBranch,
    rank: 4,
    reason: "create",
  });

  // CONTRACT.md: sorted ascending by rank, always contains the create entry.
  return out.sort((a, b) => a.rank - b.rank);
}

const PROVIDERS = [
  { id: "claude/claude-opus-5", label: "Opus 5", isDefault: true },
  { id: "claude/claude-sonnet-5", label: "Sonnet 5", isDefault: false },
  { id: "codex/gpt-5-codex", label: "GPT-5 Codex", isDefault: false },
];

/**
 * Permission modes, flat and provider-tagged, exactly as CONTRACT.md specifies.
 *
 * Transcribed from what the real daemon advertises (measured 2026-09-01 via
 * `providers.snapshot()`): mode ids are PER PROVIDER, `isDefault` marks each
 * provider's own default, and the unattended mode is present with
 * `colorTier: "dangerous"` — listed, never hidden.
 */
const MODES = [
  { provider: "claude", id: "plan", label: "Plan Mode", isDefault: false, colorTier: "planning" },
  { provider: "claude", id: "default", label: "Always Ask", isDefault: false, colorTier: "safe" },
  {
    provider: "claude",
    id: "acceptEdits",
    label: "Accept File Edits",
    isDefault: false,
    colorTier: "moderate",
  },
  { provider: "claude", id: "auto", label: "Auto mode", isDefault: true, colorTier: "moderate" },
  {
    provider: "claude",
    id: "bypassPermissions",
    label: "Bypass",
    isDefault: false,
    isUnattended: true,
    colorTier: "dangerous",
  },
  {
    provider: "codex",
    id: "auto",
    label: "Default Permissions",
    isDefault: false,
    colorTier: "moderate",
  },
  {
    provider: "codex",
    id: "auto-review",
    label: "Auto-review",
    isDefault: true,
    colorTier: "moderate",
  },
  {
    provider: "codex",
    id: "full-access",
    label: "Full Access",
    isDefault: false,
    isUnattended: true,
    colorTier: "dangerous",
  },
];

/** The mode the bridge reports as resolved for the default provider. */
const RESOLVED_MODE_ID = "auto";

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function corsHeaders(origin) {
  const h = { Vary: "Origin" };
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    h["Access-Control-Max-Age"] = "600";
    // Deliberately NO Access-Control-Allow-Credentials.
  }
  return h;
}

function sendJson(res, status, body, origin) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...corsHeaders(origin),
  });
  res.end(payload);
}

function sendError(res, code, origin, overrides = {}) {
  const spec = ERRORS[code] ?? [500, `Unknown mock error code "${code}".`, undefined];
  const [status, message, hint] = spec;
  const error = { code, message: overrides.message ?? message };
  const finalHint = overrides.hint ?? hint;
  if (finalHint) error.hint = finalHint;
  sendJson(res, overrides.status ?? status, { error }, origin);
}

function rateOk(key) {
  const now = Date.now();
  const hits = (state.rate.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  state.rate.set(key, hits);
  return hits.length <= RATE_MAX;
}

function readBody(req, res, origin) {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      sendError(res, "payload_too_large", origin);
      resolve(null);
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        sendError(res, "payload_too_large", origin);
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.headersSent) return resolve(null);
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        sendError(res, "bad_request", origin, { message: "Body is not valid JSON." });
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function validatePrRef(body) {
  if (body.forge !== "github") return 'forge must be "github"';
  if (!isNonEmptyString(body.owner)) return "owner is required";
  if (!isNonEmptyString(body.repo)) return "repo is required";
  if (!Number.isInteger(body.number) || body.number <= 0) return "number must be a positive integer";
  return null;
}

function log(...args) {
  if (!CONFIG.quiet) console.log("[mock-bridge]", ...args);
}

/* -------------------------------------------------------------------------- */
/* routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * GET /v1/ping — auth is OPTIONAL (CONTRACT.md "Token validation on ping").
 *   authState "none"  -> 200, paired:false, providers:[]
 *   authState "valid" -> 200, paired:true,  providers:[...]
 *   authState "bad"   -> handled earlier as 401 unauthorized
 */
function handlePing(res, origin, authState) {
  const authed = authState === "valid";
  sendJson(
    res,
    200,
    {
      ok: true,
      name: "send-to-paseo",
      version: PLUGIN_VERSION,
      contract: CONFIG.contract,
      daemon: CONFIG.daemonDown
        ? { reachable: false }
        : { reachable: true, version: DAEMON_VERSION, serverId: SERVER_ID },
      paired: authed,
      providers: authed ? PROVIDERS : [],
      modes: authed ? MODES : [],
    },
    origin,
  );
}

function handleResolve(res, origin, body) {
  const bad = validatePrRef(body);
  if (bad) return sendError(res, "bad_request", origin, { message: bad });
  if (body.stackPrNumbers !== undefined) {
    if (!Array.isArray(body.stackPrNumbers) || body.stackPrNumbers.some((n) => !Number.isInteger(n))) {
      return sendError(res, "bad_request", origin, {
        message: "stackPrNumbers must be an array of integers",
      });
    }
    // CONTRACT.md: the bridge MUST tolerate a self-inclusive list and filter it
    // rather than rejecting — "a scrape of a third-party page is not something
    // to be strict about". The extension filters too; this is the safety net.
    body.stackPrNumbers = body.stackPrNumbers.filter((n) => n !== body.number);
  }

  const pr = prFor(body.number);
  const candidates = candidatesFor(body.number, body.stackPrNumbers);
  const exactIndex = candidates.findIndex((c) => c.reason === "exact");
  const stackIndex = candidates.findIndex((c) => c.reason === "stack");
  const createIndex = candidates.findIndex((c) => c.reason === "create");

  sendJson(
    res,
    200,
    {
      pr: {
        ...pr,
        url: `https://github.com/${body.owner}/${body.repo}/pull/${body.number}`,
      },
      project: {
        projectId: `remote:github.com/${body.owner}/${body.repo}`,
        name: `${body.owner}/${body.repo}`,
        path: "~/Projects/gizmo-poc",
      },
      candidates,
      // Exact branch match, else the nearest workspace in the same stack, else
      // the synthetic create option. Rank 3 is deliberately never a default.
      defaultCandidateIndex:
        exactIndex >= 0 ? exactIndex : stackIndex >= 0 ? stackIndex : createIndex,
      providers: PROVIDERS,
      modes: MODES,
      // The mode a send would actually use for the isDefault provider, after
      // the bridge's own chain. Null when it would omit the field entirely.
      resolvedModeId: RESOLVED_MODE_ID,
    },
    origin,
  );
}

function handleSend(res, origin, body) {
  const bad = validatePrRef(body);
  if (bad) return sendError(res, "bad_request", origin, { message: bad });

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  // CONTRACT.md Clarifications: measured in Unicode CODE POINTS, independent of
  // the 64 KiB byte cap (which readBody already enforced as payload_too_large).
  const promptCodePoints = [...prompt].length;
  if (promptCodePoints < 1) {
    return sendError(res, "bad_request", origin, { message: "prompt is required" });
  }
  if (promptCodePoints > 16000) {
    return sendError(res, "bad_request", origin, {
      message: `prompt is ${promptCodePoints} code points; the limit is 16000`,
    });
  }
  const target = body.target;
  if (!target || (target.kind !== "existing" && target.kind !== "create")) {
    return sendError(res, "bad_request", origin, {
      message: 'target must be {kind:"existing",workspaceId} or {kind:"create"}',
    });
  }
  if (target.kind === "existing" && !isNonEmptyString(target.workspaceId)) {
    return sendError(res, "bad_request", origin, {
      message: 'target.kind "existing" requires workspaceId',
    });
  }
  if (body.provider !== undefined && !isNonEmptyString(body.provider)) {
    return sendError(res, "bad_request", origin, { message: "provider must be a non-empty string" });
  }
  // Bounded exactly like `provider`. A modeId the provider does not advertise is
  // NOT a 400: the real bridge validates it against the provider's own modes and
  // falls back down its chain, so a stale id can never fail a send.
  if (body.modeId !== undefined && !isNonEmptyString(body.modeId)) {
    return sendError(res, "bad_request", origin, { message: "modeId must be a non-empty string" });
  }

  const pr = prFor(body.number);
  const created = target.kind === "create";
  const agentId = `agt_mock${String(++state.agentSeq).padStart(4, "0")}`;
  const workspaceId = created ? "wks_created0000mock" : target.workspaceId;
  const firstLine = prompt.split("\n")[0].slice(0, 60);

  sendJson(
    res,
    200,
    {
      ok: true,
      agentId,
      workspaceId,
      workspaceCreated: created,
      workspaceLabel: created ? "spry-lynx" : "brawny-dodo",
      branch: pr.headBranch,
      // CONTRACT.md "Deep link format": paseo://h/<serverId>/agent/<agentId>,
      // as produced by buildAgentDeepLink. The extension treats this as opaque.
      deepLink: `paseo://h/${SERVER_ID}/agent/${agentId}`,
      title: `PR #${body.number} · ${firstLine}`,
      // CONTRACT.md: always present, never omitted.
      dryRun: CONFIG.dryRun === true,
    },
    origin,
  );
}

/* -------------------------------------------------------------------------- */
/* test control surface                                                       */
/* -------------------------------------------------------------------------- */

async function handleControl(req, res, url, origin) {
  if (origin) {
    // Never reachable from a browser.
    res.writeHead(403, corsHeaders(origin));
    res.end();
    return;
  }
  if (url.pathname === "/__test/log" && req.method === "GET") {
    return sendJson(res, 200, state.log, null);
  }
  if (url.pathname === "/__test/fail" && req.method === "POST") {
    const body = (await readBody(req, res, null)) ?? {};
    state.forcedFail = body.code ?? null;
    state.forcedFailOnce = Boolean(body.once);
    return sendJson(res, 200, { forcedFail: state.forcedFail, once: state.forcedFailOnce }, null);
  }
  if (url.pathname === "/__test/config" && req.method === "POST") {
    const body = (await readBody(req, res, null)) ?? {};
    if (body.contract !== undefined) CONFIG.contract = Number(body.contract);
    if (body.dryRun !== undefined) CONFIG.dryRun = Boolean(body.dryRun);
    if (body.daemonDown !== undefined) CONFIG.daemonDown = Boolean(body.daemonDown);
    if (body.noGh !== undefined) CONFIG.noGh = Boolean(body.noGh);
    return sendJson(
      res,
      200,
      {
        contract: CONFIG.contract,
        dryRun: CONFIG.dryRun,
        daemonDown: CONFIG.daemonDown,
        noGh: CONFIG.noGh,
      },
      null,
    );
  }
  if (url.pathname === "/__test/reset" && req.method === "POST") {
    state.forcedFail = null;
    state.forcedFailOnce = false;
    state.log = [];
    state.rate.clear();
    state.paired = false;
    state.agentSeq = 0;
    CONFIG.contract = 1;
    CONFIG.dryRun = false;
    CONFIG.daemonDown = false;
    CONFIG.noGh = false;
    return sendJson(res, 200, { ok: true }, null);
  }
  res.writeHead(404).end();
}

/* -------------------------------------------------------------------------- */
/* server                                                                     */
/* -------------------------------------------------------------------------- */

export function createMockBridge(overrides = {}) {
  Object.assign(CONFIG, overrides);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const origin = req.headers.origin ?? null;
    const host = req.headers.host ?? "";

    if (url.pathname.startsWith("/__test/")) {
      return handleControl(req, res, url, origin);
    }

    /* 1. Host check (DNS-rebinding defence) --------------------------------- */
    const allowedHosts = [`127.0.0.1:${CONFIG.port}`, `localhost:${CONFIG.port}`];
    if (!allowedHosts.includes(host)) {
      log("reject forbidden_host", host);
      return sendError(res, "forbidden_host", origin);
    }

    /* 2. Origin check — preflight AND real request ------------------------- */
    if (origin !== null && !origin.startsWith("chrome-extension://")) {
      log("reject forbidden_origin", origin);
      return sendError(res, "forbidden_origin", origin);
    }

    /* 3. Preflight --------------------------------------------------------- */
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      return res.end();
    }

    /* 4. Rate limit ---------------------------------------------------------
       CONTRACT.md Clarifications: keyed on the Origin header when present, and
       on the remote address otherwise, so a curl flood can't consume the
       extension's budget. 60 requests / 10 s (item 6). */
    const rateKey = origin ?? `addr:${req.socket.remoteAddress ?? "unknown"}`;
    if (!rateOk(rateKey)) {
      return sendError(res, "rate_limited", origin);
    }

    // Auth is OPTIONAL on GET /v1/ping and REQUIRED everywhere else.
    const authOptional = url.pathname === "/v1/ping" && req.method === "GET";

    /* 5. Body (with the 64 KiB cap) ---------------------------------------- */
    let body = {};
    if (req.method === "POST") {
      const parsed = await readBody(req, res, origin);
      if (parsed === null) return; // response already sent
      body = parsed;
    }

    /* 6. Auth -------------------------------------------------------------- */
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    /** "none" | "valid" | "bad" */
    const authState = !auth ? "none" : presented === CONFIG.token ? "valid" : "bad";

    // A present-but-wrong token is 401 on EVERY endpoint, ping included.
    // A missing token is 401 only where auth is required.
    if (authState === "bad" || (authState === "none" && !authOptional)) {
      state.log.push({
        method: req.method,
        path: url.pathname,
        origin,
        hasAuth: Boolean(auth),
        authState,
        body,
        outcome: "unauthorized",
      });
      return sendError(res, "unauthorized", origin);
    }
    if (authState === "valid") state.paired = true;

    state.log.push({
      method: req.method,
      path: url.pathname,
      origin,
      hasAuth: Boolean(auth),
      authState,
      body,
    });
    log(req.method, url.pathname, origin ?? "(no origin)");

    /* 7. Injected failure -------------------------------------------------- */
    const injected = url.searchParams.get("fail") ?? state.forcedFail;
    if (injected && url.pathname !== "/v1/ping") {
      if (state.forcedFailOnce) {
        state.forcedFail = null;
        state.forcedFailOnce = false;
      }
      log("injecting failure", injected);
      return sendError(res, injected, origin);
    }

    /* 8. Route ------------------------------------------------------------- */
    if (url.pathname === "/v1/ping" && req.method === "GET") {
      return handlePing(res, origin, authState);
    }
    if (url.pathname === "/v1/resolve" && req.method === "POST") {
      return handleResolve(res, origin, body);
    }
    if (url.pathname === "/v1/send" && req.method === "POST") {
      return handleSend(res, origin, body);
    }

    sendError(res, "bad_request", origin, {
      status: 404,
      message: `No route for ${req.method} ${url.pathname}.`,
    });
  });

  return {
    server,
    config: CONFIG,
    state,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        // 127.0.0.1 only. Never 0.0.0.0.
        server.listen(CONFIG.port, "127.0.0.1", () => resolve(CONFIG.port));
      });
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/* Run directly: node test/mock-bridge.mjs */
if (import.meta.url === `file://${process.argv[1]}`) {
  const bridge = createMockBridge();
  await bridge.listen();
  console.log(
    `[mock-bridge] listening on http://127.0.0.1:${CONFIG.port}\n` +
      `              token: ${CONFIG.token}\n` +
      `              dryRun: ${CONFIG.dryRun}  daemonDown: ${CONFIG.daemonDown}  fail: ${state.forcedFail ?? "none"}`,
  );
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      void bridge.close().then(() => process.exit(0));
    });
  }
}
