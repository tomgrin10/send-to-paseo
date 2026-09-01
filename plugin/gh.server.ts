import { z } from "zod";
import { BridgeError, type PrPayload, type PrRef } from "./contracts.shared";
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
});
const GhPrListSchema = z.array(GhPrListItemSchema);

/**
 * A branch that belongs to the same stack as the PR being resolved.
 * `distance` is hops through the base->head chain, so 1 is the immediate
 * parent or child. Used to prefer the nearest stack workspace.
 */
export interface StackMember {
  number: number;
  branch: string;
  distance: number;
}

/** Distance given to a member we know only from the caller's hints. */
export const UNKNOWN_STACK_DISTANCE = 9_999;

const STACK_LIST_LIMIT = 200;
const STACK_LIST_TIMEOUT_MS = 12_000;
const STACK_LIST_TTL_MS = 60_000;

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
}

const prListCache = new Map<string, { at: number; entries: PrListEntry[] }>();

/**
 * Every open PR in a repository, as `{number, head, base}`.
 *
 * One request instead of one per sibling, cached briefly because the popover
 * calls resolve on every open.
 */
async function listOpenPrs(ref: Pick<PrRef, "owner" | "repo">): Promise<PrListEntry[]> {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  const hit = prListCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < STACK_LIST_TTL_MS) return hit.entries;

  const bin = await ghBinary();
  const { stdout } = await runProcess(
    bin,
    [
      "pr",
      "list",
      "--repo",
      `${ref.owner}/${ref.repo}`,
      "--state",
      "open",
      "--limit",
      String(STACK_LIST_LIMIT),
      "--json",
      "number,headRefName,baseRefName",
    ],
    { timeoutMs: STACK_LIST_TIMEOUT_MS, env: ghEnv() },
  );
  const parsed = GhPrListSchema.safeParse(JSON.parse(stdout));
  if (!parsed.success) {
    throw new GhError(
      "unknown",
      "forge_unauthenticated",
      `The GitHub CLI (gh) returned an unexpected shape listing pull requests for ${ref.owner}/${ref.repo}.`,
      "Check the gh version with: gh --version",
    );
  }
  const entries = parsed.data;
  if (entries.length >= STACK_LIST_LIMIT) {
    // Truncation degrades safely — an unfound stack falls back to the create
    // option rather than to a wrong workspace — but it would be an unexplainable
    // mystery in the field, so say it out loud.
    console.log(
      `[send-to-paseo] ${ref.owner}/${ref.repo} has at least ${STACK_LIST_LIMIT} open PRs; ` +
        `the stack lookup may be truncated and stack candidates may be missing`,
    );
  }
  prListCache.set(key, { at: Date.now(), entries });
  return entries;
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
 * Trunk cannot create a false edge: an edge exists only when one PR's base is
 * another PR's *head*, and `main` is never a PR head.
 *
 * WHY NOT `gt`: the Graphite CLI answers "what is *my current* stack" from
 * local, per-worktree metadata, relative to whatever branch happens to be
 * checked out in the directory it runs in. This endpoint runs while the user is
 * typing in a browser and must not depend on — or disturb — the state of any
 * worktree, least of all the candidate workspaces themselves, each of which is
 * on its own branch. It also needs no second credential: `gh` is already
 * required here. See PLAN.md.
 */
export async function viewStackGraph(
  ref: Pick<PrRef, "owner" | "repo">,
  headBranch: string,
): Promise<Map<string, StackMember>> {
  const entries = await listOpenPrs(ref);

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
  if (start === undefined) return found;

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
        });
      }
      // Downstack: the PR whose head is this PR's base.
      const parent = byHead.get(entry.baseRefName);
      if (parent !== undefined && !seen.has(parent.headRefName)) {
        seen.add(parent.headRefName);
        next.push(parent);
      }
      // Upstack: every PR based on this PR's head.
      for (const child of children.get(entry.headRefName) ?? []) {
        if (seen.has(child.headRefName)) continue;
        seen.add(child.headRefName);
        next.push(child);
      }
    }
    frontier = next;
    distance += 1;
  }

  return found;
}

/**
 * Head branches for the stack siblings, best-effort.
 *
 * A slow or failing sibling lookup must never block a send, so failures are
 * dropped and the caller simply gets no rank-2 candidates for that PR.
 */
export async function viewStackBranches(
  ref: Pick<PrRef, "forge" | "owner" | "repo">,
  numbers: readonly number[],
): Promise<Map<string, number>> {
  const byBranch = new Map<string, number>();
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
      byBranch.set(result.value.headBranch, result.value.number);
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
  outageLoggedAt.clear();
}
