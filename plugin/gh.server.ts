import { z } from "zod";
import {
  BridgeError,
  type PrPayload,
  type PrRef,
  type StackPrState,
} from "./contracts.shared";
import { INSTALL_HINT, findGh, ghEnv, runProcess } from "./deps.server";

/**
 * Pull-request lookups through the real `gh` binary.
 *
 * `gh` is a shell *function* in some users' zsh, so this module resolves the
 * executable itself (see `deps.server`) and calls it with `execFile` and an
 * argv array. Nothing here ever goes through a shell, which means the function
 * is bypassed and no part of an HTTP request can become shell syntax.
 *
 * **`gh` IS OPTIONAL.** Everything it provides is metadata: the PR title, the
 * head and base branch names, and stack discovery. Creating a worktree for a PR
 * goes through Paseo's own `checkoutSource: { kind: "change_request" }`, which
 * uses Paseo's forge credentials and never touches `gh`. So a missing,
 * unauthenticated or broken `gh` must degrade — see `lookupPr` — and must never
 * turn "send this instruction to an agent" into an error. The one exception is
 * a `gh` that is working well enough to say the *pull request number* does not
 * exist, which is a real, actionable answer worth reporting.
 */

const PR_TIMEOUT_MS = 15_000;
/** Sibling lookups are best-effort, so they get a much shorter leash. */
const STACK_TIMEOUT_MS = 8_000;
const PR_TTL_MS = 60_000;

const GhPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  state: z.string(),
  url: z.string(),
});

/** One `gh pr list` row: just enough to rebuild the stack graph. */
const GhPrListItemSchema = z.object({
  number: z.number(),
  headRefName: z.string(),
  baseRefName: z.string(),
  /** Only requested for the merged/closed list; the open list knows its own. */
  state: z.string().optional(),
});
const GhPrListSchema = z.array(GhPrListItemSchema);

const GhRepoSchema = z.object({
  defaultBranchRef: z.object({ name: z.string() }).nullable().optional(),
});

/**
 * GitHub's own state vocabulary is uppercase and treats `MERGED` as distinct
 * from `CLOSED`; this maps it onto the three values CONTRACT.md's
 * `stackPrState` allows.
 */
export function normalizeStackPrState(raw: string): StackPrState {
  const value = raw.trim().toUpperCase();
  if (value === "OPEN") return "open";
  if (value === "MERGED") return "merged";
  // Anything else is reported as closed rather than dropped: an unrecognised
  // state must not silently become "open", which is the one value the wire
  // format spells by omission.
  return "closed";
}

/**
 * A branch that belongs to the same stack as the PR being resolved.
 * `distance` is hops through the base->head chain, so 1 is the immediate
 * parent or child. Used to prefer the nearest stack workspace.
 */
export interface StackMember {
  /**
   * The PR whose head branch this is, or null when the branch has no PR at
   * all. Null is reachable only through the local-ancestry mechanism, which
   * proves stack membership from commit reachability and therefore also
   * recognises a Graphite branch that was never pushed as a PR.
   */
  number: number | null;
  branch: string;
  distance: number;
  /** That PR's state; null exactly when `number` is null. */
  state: StackPrState | null;
}

/** Distance given to a member we know only from the caller's hints. */
export const UNKNOWN_STACK_DISTANCE = 9_999;

/**
 * Distance for a member proved only by local git ancestry.
 *
 * Deliberately its own constant, and deliberately *larger* than
 * `UNKNOWN_STACK_DISTANCE`, so ordering degrades in order of evidence quality:
 * a measured hop count through GitHub's base->head chain first, then a sibling
 * the page itself listed but whose hop count we could not compute, then a
 * purely local inference from commit reachability. Reusing
 * `UNKNOWN_STACK_DISTANCE` would make "GitHub says this is a sibling" and "the
 * commits happen to be an ancestor" sort identically, and they are not equally
 * strong claims. Neither can ever outrank a real hop count, which is 1..n.
 */
export const ANCESTRY_STACK_DISTANCE = 99_999;

const STACK_LIST_LIMIT = 200;
const STACK_LIST_TIMEOUT_MS = 12_000;
const STACK_LIST_TTL_MS = 60_000;

