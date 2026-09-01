import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * Wire contract for the local bridge, shared by the HTTP endpoints and the
 * Paseo surface. `CONTRACT.md` at the repository root is frozen; these schemas
 * are its executable form, so change both or neither.
 */

/** Advertised in `GET /v1/ping`. Keep in step with `package.json`. */
export const PLUGIN_NAME = "send-to-paseo";
export const PLUGIN_VERSION = "0.1.0";
/** Bumped only for an incompatible bridge API; the paths stay `/v1`. */
export const CONTRACT_VERSION = 1;

export const DEFAULT_PORT = 7788;
/** 64 KiB, per CONTRACT.md. */
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * Raised from 30: the extension re-pings before every resolve and send for its
 * `contract`-mismatch gate, deliberately uncached, which costs 4 requests per
 * completed send. `GET /v1/ping` stays counted rather than exempt — the limit is
 * defence-in-depth on an endpoint that is already loopback-only and token-gated,
 * so keeping the total bounded matters more than carving out one path.
 */
export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 10_000;
export const MAX_PROMPT_CHARS = 16_000;
/** `PR #942 · ` plus this many characters of the user's first line. */
export const MAX_TITLE_SUMMARY_CHARS = 60;

export const LABEL_PR = "send-to-paseo/pr";
export const LABEL_ORIGIN = "send-to-paseo/origin";

// ---------------------------------------------------------------------------
// HTTP request payloads
// ---------------------------------------------------------------------------

/** GitHub is the only forge in v1; the field exists so adding one is additive. */
export const ForgeSchema = z.literal("github");
export type Forge = z.infer<typeof ForgeSchema>;

/** Conservative on purpose: these become `gh` argv and a project id. */
const OwnerRepoSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "must be a GitHub owner/repo segment");

export const PrRefSchema = z.object({
  forge: ForgeSchema,
  owner: OwnerRepoSchema,
  repo: OwnerRepoSchema,
  number: z.number().int().positive().max(10_000_000),
});
export type PrRef = z.infer<typeof PrRefSchema>;

export const ResolveRequestSchema = PrRefSchema.extend({
  /** Sibling PRs in the Graphite stack, excluding this one. Best-effort. */
  stackPrNumbers: z.array(z.number().int().positive().max(10_000_000)).max(64).optional(),
});
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

export const SendTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), workspaceId: z.string().min(1).max(400) }),
  z.object({ kind: z.literal("create") }),
]);
export type SendTarget = z.infer<typeof SendTargetSchema>;

export const SendRequestSchema = PrRefSchema.extend({
  /**
   * Length is checked after trimming so the 400 carries a useful sentence
   * rather than a raw Zod path.
   */
  prompt: z.string(),
  target: SendTargetSchema,
  provider: z.string().min(1).max(200).optional(),
  /**
   * Permission mode for the new agent, e.g. `auto` or `bypassPermissions`.
   * Bounded exactly like `provider`. Mode ids are **per provider**, so this is
   * only meaningful together with the provider the send resolves to; the bridge
   * validates it against that provider's advertised modes and falls back rather
   * than failing the send.
   */
  modeId: z.string().min(1).max(200).optional(),
  pageUrl: z.string().max(2000).optional(),
});
export type SendRequest = z.infer<typeof SendRequestSchema>;

// ---------------------------------------------------------------------------
// HTTP response payloads
// ---------------------------------------------------------------------------

export interface ErrorBody {
  error: { code: string; message: string; hint?: string };
}

/** Every documented error code in CONTRACT.md, with its HTTP status. */
export const ERROR_STATUS = {
  unauthorized: 401,
  forbidden_origin: 403,
  forbidden_host: 403,
  bad_request: 400,
  payload_too_large: 413,
  rate_limited: 429,
  project_not_found: 404,
  pr_not_found: 404,
  forge_unauthenticated: 502,
  workspace_create_failed: 502,
  agent_create_failed: 502,
  daemon_unreachable: 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * A failure the bridge is willing to describe to the caller. Anything else
 * becomes `internal` with a generic message, so daemon internals and paths
 * never leak to a browser extension.
 */
export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (hint !== undefined) this.hint = hint;
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint === undefined ? {} : { hint: this.hint }),
      },
    };
  }
}

