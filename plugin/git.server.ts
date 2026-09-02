import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { INSTALL_HINT, findGit, runProcess } from "./deps.server";
import { BridgeError } from "./contracts.shared";

/**
 * Branch and remote reads for workspace directories.
 *
 * Every call goes through `execFile` with an argv array and no shell (see
 * `deps.server`), so nothing here can be influenced by the user's shell
 * functions, aliases or `$PATH` ordering surprises.
 *
 * Most reads never spawn anything: `resolve.server` prefers the branch the
 * daemon already reports on each workspace descriptor and only falls back to
 * this module when that field is missing. When it does spawn, results are
 * cached against the mtime of the worktree's `HEAD`, so repeated popover opens
 * are free until the branch actually moves.
 *
 * `git` missing is not a case this module reports: every read here is a
 * fallback, so it degrades to "branch unknown". The one place a missing `git`
 * is fatal — creating a worktree — asks `requireGit()` for a message that names
 * the dependency, and the startup self-check says so in the log regardless.
 *
 * EVERYTHING HERE IS READ-ONLY, and that is a hard rule rather than a
 * coincidence. `/v1/resolve` runs while the user is typing in a browser, and
 * the directories it reads are the candidate *workspaces* — each on its own
 * branch, quite possibly with an agent working in it. So: no `fetch`, no
 * checkout, no ref writes, nothing that takes a lock. The ancestry read below
 * is the one that makes this tempting to break (a `git fetch` would make it
 * answer more often), and it must not be.
 */

const REMOTE_TTL_MS = 5 * 60_000;
/** Trunk and ancestry are both derived from refs that already exist locally. */
const TRUNK_TTL_MS = 30 * 60_000;
/**
 * `git branch --contains` walks every ref in the repository, so unlike the
 * branch reads it is not O(1). Bounded like every other spawn in the plugin;
 * the caller degrades to "no ancestry answer" if it trips.
 */
const ANCESTRY_TIMEOUT_MS = 5_000;

/**
 * The `git` executable, or a failure that names the dependency.
 *
 * Used only on paths where a missing `git` genuinely stops the work; the branch
 * reads below swallow it and return null instead.
 */
export async function requireGit(): Promise<string> {
  const found = await findGit();
  if (found === null) {
    throw new BridgeError(
      "workspace_create_failed",
      "git was not found on this machine, and Paseo needs it to check a pull request out into a worktree.",
      INSTALL_HINT.git,
    );
  }
  return found;
}