/**
 * The merged/closed half of stack discovery.
 *
 * A repository's open PRs are naturally bounded; its merged history is not, so
 * this list is capped exactly like the open one and the cap is logged rather
 * than silently truncating. The TTL is longer because the fetch is only ever
 * made on the slow path (see `viewStackGraph`) and because merged history is
 * near-immutable — the one thing a stale entry can cost is up to five minutes
 * where a *just*-merged PR is in neither list (the open list drops it at 60s),
 * and the ancestry mechanism covers that window.
 */
const CLOSED_STACK_LIST_LIMIT = 200;
const CLOSED_STACK_LIST_TTL_MS = 5 * 60_000;
/** `gh repo view` is one field; it does not need the list timeout. */
const REPO_VIEW_TIMEOUT_MS = 8_000;
const REPO_TTL_MS = 30 * 60_000;

/**
 * How many pull requests may be based on a branch before a *non-open* PR
 * claiming that branch as its head is treated as trunk rather than as a stack
 * node.
 *
 * The exact-name trunk check is the primary guard; this is the backstop for
 * when trunk cannot be named at all, and for a repository with a second
 * long-lived integration branch that back-merges (`main` <- `develop`). Four,
 * not two, because a Graphite stack genuinely can fork: a branch with two or
 * three children is a real shape, a branch with four merged-PR children that
 * is not an integration branch is not.
 */
const TRUNK_FANOUT = 4;

/**
 * Why a `gh` call failed, at the granularity a user can act on. Kept separate
 * from the wire error code because CONTRACT.md's code set is closed and lumps
 * all of these into `forge_unauthenticated`; the distinction lives in the
 * message, the hint and the log line instead.
 */
export type GhFailureKind =
  | "missing"
  | "unauthenticated"
  | "no_repo_access"
  | "network"
  | "timeout"
  | "pr_missing"
  | "unknown";

/** A `gh` failure carrying why, so callers can decide to degrade or report. */
export class GhError extends BridgeError {
  readonly kind: GhFailureKind;

  constructor(
    kind: GhFailureKind,
    code: "forge_unauthenticated" | "pr_not_found",
    message: string,
    hint?: string,
  ) {
    super(code, message, hint);
    this.kind = kind;
  }
}

async function ghBinary(): Promise<string> {
  const found = await findGh();
  if (found === null) {
    throw new GhError(
      "missing",
      "forge_unauthenticated",
      "The GitHub CLI (gh) is not installed, so the pull request title, branches and stack could not be read. Sending still works.",
      INSTALL_HINT.gh,
    );
  }
  return found;
}

function looksUnauthenticated(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("gh auth login") ||
    lower.includes("authentication required") ||
    lower.includes("not logged in") ||
    lower.includes("bad credentials") ||
    lower.includes("http 401") ||
    lower.includes("requires authentication")
  );
}

/**
 * gh resolved the repository but not the pull request number. This is the one
 * `gh` failure worth reporting as an error: the answer is real and the user can
 * act on it, and unlike the cases below it does not mean "we could not ask".
 */
function looksPrMissing(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("could not resolve to a pullrequest") ||
    lower.includes("no pull requests found") ||
    lower.includes("could not find any pull request")
  );
}

/**
 * gh could not see the repository at all. Distinct from "the PR does not
 * exist": a private repo the user's `gh` account cannot read is still a repo
 * Paseo's own forge credentials may well be able to check out, so this degrades
 * rather than failing the request.
 */
function looksNoRepoAccess(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("could not resolve to a repository") ||
    lower.includes("http 403") ||
    lower.includes("http 404") ||
    lower.includes("not found") ||
    lower.includes("saml enforcement") ||
    lower.includes("resource not accessible")
  );
}

/** No route to github.com. Never let this read as "gh is not installed". */
function looksNetwork(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("dial tcp") ||
    lower.includes("no such host") ||
    lower.includes("connection refused") ||
    lower.includes("network is unreachable") ||
    lower.includes("temporary failure in name resolution") ||
    lower.includes("tls handshake") ||
    lower.includes("i/o timeout") ||
    lower.includes("proxyconnect") ||
    lower.includes("eof")
  );
}

interface ExecFailure {
  code?: number | string;
  stderr?: string;
  stdout?: string;
  message?: string;
  killed?: boolean;
}

/**
 * Turns a raw `execFile` rejection into a `GhError` whose message names the
 * dependency and whose hint is the exact command to run. The order matters:
 * ENOENT (the binary vanished between lookup and spawn) and an auth failure are
 * both checked before the generic text matches, so neither can be mistaken for
 * the other or for "pull request not found".
 */
