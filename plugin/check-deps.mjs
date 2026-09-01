/**
 * Dependency-degradation checks for the plugin's server modules.
 *
 *   cd plugin && node check-deps.mjs
 *
 * Runs the real `deps.server`, `gh.server`, `git.server` and `contracts.shared`
 * against a doctored `PATH` and against fake `gh` executables, so the answers to
 * "what happens with no gh?" and "what happens with an unauthenticated gh?" are
 * measured rather than reasoned about. It never touches the user's gh config,
 * never runs `gh auth logout`, and creates nothing outside a temp directory it
 * removes on the way out.
 *
 * Why .mjs and not part of the plugin: the plugin's own modules import
 * `@getpaseo/plugin/server`, which only exists inside the Paseo host. A resolve
 * hook below points that one specifier at a two-line stub, which is enough
 * because all this file exercises is `defineRpc`'s call signature.
 *
 * Node 24 strips the types from the imported `.ts` files, so there is no build
 * step. Requires Node >= 22.18 (or 23+) for that and for `registerHooks`.
 */

import { registerHooks } from "node:module";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* -- stub the one specifier only the Paseo host provides ------------------- */

const here = new URL(".", import.meta.url);
const stubUrl = new URL("./check-deps.stub.mjs", here).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@getpaseo/plugin/server") {
      return { url: stubUrl, shortCircuit: true };
    }
    // The plugin is compiled with `moduleResolution: "Bundler"`, so its own
    // imports are extensionless ("./contracts.shared"). Node's ESM resolver
    // needs the extension; the plugin host's bundler supplies it.
    // NB: the test is for a *known* extension, not for a dot — every module
    // here is named `something.shared` / `something.server`.
    if (specifier.startsWith(".") && !/\.(ts|tsx|mjs|cjs|js|json)$/i.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

await writeFile(
  new URL(stubUrl),
  "export const defineRpc = (contract) => contract;\nexport default { defineRpc };\n",
);

const deps = await import("./deps.server.ts");
const gh = await import("./gh.server.ts");
const git = await import("./git.server.ts");
const shared = await import("./contracts.shared.ts");

/* -- tiny harness ---------------------------------------------------------- */

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

const realPath = process.env.PATH ?? "";

/**
 * Runs `work` with `PATH` replaced and every binary/PR cache cleared.
 *
 * `binDirs` overrides the well-known-location probe. It has to be set for the
 * "nothing installed" cases: the whole point of that probe is that emptying
 * PATH is *not* enough to hide a Homebrew gh, which section 2 demonstrates.
 */
async function withPath(pathValue, work, binDirs) {
  process.env.PATH = pathValue;
  if (binDirs === undefined) delete process.env.SEND_TO_PASEO_BIN_DIRS;
  else process.env.SEND_TO_PASEO_BIN_DIRS = binDirs;
  deps.clearDependencyCaches();
  gh.clearPrCache();
  try {
    return await work();
  } finally {
    process.env.PATH = realPath;
    delete process.env.SEND_TO_PASEO_BIN_DIRS;
    deps.clearDependencyCaches();
    gh.clearPrCache();
  }
}

/** A directory guaranteed to contain nothing. */
const NOWHERE = "/nonexistent-send-to-paseo";

const REF = { forge: "github", owner: "acmegizmos", repo: "gizmo-poc", number: 942 };

/** A fake `gh` earlier on PATH than any real one. Never touches ~/.config/gh. */
async function fakeGh(dir, body) {
  const file = join(dir, "gh");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/**
 * Stands in for the bridge's listening socket.
 *
 * The self-check unrefs its child processes so a probe in flight cannot wedge
 * plugin teardown, which means nothing here keeps the event loop alive by
 * itself; Node would exit mid-probe with "unsettled top-level await". In the
 * real plugin the HTTP listener does this job, and the spawn timeouts fire
 * normally as a result — section 8 measures exactly that.
 */
const keepalive = setInterval(() => {}, 500);

const temp = await mkdtemp(join(tmpdir(), "send-to-paseo-deps-"));

/** A scratch directory inside the one temp root this script cleans up. */
async function makeDir(name) {
  const dir = join(temp, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

try {
  /* -------------------------------------------------------------------- */
  console.log("\n1. the PATH a Paseo plugin subprocess actually gets");
  console.log(`  interactive PATH        ${realPath}`);
  console.log(`  git resolves to         ${await deps.findGit()}`);
  console.log(`  gh  resolves to         ${await deps.findGh()}`);

  /* -------------------------------------------------------------------- */
  console.log(
    "\n2. launchd PATH (what /Applications/Paseo.app itself has: no /opt/homebrew/bin)",
  );
  const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin";
  await withPath(LAUNCHD_PATH, async () => {
    const foundGh = await deps.findGh();
    const foundGit = await deps.findGit();
    console.log(`  gh  resolves to         ${foundGh}`);
    console.log(`  git resolves to         ${foundGit}`);
    check(
      "gh is still found without /opt/homebrew/bin on PATH",
      foundGh !== null,
      "the well-known-location probe is what makes this work",
    );
    check("git is still found", foundGit !== null);
  });

  /* -------------------------------------------------------------------- */
  console.log("\n3. gh not installed at all (empty PATH, probe switched off)");
  await withPath(NOWHERE, async () => {
    const foundGh = await deps.findGh();
    check("findGh returns null", foundGh === null, String(foundGh));

    const snapshot = await deps.dependencySnapshot();
    const ghReport = snapshot.dependencies.find((d) => d.name === "gh");
    console.log(`  report   ${JSON.stringify(ghReport)}`);
    check("gh is reported optional", ghReport.required === false);
    check("gh state is missing", ghReport.state === "missing", ghReport.state);
    check("detail says sending still works", ghReport.detail.includes("Sending still works"));
    check("hint is an install command", ghReport.hint.includes("gh"));

    const { pr, outage } = await gh.lookupPr(REF);
    console.log(`  outage   ${JSON.stringify(outage)}`);
    console.log(`  pr       ${JSON.stringify(pr)}`);
    check("lookupPr degrades instead of throwing", outage !== null);
    check("outage kind is missing", outage.kind === "missing", outage.kind);
    check("message names gh", outage.message.includes("(gh)"));
    check("short label is picker-sized", outage.short === "gh not installed", outage.short);
    check("url is still correct", pr.url === `https://github.com/${REF.owner}/${REF.repo}/pull/942`);
    check("head branch is empty, not guessed", pr.headBranch === "");

    const prompt = shared.composePrompt({
      ref: REF,
      pr,
      prompt: "Fix the merge conflicts",
      workspaceBranch: "giz-1132-retire-legacy-cache-flag",
      // Byte-for-byte what send.server's promptNote() builds.
      prMetadataNote: `Note: the pull request title and branch names are missing from this header because ${outage.short}. Read them from the PR URL above if you need them.`,
    });
    console.log(`  --- composed prompt ---\n${prompt}\n  -----------------------`);
    check("prompt omits the Title: line", !prompt.includes("Title:"));
    check("prompt omits the Branch: line", !prompt.includes("Branch: "));
    check("prompt keeps the PR: line", prompt.includes("PR: https://github.com/"));
    check("prompt explains the gap", prompt.includes("not installed"));
    check(
      "prompt makes no claim about the PR's branch",
      !prompt.includes("NOT this PR's branch"),
      "without gh nothing knows the PR's branch",
    );

    // git missing is fatal for a worktree, and the message has to say so.
    let gitError = null;
    try {
      await git.requireGit();
    } catch (error) {
      gitError = error;
    }
    console.log(`  git      ${gitError?.code} / ${gitError?.message} / ${gitError?.hint}`);
    check("requireGit throws with git missing", gitError !== null);
    check("code is a documented one", gitError.code === "workspace_create_failed");
    check("message names git", gitError.message.startsWith("git was not found"));
    check("hint is an install command", gitError.hint.includes("git"));
  }, NOWHERE);

  /* -------------------------------------------------------------------- */
  console.log("\n4. gh installed but not signed in (fake gh, exit 4)");
  const authDir = await makeDir("unauth");
  await fakeGh(
    authDir,
    // A real unauthenticated gh still reports its version; only calls that need
    // a credential fail, with exit 4.
    'if [ "$1" = "--version" ]; then echo "gh version 2.98.0 (2026-08-20)"; exit 0; fi\n' +
      'echo "gh: To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4',
  );
  await withPath(authDir, async () => {
    const snapshot = await deps.dependencySnapshot();
    const ghReport = snapshot.dependencies.find((d) => d.name === "gh");
    console.log(`  report   ${JSON.stringify(ghReport)}`);
    check("gh is found", ghReport.path !== null);
    check("version is still read", ghReport.version !== null, String(ghReport.version));
    check("state is degraded, not missing", ghReport.state === "degraded", ghReport.state);
    check("detail says not signed in", ghReport.detail.includes("not signed in"), ghReport.detail);
    check("hint is the exact fix", ghReport.hint === "Run: gh auth login", ghReport.hint);

    const { outage } = await gh.lookupPr(REF);
    console.log(`  outage   ${JSON.stringify(outage)}`);
    check("degrades rather than throwing", outage !== null);
    check("kind is unauthenticated", outage.kind === "unauthenticated", outage.kind);
    check("hint is the exact fix", outage.hint === "Run: gh auth login", outage.hint);
    check(
      "message is distinct from not-installed",
      outage.message.includes("not signed in"),
      outage.message,
    );
  });

  /* -------------------------------------------------------------------- */
  console.log("\n5. gh present, github.com unreachable (fake gh, DNS failure)");
  const netDir = await makeDir("net");
  await fakeGh(
    netDir,
    'echo "error connecting to api.github.com: dial tcp: lookup api.github.com: no such host" >&2\nexit 1',
  );
  await withPath(netDir, async () => {
    const { outage } = await gh.lookupPr(REF);
    console.log(`  outage   ${JSON.stringify(outage)}`);
    check("degrades rather than throwing", outage !== null);
    check("kind is network", outage.kind === "network", outage.kind);
    check("does not read as not-installed", !outage.message.includes("not installed"));
  });

  /* -------------------------------------------------------------------- */
  console.log("\n6. gh present, repository invisible to it (fake gh, GraphQL 404)");
  const repoDir = await makeDir("repo");
  await fakeGh(
    repoDir,
    "echo 'GraphQL: Could not resolve to a Repository with the name \\'acmegizmos/gizmo-poc\\'. (repository)' >&2\nexit 1",
  );
  await withPath(repoDir, async () => {
    const { outage } = await gh.lookupPr(REF);
    console.log(`  outage   ${JSON.stringify(outage)}`);
    check("degrades rather than throwing", outage !== null);
    check("kind is no_repo_access", outage.kind === "no_repo_access", outage.kind);
    check("hint points at gh auth status", outage.hint.includes("gh auth status"));
  });

  /* -------------------------------------------------------------------- */
  console.log("\n7. gh present, the PR number does not exist (the one hard error)");
  const prDir = await makeDir("pr");
  await fakeGh(
    prDir,
    "echo 'GraphQL: Could not resolve to a PullRequest with the number of 942. (repository.pullRequest)' >&2\nexit 1",
  );
  await withPath(prDir, async () => {
    let thrown = null;
    try {
      await gh.lookupPr(REF);
    } catch (error) {
      thrown = error;
    }
    console.log(`  thrown   ${thrown?.code} / ${thrown?.message}`);
    check("this one does NOT degrade", thrown !== null);
    check("code is pr_not_found", thrown.code === "pr_not_found", thrown?.code);
    check("message names the PR", thrown.message.includes("#942"));
  });

  /* -------------------------------------------------------------------- */
  console.log("\n8. every spawn is bounded (a hung gh must not hold the bridge)");
  const hangDir = await makeDir("hang");
  // /bin/sleep, absolutely: PATH is about to be this directory only, so a bare
  // `sleep` would just be "command not found" and prove nothing.
  await fakeGh(hangDir, "/bin/sleep 60");
  await withPath(hangDir, async () => {
    const started = Date.now();
    const snapshot = await deps.dependencySnapshot();
    const elapsed = Date.now() - started;
    const ghReport = snapshot.dependencies.find((d) => d.name === "gh");
    console.log(`  snapshot took ${elapsed}ms, gh state ${ghReport.state}`);
    check("the hung probe was killed, not waited on", elapsed >= 4_000 && elapsed < 20_000, `${elapsed}ms`);
    check("gh is reported unusable", ghReport.state !== "ok", ghReport.state);
    check("detail says it did not run", ghReport.detail.includes("did not run"), ghReport.detail);
  });
  /* -------------------------------------------------------------------- */
  console.log("\n9. the surface payload validates against its own RPC schema");
  {
    const snapshot = await deps.dependencySnapshot();
    const parsed = shared.DependencyReportSchema.array().safeParse(snapshot.dependencies);
    console.log(`  parsed   ${parsed.success ? "ok" : JSON.stringify(parsed.error?.issues)}`);
    check("dependencies match DependencyReportSchema", parsed.success);
    check("both dependencies are reported", snapshot.dependencies.length === 2);
  }
} finally {
  clearInterval(keepalive);
  await rm(temp, { recursive: true, force: true });
  await rm(new URL(stubUrl), { force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
