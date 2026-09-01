import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Every external command the plugin depends on, where it lives, and whether it
 * works. One module so the answer to "what does this need installed?" is in one
 * place, and so the startup self-check and the Paseo surface report the same
 * thing.
 *
 * WHY THE WELL-KNOWN DIRECTORY LIST EXISTS — this is the bug that motivated
 * this module. A Paseo plugin runs inside a daemon subprocess, and that daemon
 * is normally launched by launchd / the desktop app, not from an interactive
 * shell, so it inherits a *login-less* PATH.
 *
 * Be precise about what was actually measured (VERIFICATION.md 16.2), because
 * this is latent rather than currently biting: on macOS 26.6 with Paseo 0.7.0
 * the plugin subprocess got the user's FULL interactive PATH — the host enriches
 * it. One process up, `Paseo.app` itself had
 *
 *   /usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin
 *
 * with no `/opt/homebrew/bin`, which is the PATH a plugin would inherit on any
 * host that does not enrich it (an older or newer Paseo, a systemd unit, a
 * launchctl-managed daemon).
 * A `gh` installed by Homebrew — the way almost every macOS user installs it —
 * is invisible to a bare `$PATH` scan even though `gh --version` works fine in
 * the user's terminal. So each lookup probes a short list of well-known install
 * locations *in addition* to PATH, and PATH is consulted first so an explicit
 * user PATH always wins.
 *
 * Nothing here ever runs through a shell. `gh` is a shell *function* in some
 * users' zsh, so a shell spawn would run the function instead of the program;
 * resolving the executable ourselves and calling `execFile` with an argv array
 * guarantees we get the real binary and that no input can become shell syntax.
 */

/** Version/auth probes are cheap; nothing here may hang the bridge. */
const PROBE_TIMEOUT_MS = 5_000;
/** `gh auth status` talks to github.com, so it gets a longer, still bounded leash. */
const AUTH_TIMEOUT_MS = 8_000;
/** Long enough that repeated surface refreshes are free, short enough that
 *  installing gh and reopening the surface shows the new state. */
const SNAPSHOT_TTL_MS = 60_000;
const EXEC_TIMEOUT_MS = 5_000;

/**
 * Directories searched after `$PATH`. Deliberately short and boring: package
 * managers, not personal conventions.
 *
 *   /opt/homebrew/bin              Homebrew, Apple silicon
 *   /usr/local/bin                 Homebrew on Intel, and most `make install`
 *   /usr/bin, /bin                 system packages, Xcode git
 *   /opt/local/bin                 MacPorts
 *   ~/.local/bin                   pip/pipx and the XDG user convention
 *   /home/linuxbrew/.linuxbrew/bin Homebrew on Linux
 *   /snap/bin                      Ubuntu snaps (`snap install gh`)
 *   /usr/local/git/bin             the standalone macOS git installer
 */
function wellKnownBinDirs(): string[] {
  // Escape hatch, and the only way to switch the probe off. A user whose tools
  // live somewhere exotic (`~/bin`, a Nix profile) can point the plugin at it
  // without editing PATH for the whole Paseo app; the plugin's own test suite
  // uses it to simulate a machine with nothing installed. Replaces the list
  // below rather than adding to it, so it can express "nowhere".
  const override = process.env.SEND_TO_PASEO_BIN_DIRS;
  if (override !== undefined && override !== "") return override.split(delimiter);
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/local/bin",
    join(homedir(), ".local", "bin"),
    "/home/linuxbrew/.linuxbrew/bin",
    "/snap/bin",
    "/usr/local/git/bin",
  ];
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a real binary without a shell: an explicit override, then `$PATH`, then
 * the well-known install locations the daemon's PATH probably omits.
 *
 * `delimiter` rather than a literal ":" so the PATH split is correct on every
 * platform Node runs on.
 */