function classify(error: unknown, ref: PrRef): GhError {
  const failure = error as ExecFailure;
  const stderr = (failure.stderr ?? "").trim();
  const text = `${stderr}\n${failure.message ?? ""}`;
  const slug = `${ref.owner}/${ref.repo}#${ref.number}`;

  // The path resolved but the file is gone (uninstalled while we were running),
  // or is not executable by this user.
  if (failure.code === "ENOENT" || failure.code === "EACCES") {
    return new GhError(
      "missing",
      "forge_unauthenticated",
      "The GitHub CLI (gh) was found but could not be executed, so the pull request title, branches and stack could not be read. Sending still works.",
      INSTALL_HINT.gh,
    );
  }
  // gh exits 4 specifically for an authentication problem.
  if (failure.code === 4 || looksUnauthenticated(text)) {
    return new GhError(
      "unauthenticated",
      "forge_unauthenticated",
      `The GitHub CLI (gh) is installed but not signed in to GitHub, so ${slug} could not be read. Sending still works.`,
      "Run: gh auth login",
    );
  }
  if (failure.killed === true || failure.code === "ETIMEDOUT") {
    return new GhError(
      "timeout",
      "forge_unauthenticated",
      `The GitHub CLI (gh) did not answer in time while reading ${slug}.`,
      "Check your network, then try again.",
    );
  }
  if (looksNetwork(text)) {
    return new GhError(
      "network",
      "forge_unauthenticated",
      `The GitHub CLI (gh) could not reach github.com while reading ${slug}.`,
      "Check your network connection, then try again.",
    );
  }
  if (looksPrMissing(text)) {
    return new GhError(
      "pr_missing",
      "pr_not_found",
      `Pull request ${slug} does not exist on GitHub.`,
      "Check the pull request number.",
    );
  }
  if (looksNoRepoAccess(text)) {
    return new GhError(
      "no_repo_access",
      "forge_unauthenticated",
      `The GitHub account gh is signed in as cannot see ${ref.owner}/${ref.repo}, so ${slug} could not be read. Sending still works.`,
      "Check access with: gh auth status",
    );
  }
  // Unknown gh failures are reported as a forge problem rather than `internal`,
  // because the actionable cause is almost always gh or the network.
  return new GhError(
    "unknown",
    "forge_unauthenticated",
    `The GitHub CLI (gh) could not read ${slug}.`,
    stderr === "" ? undefined : stderr.split("\n")[0],
  );
}

const prCache = new Map<string, { at: number; pr: PrPayload }>();

function cacheKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

async function viewPrRaw(ref: PrRef, timeoutMs: number): Promise<PrPayload> {
  const bin = await ghBinary();
  const { stdout } = await runProcess(
    bin,
    [
      "pr",
      "view",
      String(ref.number),
      "--repo",
      `${ref.owner}/${ref.repo}`,
      "--json",
      "number,title,headRefName,baseRefName,state,url",
    ],
    { timeoutMs, env: ghEnv() },
  );
  const parsed = GhPrSchema.safeParse(JSON.parse(stdout));
  if (!parsed.success) {
    throw new GhError(
      "unknown",
      "forge_unauthenticated",
      `The GitHub CLI (gh) returned an unexpected shape for ${cacheKey(ref)}.`,
      "Check the gh version with: gh --version",
    );
  }
  return {
    number: parsed.data.number,
    title: parsed.data.title,
    headBranch: parsed.data.headRefName,
    baseBranch: parsed.data.baseRefName,
    state: parsed.data.state,
    url: parsed.data.url,
  };
}

/** PR metadata, cached briefly so opening the popover twice costs one lookup. */
export async function viewPr(ref: PrRef): Promise<PrPayload> {
  const key = cacheKey(ref);
  const hit = prCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < PR_TTL_MS) return hit.pr;
  try {
    const pr = await viewPrRaw(ref, PR_TIMEOUT_MS);
    prCache.set(key, { at: Date.now(), pr });
    return pr;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw classify(error, ref);
  }
}

/* -------------------------------------------------------------------------- */
/* degraded lookup                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The degraded-mode log line is throttled per failure kind. The popover calls
 * resolve on every open, and a user who has simply not installed `gh` would
 * otherwise get an identical line for every PR they look at.
 */