async function git(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const bin = await findGit();
  if (bin === null) throw new Error("git was not found");
  const { stdout } = await runProcess(bin, ["-C", cwd, ...args], options);
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Branch reads
// ---------------------------------------------------------------------------

/** cwd -> the `HEAD` file that actually moves when the branch changes. */
const headPathCache = new Map<string, string | null>();
/** cwd -> the branch we read, valid while `HEAD`'s mtime is unchanged. */
const branchCache = new Map<string, { mtimeMs: number | null; branch: string | null }>();

/**
 * Locates the `HEAD` that tracks this directory's branch.
 *
 * A linked worktree's `.git` is a *file* pointing at
 * `<repo>/.git/worktrees/<name>`, and that directory has its own `HEAD`. Using
 * the main repository's `HEAD` would cache every worktree against the wrong
 * file and hand back a stale branch.
 */
async function resolveHeadPath(cwd: string): Promise<string | null> {
  const cachedHead = headPathCache.get(cwd);
  if (cachedHead !== undefined) return cachedHead;

  let head: string | null = null;
  try {
    const dotGit = join(cwd, ".git");
    const info = await stat(dotGit);
    if (info.isDirectory()) {
      head = join(dotGit, "HEAD");
    } else {
      const contents = await readFile(dotGit, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(contents);
      if (match?.[1] !== undefined) {
        const gitDir = match[1].trim();
        head = join(isAbsolute(gitDir) ? gitDir : resolvePath(cwd, gitDir), "HEAD");
      }
    }
  } catch {
    head = null;
  }
  headPathCache.set(cwd, head);
  return head;
}

async function headMtime(cwd: string): Promise<number | null> {
  const head = await resolveHeadPath(cwd);
  if (head === null) return null;
  try {
    return (await stat(head)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Current branch of a working directory, or null when it is detached, is not a
 * git repository, or no longer exists on disk. Never throws: a broken worktree
 * must not take down a resolve.
 */
export async function readBranch(cwd: string): Promise<string | null> {
  const mtimeMs = await headMtime(cwd);
  const hit = branchCache.get(cwd);
  if (hit !== undefined && hit.mtimeMs === mtimeMs && mtimeMs !== null) return hit.branch;

  let branch: string | null = null;
  try {
    const value = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    // `HEAD` means detached, which is not a branch we can match a PR against.
    branch = value === "" || value === "HEAD" ? null : value;
  } catch {
    branch = null;
  }
  branchCache.set(cwd, { mtimeMs, branch });
  return branch;
}

// ---------------------------------------------------------------------------
// Remote reads
// ---------------------------------------------------------------------------

const remoteCache = new Map<string, { at: number; ownerRepo: OwnerRepo | null }>();

export interface OwnerRepo {
  owner: string;
  repo: string;
}

/**
 * Extracts `owner/repo` from any GitHub remote spelling: HTTPS, `git@` scp
 * syntax, `ssh://`, with or without a `.git` suffix.
 */
export function parseGithubRemote(url: string): OwnerRepo | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  const patterns = [
    /^(?:https?:\/\/)(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
    /^(?:ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const owner = match?.[1];
    const repo = match?.[2];
    if (owner !== undefined && repo !== undefined && !repo.includes("/")) {
      return { owner, repo };
    }
  }
  return null;
}

/**
 * `owner/repo` of a directory's `origin`. Used to match a Paseo project that
 * carries a local id rather than the `remote:github.com/...` form.
 */
export async function readOriginOwnerRepo(cwd: string): Promise<OwnerRepo | null> {
  const hit = remoteCache.get(cwd);
  if (hit !== undefined && Date.now() - hit.at < REMOTE_TTL_MS) return hit.ownerRepo;
  let ownerRepo: OwnerRepo | null = null;
  try {
    ownerRepo = parseGithubRemote(await git(cwd, ["config", "--get", "remote.origin.url"]));
  } catch {
    ownerRepo = null;
  }
  remoteCache.set(cwd, { at: Date.now(), ownerRepo });
  return ownerRepo;
}

// ---------------------------------------------------------------------------
// Trunk and ancestry
// ---------------------------------------------------------------------------

const trunkCache = new Map<string, { at: number; branch: string | null }>();

/**
 * A ref name safe to hand to `git` as an option's value.
 *
 * Nothing here can become shell syntax — every spawn is `execFile` with an argv
 * array — but a name starting with `-` could still be parsed by git as a flag,
 * so it is rejected rather than passed. Branch names reaching this module come
 * from git itself, so this is hygiene, not a live hole.
 */
function looksLikeRefName(name: string): boolean {
  return name !== "" && !name.startsWith("-") && !/[\s~^:?*[\\]/.test(name);
}

/**
 * The repository's trunk branch, from local refs only — no network.
 *
 * `git clone` writes `refs/remotes/origin/HEAD`, so in a normal clone this is a
 * single local ref read. Measured across this machine's Paseo projects on
 * 2026-09-02: 2 of 3 git projects had it, the third did not (the ref can be
 * missing after a `git init` + `git remote add`, or after some mirror/partial
 * clone flows). So callers must handle `null`, and `gh.server` has a
 * `gh repo view` fallback for exactly that case.
 *
 * Trunk matters because widening stack discovery to merged pull requests makes
 * trunk reachable as a *head* branch: measured in a public repository,
 * `vercel/turborepo` PR #13875 is MERGED with `headRefName: "main"` (a release
 * back-merge). Without a trunk name to exclude, that one row fuses every PR
 * based on `main` into a single false "stack".
 */
export async function readTrunkBranch(root: string): Promise<string | null> {
  const hit = trunkCache.get(root);
  if (hit !== undefined && Date.now() - hit.at < TRUNK_TTL_MS) return hit.branch;
  let branch: string | null = null;
  try {
    // `--short` gives "origin/main"; the remote prefix is stripped so the
    // answer is a branch name comparable with a PR's `baseRefName`.
    const value = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    branch = value.startsWith("origin/") ? value.slice("origin/".length) : value;
    if (branch === "") branch = null;
  } catch {
    branch = null;
  }
  trunkCache.set(root, { at: Date.now(), branch });
  return branch;
}

/**
 * Branch names — local and remote-tracking — whose tip has `branch` in its
 * history, i.e. every branch `branch` has been merged into or rebased under.
 *
 * `refs/heads/x` comes back as `x` and `refs/remotes/origin/x` as `origin/x`,
 * so a caller comparing against a set of stack branches must consider both
 * spellings. `--format` is used instead of parsing `git branch`'s output
 * because that output carries `* ` markers and `(HEAD detached at …)` rows.
 *
 * Returns null — never throws — when git is missing, the ref is unknown, the
 * directory is not a repository, or the walk times out. That is the whole
 * degradation story for the ancestry mechanism: it answers or it does not, and
 * a resolve is still correct without it.
 */
export async function branchesContaining(
  root: string,
  branch: string,
): Promise<Set<string> | null> {
  if (!looksLikeRefName(branch)) return null;
  let output: string;
  try {
    output = await git(root, ["branch", "-a", "--contains", branch, "--format=%(refname)"], {
      timeoutMs: ANCESTRY_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/")) names.add(ref.slice("refs/remotes/".length));
  }
  return names;
}

export function clearGitCaches(): void {
  headPathCache.clear();
  branchCache.clear();
  remoteCache.clear();
  trunkCache.clear();
}