export async function resolveBinary(
  name: string,
  preferred: readonly string[],
): Promise<string | null> {
  for (const candidate of preferred) {
    if (candidate !== "" && (await isExecutable(candidate))) return candidate;
  }
  const searched = [
    ...(process.env.PATH ?? "").split(delimiter),
    // Only after PATH: an explicit user PATH must always win over our guesses.
    ...wellKnownBinDirs(),
  ];
  const seen = new Set<string>();
  for (const dir of searched) {
    if (dir === "" || !isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Releases the event-loop refs a child holds, handles and pipes alike. */
function unrefChild(child: {
  unref(): void;
  stdout: unknown;
  stderr: unknown;
  stdin: unknown;
}): void {
  child.unref();
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
}

export function runProcess(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    /**
     * Detach from the event loop. Used by the startup self-check only: it is
     * fire-and-forget, and a probe still in flight when Paseo says "Stopping
     * plugin" must not hold the subprocess open — that is the failure that
     * wedges `paseo plugin reload`.
     *
     * Measured, because it is not obvious: unref does NOT defeat the timeout.
     * While something else holds the loop open — the bridge's listening socket,
     * always, in the real plugin — a hung child is still killed at `timeoutMs`
     * and the promise still rejects (SIGTERM at 3004ms for a 3000ms timeout).
     * Only once nothing else keeps the process alive does the promise simply
     * never settle, which during teardown is exactly what we want.
     */
    unref?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        // No `shell`, so argv is passed straight to execve.
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        // Every spawn in this plugin is bounded: a hung `gh` must never hold an
        // HTTP request, and through it the bridge, open forever.
        timeout: options.timeoutMs ?? EXEC_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
    if (options.unref === true) unrefChild(child);
  });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const binaryCache = new Map<string, string | null>();

async function findBinary(name: string, override: string | undefined): Promise<string | null> {
  const cached = binaryCache.get(name);
  if (cached !== undefined) return cached;
  const found = await resolveBinary(name, [override ?? ""]);
  binaryCache.set(name, found);
  return found;
}

/** Absolute path to `git`, or null when it is not installed. Never throws. */
export function findGit(): Promise<string | null> {
  return findBinary("git", process.env.SEND_TO_PASEO_GIT_PATH);
}

/** Absolute path to `gh`, or null when it is not installed. Never throws. */
export function findGh(): Promise<string | null> {
  return findBinary("gh", process.env.SEND_TO_PASEO_GH_PATH);
}

/** Keeps `gh` non-interactive and machine-readable regardless of user config. */
export function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_PAGER: "cat",
    PAGER: "cat",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    CLICOLOR: "0",
    NO_COLOR: "1",
  };
}

// ---------------------------------------------------------------------------
// Install advice
// ---------------------------------------------------------------------------

const isMac = platform() === "darwin";

/** Bare commands, per CONTRACT.md: `hint` carries shell commands unquoted. */
export const INSTALL_HINT = {
  git: isMac
    ? "Install git: xcode-select --install"
    : "Install git: sudo apt install git (or your distribution's package manager)",
  gh: isMac
    ? "Install the GitHub CLI: brew install gh"
    : "Install the GitHub CLI: sudo apt install gh (see cli.github.com for other distributions)",
} as const;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type DependencyName = "git" | "gh";
export type DependencyState = "ok" | "degraded" | "missing";

export interface DependencyReport {
  name: DependencyName;
  /** False means the plugin still works without it, with reduced information. */
  required: boolean;
  state: DependencyState;
  path: string | null;
  version: string | null;
  /** One sentence: what is wrong, or what is lost. Empty when state is "ok". */
  detail: string;
  /** What the user should run. Empty when there is nothing to do. */
  hint: string;
}

export interface DependencySnapshot {
  at: number;
  /** The PATH this subprocess actually inherited. Logged once; it is the single
   *  most useful line when someone reports "but gh works in my terminal". */
  path: string;
  dependencies: DependencyReport[];
}

let snapshotCache: DependencySnapshot | null = null;
let snapshotInFlight: Promise<DependencySnapshot> | null = null;

/** First line of `--version` output, trimmed. */
function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