const OUTAGE_LOG_TTL_MS = 5 * 60_000;
const outageLoggedAt = new Map<GhFailureKind, number>();

/** What was lost, and what the user can do about it. Never on the wire. */
export interface GhOutage {
  kind: GhFailureKind;
  /** Full sentence, safe to show a user and to put in an agent's prompt. */
  message: string;
  hint: string;
  /** A few words for a picker label, e.g. "gh not installed". */
  short: string;
}

function shortFor(kind: GhFailureKind): string {
  switch (kind) {
    case "missing":
      return "gh not installed";
    case "unauthenticated":
      return "gh not signed in — run gh auth login";
    case "no_repo_access":
      return "gh cannot see this repo";
    case "network":
      return "github.com unreachable";
    case "timeout":
      return "gh timed out";
    default:
      return "gh unavailable";
  }
}

/**
 * The PR as GitHub describes it, or a placeholder plus the reason it is a
 * placeholder.
 *
 * This is the whole graceful-degradation story for `gh`. Only `pr_missing`
 * propagates as an error, because it is the one case where `gh` gave a real
 * answer about a real repository. Everything else — not installed, not signed
 * in, no access, no network, timed out, unparseable output — returns a
 * placeholder so the popover still opens and the user can still send: Paseo
 * creates the worktree from the PR number itself, without `gh`.
 *
 * Callers must surface `outage` (candidate label, prompt note, log line);
 * degrading silently would leave the user wondering why the PR title vanished.
 */
export async function lookupPr(ref: PrRef): Promise<{ pr: PrPayload; outage: GhOutage | null }> {
  try {
    return { pr: await viewPr(ref), outage: null };
  } catch (error) {
    if (error instanceof GhError && error.kind !== "pr_missing") {
      const outage: GhOutage = {
        kind: error.kind,
        message: error.message,
        hint: error.hint ?? "",
        short: shortFor(error.kind),
      };
      const lastLogged = outageLoggedAt.get(error.kind) ?? 0;
      if (Date.now() - lastLogged > OUTAGE_LOG_TTL_MS) {
        outageLoggedAt.set(error.kind, Date.now());
        console.log(
          `[send-to-paseo] degraded: ${error.message}${outage.hint === "" ? "" : ` (${outage.hint})`}`,
        );
      }
      return { pr: unknownPr(ref), outage };
    }
    throw error;
  }
}

/**
 * A PR payload with only what is knowable without `gh`: the number, and the
 * canonical URL, which is a pure function of the reference.
 *
 * `headBranch` and `baseBranch` are deliberately empty rather than guessed.
 * Empty is what stops `buildCandidates` from claiming an exact branch match and
 * what stops `composePrompt` from telling an agent it is on a branch nobody
 * verified. `title` stays `PR #942` so anything that concatenates it still
 * reads correctly.
 */
export function unknownPr(ref: PrRef): PrPayload {
  return {
    number: ref.number,
    title: `PR #${ref.number}`,
    headBranch: "",
    baseBranch: "",
    state: "UNKNOWN",
    url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
  };
}

/* -------------------------------------------------------------------------- */
/* stack discovery                                                            */
/* -------------------------------------------------------------------------- */

interface PrListEntry {
  number: number;
  headRefName: string;
  baseRefName: string;
  state: StackPrState;
}

const prListCache = new Map<string, { at: number; entries: PrListEntry[] }>();
const closedPrListCache = new Map<string, { at: number; entries: PrListEntry[] }>();
const repoTrunkCache = new Map<string, { at: number; branch: string | null }>();

function repoSlug(ref: Pick<PrRef, "owner" | "repo">): string {
  return `${ref.owner}/${ref.repo}`;
}