export interface PingResponse {
  ok: true;
  name: string;
  version: string;
  contract: number;
  daemon: { reachable: boolean; version: string | null; serverId: string | null };
  /** True when *this* request carried a valid bearer token. */
  paired: boolean;
  /** Populated only for an authenticated ping; `[]` otherwise. */
  providers: ProviderOption[];
  /** Same rule as `providers`: authenticated only. Flat, provider-tagged. */
  modes: ModeOption[];
}

export interface PrPayload {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  url: string;
}

export interface ProjectPayload {
  projectId: string;
  name: string;
  path: string;
}

export type CandidateReason = "exact" | "stack" | "project" | "create";

export interface ExistingCandidate {
  kind: "existing";
  workspaceId: string;
  label: string;
  branch: string | null;
  cwd: string;
  isolation: string;
  rank: 1 | 2 | 3;
  reason: "exact" | "stack" | "project";
  agentCount: number;
  /** Present only on `reason: "stack"`. */
  stackPrNumber?: number;
}

export interface CreateCandidate {
  kind: "create";
  label: string;
  branch: string;
  rank: 4;
  reason: "create";
}

export type Candidate = ExistingCandidate | CreateCandidate;

export interface ProviderOption {
  id: string;
  label: string;
  isDefault: boolean;
}

/**
 * One selectable permission mode, flattened across providers exactly like
 * `providers[]`.
 *
 * Mode ids are **per provider** — `claude` has `plan`/`default`/`acceptEdits`/
 * `auto`/`bypassPermissions`, `codex` has `auto`/`auto-review`/`full-access` —
 * so every entry carries the provider it belongs to and a consumer must filter
 * by the provider it is actually going to send.
 */
export interface ModeOption {
  /** Bare provider id (`claude`), not the `provider/model` pair. */
  provider: string;
  id: string;
  label: string;
  /** True for this provider's own default mode, not for the whole list. */
  isDefault: boolean;
  /**
   * The mode runs without asking for permission (Claude's "Bypass", Codex's
   * "Full Access"). Present so a UI can mark it; deliberately NOT a reason to
   * hide it.
   */
  isUnattended?: boolean;
  /** Paseo's own visual tier: `safe`/`moderate`/`planning`/`dangerous`. */
  colorTier?: string;
}

export interface ResolveResponse {
  pr: PrPayload;
  project: ProjectPayload;
  candidates: Candidate[];
  defaultCandidateIndex: number;
  providers: ProviderOption[];
  /** Every mode of every ready provider, tagged with its provider. */
  modes: ModeOption[];
  /**
   * The mode a send would actually use right now for the provider flagged
   * `isDefault`, after the whole resolution chain (profile -> plugin setting ->
   * provider default). Null when nothing resolves and the field would be
   * omitted from `agents.create` entirely.
   */
  resolvedModeId: string | null;
}

export interface SendResponse {
  ok: true;
  agentId: string;
  workspaceId: string;
  workspaceCreated: boolean;
  workspaceLabel: string;
  /**
   * The branch actually checked out, which is not always `pr.headBranch`: when a
   * local branch of that name already exists, Paseo's `checkout-pr` creates a
   * uniquely suffixed local branch tracking `origin/<pr.headBranch>`.
   */
  branch: string | null;
  deepLink: string;
  title: string;
  /** Always present. True only under `SEND_TO_PASEO_DRY_RUN=1`. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Surface RPC contracts
// ---------------------------------------------------------------------------

export const RecentSendSchema = z.object({
  id: z.string(),
  at: z.string(),
  prLabel: z.string(),
  prUrl: z.string(),
  workspaceLabel: z.string(),
  branch: z.string().nullable(),
  agentId: z.string().nullable(),
  deepLink: z.string().nullable(),
  title: z.string(),
  provider: z.string(),
  /**
   * Defaulted rather than required: history rows written before modes existed
   * must keep validating, or `load()` would discard the file — and with it the
   * user's pairing token.
   */
  modeId: z.string().nullable().default(null),
  workspaceCreated: z.boolean(),
  dryRun: z.boolean(),
  outcome: z.enum(["ok", "failed"]),
  error: z.string().nullable(),
});
export type RecentSend = z.infer<typeof RecentSendSchema>;

