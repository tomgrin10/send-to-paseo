/**
 * Client-side mirror of CONTRACT.md (bridge contract v1).
 *
 * These types are transcribed byte-for-byte from the frozen contract. Do not
 * "improve" them here — if something looks wrong, report it, do not change it.
 */

export const CONTRACT_VERSION = 1;

export type Forge = "github";

export interface PrRef {
  forge: Forge;
  owner: string;
  repo: string;
  number: number;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

/** Every error code defined by CONTRACT.md. */
export const CONTRACT_ERROR_CODES = [
  "unauthorized",
  "forbidden_origin",
  "forbidden_host",
  "bad_request",
  "payload_too_large",
  "rate_limited",
  "project_not_found",
  "pr_not_found",
  "forge_unauthenticated",
  "workspace_create_failed",
  "agent_create_failed",
  "daemon_unreachable",
  "internal",
] as const;

export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

/**
 * Codes the extension synthesises locally. The bridge can never produce these
 * (it is either unreachable or not yet configured), so they live outside the
 * contract's table on purpose.
 */
export const LOCAL_ERROR_CODES = [
  "bridge_unreachable",
  "not_configured",
  "bad_response",
  "contract_mismatch",
  "extension_internal",
] as const;

export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

export type AnyErrorCode = ContractErrorCode | LocalErrorCode | (string & {});

/* -------------------------------------------------------------------------- */
/* Providers (same shape on /v1/ping and /v1/resolve)                         */
/* -------------------------------------------------------------------------- */

export interface Provider {
  id: string;
  label: string;
  isDefault: boolean;
}

/* -------------------------------------------------------------------------- */
/* Modes (same flat, provider-tagged shape on /v1/ping and /v1/resolve)       */
/* -------------------------------------------------------------------------- */

/**
 * One selectable permission mode.
 *
 * Mode ids are **per provider** — Claude offers
 * `plan`/`default`/`acceptEdits`/`auto`/`bypassPermissions`, Codex offers
 * `auto`/`auto-review`/`full-access` — so `provider` (the BARE provider id, not
 * the `provider/model` pair) is part of the identity of an entry and a UI must
 * filter by the provider it is about to send.
 *
 * `isDefault` marks that provider's own default, not one winner for the list.
 *
 * Optional on the wire: `modes` is an additive field, so a plugin built before
 * modes existed simply omits it and the extension must degrade to no mode
 * picker rather than break. See CONTRACT.md "Additive fields".
 */
export interface Mode {
  provider: string;
  id: string;
  label: string;
  isDefault: boolean;
  /** Runs without asking for permission. Marked, never hidden. */
  isUnattended?: boolean;
  /** Paseo's visual tier: `safe`/`moderate`/`planning`/`dangerous`. */
  colorTier?: string;
}

/* -------------------------------------------------------------------------- */
/* GET /v1/ping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Auth is OPTIONAL on ping:
 *   no Authorization        -> 200, paired: false, providers: []
 *   valid Authorization     -> 200, paired: true,  providers: [...]
 *   invalid Authorization   -> 401 unauthorized
 *
 * That three-way split is what lets the options page tell "bridge down" from
 * "bad token", and is the PR-independent source for the provider picker.
 */
export interface PingResponse {
  ok: true;
  name: string;
  version: string;
  contract: number;
  daemon: {
    reachable: boolean;
    version?: string;
    serverId?: string;
  };
  paired: boolean;
  providers: Provider[];
  /** Additive; absent from a plugin older than permission-mode support. */
  modes?: Mode[];
}

/* -------------------------------------------------------------------------- */
/* POST /v1/resolve                                                           */
/* -------------------------------------------------------------------------- */

export interface ResolveRequest extends PrRef {
  /**
   * Optional, may be empty. The bridge tolerates a self-inclusive list and
   * filters it, but the extension excludes the current PR anyway — belt and
   * braces, since it is the side that knows which PR the page is showing.
   */
  stackPrNumbers?: number[];
}

export interface ResolvedPr {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  url: string;
}

export interface ResolvedProject {
  projectId: string;
  name: string;
  path: string;
}

export type CandidateReason = "exact" | "stack" | "project" | "create";

export interface Candidate {
  kind: "existing" | "create";
  workspaceId?: string;
  label: string;
  branch?: string;
  cwd?: string;
  isolation?: string;
  rank: number;
  reason: CandidateReason | (string & {});
  agentCount?: number;
  stackPrNumber?: number;
}

export interface ResolveResponse {
  pr: ResolvedPr;
  project: ResolvedProject;
  candidates: Candidate[];
  defaultCandidateIndex: number;
  providers: Provider[];
  /** Additive; absent from a plugin older than permission-mode support. */
  modes?: Mode[];
  /**
   * The mode the bridge would use right now for the default provider, after its
   * own resolution chain. Null when it would omit the field entirely. Additive.
   */
  resolvedModeId?: string | null;
}

/* -------------------------------------------------------------------------- */
/* POST /v1/send                                                              */
/* -------------------------------------------------------------------------- */

export type SendTarget =
  | { kind: "existing"; workspaceId: string }
  | { kind: "create" };

export interface SendRequest extends PrRef {
  prompt: string;
  target: SendTarget;
  provider?: string;
  /**
   * Permission mode id, valid only for the provider this send resolves to. The
   * bridge validates it and falls back rather than failing, so sending a mode a
   * newer/older plugin does not know is safe.
   */
  modeId?: string;
  pageUrl?: string;
}

export interface SendResponse {
  ok: true;
  agentId: string;
  workspaceId: string;
  workspaceCreated: boolean;
  workspaceLabel?: string;
  branch?: string;
  /**
   * OPAQUE. Built by the plugin with `buildAgentDeepLink` from
   * `@getpaseo/protocol/agent-deep-link` — shape `paseo://h/<serverId>/agent/<agentId>`.
   * The extension renders it as an href and MUST NOT construct or parse it.
   */
  deepLink: string;
  title: string;
  /**
   * ALWAYS present. `true` only when the plugin runs with
   * SEND_TO_PASEO_DRY_RUN=1, in which case nothing was created and
   * agentId/workspaceId are synthetic. Must be surfaced distinctly so a dry run
   * is never mistaken for a real send.
   */
  dryRun: boolean;
}

/**
 * CONTRACT.md Clarifications: prompt length is 1..16000 **Unicode code points**
 * after trim, independent of the 64 KiB byte cap on the body. Both limits apply;
 * whichever trips first wins.
 */
export const PROMPT_MIN = 1;
export const PROMPT_MAX = 16000;

/** Code points, not UTF-16 units — so an emoji counts as 1, not 2. */
export function promptLength(text: string): number {
  return [...text].length;
}

/**
 * The bare provider id inside a `provider/model` pair, which is what `Mode`
 * entries are keyed on. `"claude/claude-opus-5"` -> `"claude"`.
 */
export function providerIdOf(providerModel: string): string {
  const slash = providerModel.indexOf("/");
  return slash === -1 ? providerModel : providerModel.slice(0, slash);
}