/** One `gh pr list` call, parsed and stamped with the state we asked for. */
async function fetchPrList(
  ref: Pick<PrRef, "owner" | "repo">,
  state: "open" | "closed",
  limit: number,
): Promise<PrListEntry[]> {
  const bin = await ghBinary();
  const { stdout } = await runProcess(
    bin,
    [
      "pr",
      "list",
      "--repo",
      repoSlug(ref),
      "--state",
      state,
      "--limit",
      String(limit),
      "--json",
      // `state` is only meaningful on the closed list, where it separates
      // MERGED from CLOSED. Asked for unconditionally so both lists parse
      // through one schema.
      "number,headRefName,baseRefName,state",
    ],
    { timeoutMs: STACK_LIST_TIMEOUT_MS, env: ghEnv() },
  );
  const parsed = GhPrListSchema.safeParse(JSON.parse(stdout));
  if (!parsed.success) {
    throw new GhError(
      "unknown",
      "forge_unauthenticated",
      `The GitHub CLI (gh) returned an unexpected shape listing pull requests for ${repoSlug(ref)}.`,
      "Check the gh version with: gh --version",
    );
  }
  return parsed.data.map((row) => ({
    number: row.number,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    // Trust the row over the filter we asked for: `--state closed` returns
    // MERGED rows too (measured, see `listNonOpenPrs`).
    state:
      row.state === undefined
        ? state === "open"
          ? "open"
          : "closed"
        : normalizeStackPrState(row.state),
  }));
}

/**
 * Every open PR in a repository, as `{number, head, base, state}`.
 *
 * One request instead of one per sibling, cached briefly because the popover
 * calls resolve on every open.
 */
async function listOpenPrs(ref: Pick<PrRef, "owner" | "repo">): Promise<PrListEntry[]> {
  const key = repoSlug(ref).toLowerCase();
  const hit = prListCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < STACK_LIST_TTL_MS) return hit.entries;

  const entries = await fetchPrList(ref, "open", STACK_LIST_LIMIT);
  if (entries.length >= STACK_LIST_LIMIT) {
    // Truncation degrades safely — an unfound stack falls back to the create
    // option rather than to a wrong workspace — but it would be an unexplainable
    // mystery in the field, so say it out loud.
    console.log(
      `[send-to-paseo] ${repoSlug(ref)} has at least ${STACK_LIST_LIMIT} open PRs; ` +
        `the stack lookup may be truncated and stack candidates may be missing`,
    );
  }
  prListCache.set(key, { at: Date.now(), entries });
  return entries;
}

/**
 * The merged and closed PRs of a repository, newest first.
 *
 * ONE call, not two: `gh pr list --state closed` returns MERGED rows as well as
 * CLOSED ones — measured on 2026-09-02 against `cli/cli`, where the first five
 * `--state closed` rows were three CLOSED and two MERGED. (GitHub's search
 * semantics: a merged PR *is* closed. `--state merged` is the narrower filter.)
 * So one request covers both, and each row's own `state` field is what
 * distinguishes them.
 *
 * NEVER on the hot path. `/v1/resolve` runs on every popover open while the
 * user types, and the open-PR list already answers the common cases (workspace
 * on this PR's branch, or on an open sibling's). This list is fetched only when
 * a project workspace is left unplaced by the open-PR graph, which is the
 * situation this whole mechanism exists for.
 */
async function listNonOpenPrs(ref: Pick<PrRef, "owner" | "repo">): Promise<PrListEntry[]> {
  const key = repoSlug(ref).toLowerCase();
  const hit = closedPrListCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CLOSED_STACK_LIST_TTL_MS) return hit.entries;

  const entries = await fetchPrList(ref, "closed", CLOSED_STACK_LIST_LIMIT);
  if (entries.length >= CLOSED_STACK_LIST_LIMIT) {
    // A repository's merged history is unbounded, so unlike the open list this
    // cap will be hit by any busy repo. Say so: the symptom of truncation is
    // "my merged stack branch was not recognised", and it is otherwise
    // indistinguishable from the mechanism not working at all.
    console.log(
      `[send-to-paseo] ${repoSlug(ref)} has at least ${CLOSED_STACK_LIST_LIMIT} merged/closed PRs; ` +
        `only the ${CLOSED_STACK_LIST_LIMIT} most recent were considered, so an older ` +
        `merged stack branch may not be recognised`,
    );
  }
  closedPrListCache.set(key, { at: Date.now(), entries });
  return entries;
}

/**
 * The repository's default branch, according to GitHub.
 *
 * Only used as a fallback when the local clone has no `refs/remotes/origin/HEAD`
 * (see `readTrunkBranch`), and cached for half an hour because a repository's
 * default branch effectively never changes. Returns null rather than throwing:
 * not knowing trunk costs precision in stack discovery, never the resolve.
 */