export const BridgeStatusSchema = z.object({
  state: z.enum(["starting", "running", "failed", "stopped"]),
  /** The port actually bound, or the configured port when not running. */
  port: z.number(),
  configuredPort: z.number(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  lastRequestAt: z.string().nullable(),
  requestCount: z.number(),
  paired: z.boolean(),
  dryRun: z.boolean(),
  /** Never the token itself, so the surface can render before a reveal. */
  tokenPreview: z.string(),
  defaultProvider: z.string().nullable(),
  /** Paseo agent profile the plugin follows, or null for "no profile". */
  defaultProfileId: z.string().nullable(),
  /** Explicit permission-mode override, or null to follow the chain. */
  defaultModeId: z.string().nullable(),
  daemon: z.object({
    reachable: z.boolean(),
    version: z.string().nullable(),
    serverId: z.string().nullable(),
  }),
});
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;

export const ProviderOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
});

export const ModeOptionSchema = z.object({
  provider: z.string(),
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  isUnattended: z.boolean().optional(),
  colorTier: z.string().optional(),
});

/**
 * One of the user's saved Paseo agent profiles (`daemon.agentProfiles`).
 *
 * There is no way to reference a profile by id at agent-create time — applying
 * one is a field-by-field copy — so the plugin stores the id and re-reads the
 * fields on every send. Change the profile in Paseo and the next send follows.
 */
export const AgentProfileOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Bare provider id (`claude`). */
  provider: z.string(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
});
export type AgentProfileOption = z.infer<typeof AgentProfileOptionSchema>;

/**
 * One external command the plugin uses. Surfaced so the most discoverable place
 * in the product — the plugin's own settings screen — can answer "why is there
 * no PR title?" without anyone reading a log.
 */
export const DependencyReportSchema = z.object({
  name: z.string(),
  required: z.boolean(),
  state: z.enum(["ok", "degraded", "missing"]),
  path: z.string().nullable(),
  version: z.string().nullable(),
  detail: z.string(),
  hint: z.string(),
});
export type DependencyReportPayload = z.infer<typeof DependencyReportSchema>;

export const getStatus = defineRpc({
  name: "send-to-paseo.status",
  input: z.object({}),
  output: z.object({
    status: BridgeStatusSchema,
    providers: z.array(ProviderOptionSchema),
    providersError: z.string().nullable(),
    modes: z.array(ModeOptionSchema),
    profiles: z.array(AgentProfileOptionSchema),
    profilesError: z.string().nullable(),
    recentSends: z.array(RecentSendSchema),
    dependencies: z.array(DependencyReportSchema),
  }),
});

export const revealToken = defineRpc({
  name: "send-to-paseo.token.reveal",
  input: z.object({}),
  output: z.object({ token: z.string() }),
});

export const regenerateToken = defineRpc({
  name: "send-to-paseo.token.regenerate",
  input: z.object({}),
  output: z.object({ token: z.string() }),
});

export const updateConfig = defineRpc({
  name: "send-to-paseo.config.update",
  input: z.object({
    port: z.number().int().min(1).max(65535).optional(),
    /** Null clears the override and falls back to the daemon's own default. */
    defaultProvider: z.string().max(200).nullable().optional(),
    /** Null stops following a profile. */
    defaultProfileId: z.string().max(200).nullable().optional(),
    /** Null clears the override and falls back to the mode chain. */
    defaultModeId: z.string().max(200).nullable().optional(),
  }),
  output: z.object({ status: BridgeStatusSchema, error: z.string().nullable() }),
});

export const clearRecentSends = defineRpc({
  name: "send-to-paseo.recent.clear",
  input: z.object({}),
  output: z.object({ removed: z.number() }),
});

// ---------------------------------------------------------------------------
// Pure formatting shared by the bridge and the surface
// ---------------------------------------------------------------------------

/**
 * The `paseo://` link that opens an agent in the Paseo app.
 *
 * A local reimplementation of `buildAgentDeepLink` from
 * `@getpaseo/protocol/agent-deep-link`, transcribed from
 * `packages/protocol/src/agent-deep-link.ts` in Paseo 0.7.0 (verified against
 * the published `@getpaseo/protocol@0.7.0` `dist/agent-deep-link.js`, which is
 * byte-identical in behaviour).
 *
 * It is copied rather than imported because `paseo plugin add` compiles a plugin
 * with *no installed packages*: the only specifiers the host makes resolvable are
 * its own SDK (`@getpaseo/plugin`, `@getpaseo/plugin/server`,
 * `@getpaseo/plugin/react-native`), `zod`, `react`, `react/jsx-runtime`,
 * `react-native` and `@tanstack/react-query`. `@getpaseo/protocol` is not one of
 * them, so a value import from it fails the install with
 * `Could not resolve "@getpaseo/protocol/agent-deep-link"`. See
 * `plugin/VERIFICATION.md`.
 *
 * The upstream format is `paseo:/` + `/h/<serverId>/agent/<agentId>`, i.e.
 * `paseo://h/<serverId>/agent/<agentId>`, with each segment
 * `encodeURIComponent`-escaped and trimmed first. Re-check this against the
 * source above when bumping Paseo; a wrong format produces a link that opens
 * nothing rather than an error.
 */
