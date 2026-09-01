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
 */

const REMOTE_TTL_MS = 5 * 60_000;

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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const bin = await findGit();
  if (bin === null) throw new Error("git was not found");
  const { stdout } = await runProcess(bin, ["-C", cwd, ...args]);
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

export function clearGitCaches(): void {
  headPathCache.clear();
  branchCache.clear();
  remoteCache.clear();
}