export async function repoDefaultBranch(ref: Pick<PrRef, "owner" | "repo">): Promise<string | null> {
  const key = repoSlug(ref).toLowerCase();
  const hit = repoTrunkCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < REPO_TTL_MS) return hit.branch;
  let branch: string | null = null;
  try {
    const bin = await ghBinary();
    const { stdout } = await runProcess(
      bin,
      ["repo", "view", repoSlug(ref), "--json", "defaultBranchRef"],
      { timeoutMs: REPO_VIEW_TIMEOUT_MS, env: ghEnv() },
    );
    const parsed = GhRepoSchema.safeParse(JSON.parse(stdout));
    const name = parsed.success ? (parsed.data.defaultBranchRef?.name ?? "") : "";
    branch = name === "" ? null : name;
  } catch {
    branch = null;
  }
  repoTrunkCache.set(key, { at: Date.now(), branch });
  return branch;
}

/**
 * The stack containing `headBranch`, derived from GitHub itself.
 *
 * A Graphite stack is a real base->head chain on GitHub: PR #943's
 * `baseRefName` is PR #942's `headRefName`. (The `graphite-base/942` ref shown
 * in Graphite's own UI is display-only and never appears here.) So the stack is
 * the connected component containing our PR in the graph whose edges are
 * "A.base === B.head", and a breadth-first walk gives both downstack ancestors
 * and upstack descendants at once, along with the hop distance.
 *
 * Trunk cannot create a false edge *among open PRs*: an edge exists only when
 * one PR's base is another PR's head, and an open PR whose head is `main` is
 * not a thing anyone opens. That stops being true the moment merged PRs join
 * the graph — see `trunkLikeHeads` — which is why `includeNonOpen` also needs a
 * trunk name.
 *
 * WHY NOT `gt`: the Graphite CLI answers "what is *my current* stack" from
 * local, per-worktree metadata, relative to whatever branch happens to be
 * checked out in the directory it runs in. This endpoint runs while the user is
 * typing in a browser and must not depend on — or disturb — the state of any
 * worktree, least of all the candidate workspaces themselves, each of which is
 * on its own branch. It also needs no second credential: `gh` is already
 * required here. See PLAN.md.
 */
export interface StackGraph {
  /**
   * Stack members keyed by head branch. Excludes the PR's own head branch,
   * which is the exact match rather than a sibling.
   */
  members: Map<string, StackMember>;
  /**
   * Every PR the walk *considered*, keyed by head branch, open entries winning
   * a duplicate. Not the stack — this is how a branch proved to belong to the
   * stack by some other means (local ancestry) gets a PR number and a state
   * attached to it.
   */
  byHead: Map<string, PrListEntry>;
  /** True when the merged/closed list was consulted. */
  widened: boolean;
}

/**
 * Head branches that are really trunk wearing a merged PR's clothes.
 *
 * MEASURED, not hypothetical: in `vercel/turborepo`, PR #13875 is MERGED with
 * `headRefName: "main"` — a release back-merge. Feed that row to the walk and
 * `main` becomes a graph node, at which point all 13 open PRs based on `main`
 * are one connected component, i.e. one enormous false "stack". The same shape
 * appears wherever a repository merges an integration branch back into trunk.
 *
 * Two guards, because the primary one can be unavailable:
 *   1. the trunk branch's name, when the caller could determine it;
 *   2. fan-out: a non-open head that `TRUNK_FANOUT` or more PRs are based on.
 *
 * Only non-open entries are filtered. Open entries keep the behaviour that the
 * existing verification suite measured, and the failure mode of filtering is
 * asymmetric anyway: dropping a real stack node costs a rank-2 candidate and
 * falls back to "create a worktree", while keeping a false one *proposes the
 * wrong workspace*.
 */
function trunkLikeHeads(entries: readonly PrListEntry[], trunk: string | null): Set<string> {
  const baseCounts = new Map<string, number>();
  for (const entry of entries) {
    baseCounts.set(entry.baseRefName, (baseCounts.get(entry.baseRefName) ?? 0) + 1);
  }
  const rejected = new Set<string>();
  for (const entry of entries) {
    if (entry.state === "open") continue;
    if (trunk !== null && entry.headRefName === trunk) rejected.add(entry.headRefName);
    if ((baseCounts.get(entry.headRefName) ?? 0) >= TRUNK_FANOUT) rejected.add(entry.headRefName);
  }
  return rejected;
}