export function buildAgentDeepLink(target: { serverId: string; agentId: string }): string {
  const serverId = target.serverId.trim();
  const agentId = target.agentId.trim();
  if (!serverId || !agentId) {
    throw new Error("Agent deep links require a server ID and agent ID.");
  }
  return `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

/** `github:acmegizmos/gizmo-poc#942`, the value of the `send-to-paseo/pr` label. */
export function prLabelValue(ref: PrRef): string {
  return `${ref.forge}:${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * Length of a prompt as CONTRACT.md measures it: Unicode code points, not
 * UTF-16 code units, so an emoji or an astral-plane character counts once.
 */
export function promptLength(prompt: string): number {
  return [...prompt].length;
}

/** First line of the user's message, capped for the agent list. */
export function summarizePrompt(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length <= MAX_TITLE_SUMMARY_CHARS) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_SUMMARY_CHARS - 1)}…`;
}

/** `PR #942 · Fix merge conflicts`, per CONTRACT.md "Agent metadata". */
export function buildAgentTitle(number: number, prompt: string): string {
  const summary = summarizePrompt(prompt);
  return summary === "" ? `PR #${number}` : `PR #${number} · ${summary}`;
}

/**
 * The context header prepended to the user's message, byte-for-byte as
 * CONTRACT.md "Prompt composition" specifies. `pageUrl` is the one documented
 * enrichment: CONTRACT.md says it is "used only to enrich the agent's opening
 * prompt", so it appears as a trailing `Page:` line and is otherwise absent.
 */
export function composePrompt(input: {
  ref: PrRef;
  pr: PrPayload;
  prompt: string;
  pageUrl?: string;
  /** Branch the target workspace is actually on, when known. */
  workspaceBranch?: string | null;
  /**
   * Set only when `gh` could not describe the PR. The `Title:` and `Branch:`
   * lines are then omitted rather than filled with placeholders — telling an
   * agent it is on a branch nobody verified is how commits land in the wrong
   * place — and this sentence explains the gap instead. Prompt text is
   * behaviour, not wire shape, so this does not move `contract`.
   */
  prMetadataNote?: string;
}): string {
  const { ref, pr } = input;
  const note = input.prMetadataNote ?? "";
  const degraded = note !== "";
  const lines = [`[Sent from Graphite — ${ref.forge}/${ref.owner}/${ref.repo} PR #${ref.number}]`];
  if (!degraded) {
    lines.push(`Title: ${pr.title}`, `Branch: ${pr.headBranch} -> ${pr.baseBranch}`);
  }
  lines.push(`PR: ${pr.url}`);
  if (input.pageUrl !== undefined && input.pageUrl.trim() !== "") {
    lines.push(`Page: ${input.pageUrl.trim()}`);
  }
  if (degraded) {
    const workspaceBranch = input.workspaceBranch;
    if (typeof workspaceBranch === "string" && workspaceBranch !== "") {
      // Stated as fact, with no claim about whether it is this PR's branch —
      // without gh, nothing knows what this PR's branch is.
      lines.push(`Workspace branch: ${workspaceBranch}`);
    }
    lines.push(note);
    return `${lines.join("\n")}\n\n${input.prompt}`;
  }
  // One workspace per stack is a normal way to work, so an agent is often
  // started in a worktree checked out to a *sibling* branch. Saying nothing
  // would leave the agent believing it is on the PR branch — and committing
  // there. Tell it the truth instead of guessing what it should do about it.
  const workspaceBranch = input.workspaceBranch;
  if (
    typeof workspaceBranch === "string" &&
    workspaceBranch !== "" &&
    workspaceBranch !== pr.headBranch
  ) {
    lines.push(
      `Workspace branch: ${workspaceBranch} (NOT this PR's branch)`,
      `Note: this worktree is on a different branch of the same stack. If your change belongs to PR #${ref.number}, check out ${pr.headBranch} first.`,
    );
  }
  return `${lines.join("\n")}\n\n${input.prompt}`;
}