async function probeVersion(bin: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await runProcess(bin, args, { timeoutMs: PROBE_TIMEOUT_MS, unref: true });
    const line = firstLine(stdout);
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

async function reportGit(): Promise<DependencyReport> {
  const path = await findGit();
  if (path === null) {
    return {
      name: "git",
      required: true,
      state: "missing",
      path: null,
      version: null,
      detail:
        "git was not found. Paseo cannot create a worktree for a pull request without it, and workspace branches cannot be read.",
      hint: INSTALL_HINT.git,
    };
  }
  const version = await probeVersion(path, ["--version"]);
  if (version === null) {
    return {
      name: "git",
      required: true,
      state: "degraded",
      path,
      version: null,
      detail: `git was found at ${path} but did not run.`,
      hint: INSTALL_HINT.git,
    };
  }
  return { name: "git", required: true, state: "ok", path, version, detail: "", hint: "" };
}

/**
 * `gh auth status` exits non-zero when no account is logged in. It prints to
 * stderr, and it must never be logged verbatim — under some configurations it
 * echoes the token. Only the exit status is used here.
 */
async function ghAuthState(bin: string): Promise<"ok" | "unauthenticated"> {
  try {
    await runProcess(bin, ["auth", "status"], {
      timeoutMs: AUTH_TIMEOUT_MS,
      env: ghEnv(),
      unref: true,
    });
    return "ok";
  } catch {
    return "unauthenticated";
  }
}

async function reportGh(): Promise<DependencyReport> {
  const path = await findGh();
  if (path === null) {
    return {
      name: "gh",
      required: false,
      state: "missing",
      path: null,
      version: null,
      detail:
        "The GitHub CLI (gh) was not found. Sending still works: Paseo checks the PR out itself. Only the PR title, branch names and stack detection are unavailable.",
      hint: INSTALL_HINT.gh,
    };
  }
  const version = await probeVersion(path, ["--version"]);
  if (version === null) {
    return {
      name: "gh",
      required: false,
      state: "degraded",
      path,
      version: null,
      detail: `gh was found at ${path} but did not run. PR titles, branch names and stack detection are unavailable.`,
      hint: INSTALL_HINT.gh,
    };
  }
  const auth = await ghAuthState(path);
  if (auth === "unauthenticated") {
    return {
      name: "gh",
      required: false,
      state: "degraded",
      path,
      version,
      detail:
        "gh is installed but not signed in to GitHub. Sending still works; PR titles, branch names and stack detection are unavailable until it is.",
      hint: "Run: gh auth login",
    };
  }
  return { name: "gh", required: false, state: "ok", path, version, detail: "", hint: "" };
}

/**
 * Current dependency state, cached briefly. Safe to call from a request path:
 * a warm cache costs nothing and a cold one costs two `--version` calls and one
 * `gh auth status`, each with its own timeout.
 */
export async function dependencySnapshot(): Promise<DependencySnapshot> {
  const now = Date.now();
  if (snapshotCache !== null && now - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache;
  if (snapshotInFlight !== null) return snapshotInFlight;
  snapshotInFlight = (async () => {
    const dependencies = await Promise.all([reportGit(), reportGh()]);
    const snapshot: DependencySnapshot = {
      at: Date.now(),
      path: process.env.PATH ?? "",
      dependencies,
    };
    snapshotCache = snapshot;
    snapshotInFlight = null;
    return snapshot;
  })();
  return snapshotInFlight;
}

function describe(report: DependencyReport): string {
  if (report.state === "ok") {
    return `${report.name}: ok — ${report.version ?? "unknown version"} at ${report.path}`;
  }
  const role = report.required ? "REQUIRED" : "optional";
  const hint = report.hint === "" ? "" : ` ${report.hint}`;
  return `${report.name}: ${report.state} (${role}) — ${report.detail}${hint}`;
}

let selfCheckDone = false;

/**
 * Four lines at most, once per plugin start, to
 * `paseo plugin logs send-to-paseo` — the first place anyone debugging looks.
 * The PATH line is there because "gh works in my terminal but the plugin says
 * it is missing" is otherwise unanswerable.
 */
export async function logDependencySelfCheck(): Promise<void> {
  if (selfCheckDone) return;
  selfCheckDone = true;
  try {
    const snapshot = await dependencySnapshot();
    for (const report of snapshot.dependencies) {
      console.log(`[send-to-paseo] dependency ${describe(report)}`);
    }
    // Always logged, not only on failure: "but gh works in my terminal" is the
    // most likely support question, and this line and the resolved paths above
    // are the whole answer.
    console.log(`[send-to-paseo] plugin subprocess PATH=${snapshot.path}`);
  } catch (error) {
    console.error("[send-to-paseo] dependency self-check failed", String(error));
  }
}

export function clearDependencyCaches(): void {
  binaryCache.clear();
  snapshotCache = null;
}