export async function viewStackGraph(
  ref: Pick<PrRef, "owner" | "repo">,
  headBranch: string,
  options: {
    /**
     * Also walk merged and closed PRs. Costs one extra `gh pr list`, so the
     * caller only sets it once it knows the open-PR graph left a workspace
     * unexplained.
     */
    includeNonOpen?: boolean;
    /** Trunk's branch name, when known. See `trunkLikeHeads`. */
    trunk?: string | null;
  } = {},
): Promise<StackGraph> {
  const open = await listOpenPrs(ref);
  const widened = options.includeNonOpen === true;
  // Open first, so `byHead` prefers an open PR over a merged one for the same
  // head branch. A branch that has both is a reopened-then-superseded head, and
  // the open PR is the one the user is looking at.
  const entries = widened ? [...open, ...(await listNonOpenPrs(ref))] : open;
  const rejected = widened ? trunkLikeHeads(entries, options.trunk ?? null) : new Set<string>();

  const byHead = new Map<string, PrListEntry>();
  for (const entry of entries) {
    // A branch with two open PRs is malformed; first wins, deterministically.
    if (!byHead.has(entry.headRefName)) byHead.set(entry.headRefName, entry);
  }
  const children = new Map<string, PrListEntry[]>();
  for (const entry of entries) {
    const list = children.get(entry.baseRefName);
    if (list === undefined) children.set(entry.baseRefName, [entry]);
    else list.push(entry);
  }

  const start = byHead.get(headBranch);
  const found = new Map<string, StackMember>();
  if (start === undefined) return { members: found, byHead, widened };

  const seen = new Set<string>([start.headRefName]);
  let frontier: PrListEntry[] = [start];
  let distance = 0;

  while (frontier.length > 0) {
    const next: PrListEntry[] = [];
    for (const entry of frontier) {
      if (distance > 0) {
        found.set(entry.headRefName, {
          number: entry.number,
          branch: entry.headRefName,
          distance,
          state: entry.state,
        });
      }
      // Downstack: the PR whose head is this PR's base.
      const parent = byHead.get(entry.baseRefName);
      if (
        parent !== undefined &&
        !seen.has(parent.headRefName) &&
        !rejected.has(parent.headRefName)
      ) {
        seen.add(parent.headRefName);
        next.push(parent);
      }
      // Upstack: every PR based on this PR's head.
      for (const child of children.get(entry.headRefName) ?? []) {
        if (seen.has(child.headRefName) || rejected.has(child.headRefName)) continue;
        seen.add(child.headRefName);
        next.push(child);
      }
    }
    frontier = next;
    distance += 1;
  }

  return { members: found, byHead, widened };
}

/**
 * Head branches for the stack siblings, best-effort, with each sibling's state.
 *
 * A slow or failing sibling lookup must never block a send, so failures are
 * dropped and the caller simply gets no rank-2 candidates for that PR.
 */
export async function viewStackBranches(
  ref: Pick<PrRef, "forge" | "owner" | "repo">,
  numbers: readonly number[],
): Promise<Map<string, { number: number; state: StackPrState }>> {
  const byBranch = new Map<string, { number: number; state: StackPrState }>();
  const unique = [...new Set(numbers)];
  if (unique.length === 0) return byBranch;

  const results = await Promise.allSettled(
    unique.map(async (number) => {
      const siblingRef: PrRef = { ...ref, number };
      const key = cacheKey(siblingRef);
      const hit = prCache.get(key);
      if (hit !== undefined && Date.now() - hit.at < PR_TTL_MS) return hit.pr;
      const pr = await viewPrRaw(siblingRef, STACK_TIMEOUT_MS);
      prCache.set(key, { at: Date.now(), pr });
      return pr;
    }),
  );

  let failures = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      failures += 1;
      continue;
    }
    // First writer wins, so the lowest sibling number labels a shared branch.
    if (!byBranch.has(result.value.headBranch)) {
      byBranch.set(result.value.headBranch, {
        number: result.value.number,
        state: normalizeStackPrState(result.value.state),
      });
    }
  }
  if (failures > 0) {
    console.log(
      `[send-to-paseo] ${failures} of ${unique.length} stack sibling lookups failed; continuing without them`,
    );
  }
  return byBranch;
}

export function clearPrCache(): void {
  prCache.clear();
  prListCache.clear();
  closedPrListCache.clear();
  repoTrunkCache.clear();
  outageLoggedAt.clear();
}
