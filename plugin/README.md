# send-to-paseo

A Paseo plugin that runs a small local HTTP bridge so a browser extension can
say "start an agent on this pull request" and have it happen in the workspace
that actually belongs to that PR — creating a worktree checked out to the PR if
none exists.

The extension never talks to the Paseo daemon. It talks only to this bridge,
which speaks the frozen API in [`../CONTRACT.md`](../CONTRACT.md) and reaches
Paseo through the supported SDK.

- Bridge: `http://127.0.0.1:7788`, loopback only, bearer token required.
- Surface: **Send to Paseo** in the Paseo sidebar — status, token, default model,
  recent sends.
- Verified behaviour, with real command output:
  [`VERIFICATION.md`](VERIFICATION.md).

---

## Requirements

Two external commands, one required and one optional. **Nothing here is fatal
except `git`** — with no `gh` at all you can still open the popover, pick a
workspace and start an agent, because Paseo checks the pull request out itself
through its own forge credentials. `gh` only supplies metadata.

| | Required? | Minimum verified | What it is used for | What breaks without it |
| --- | --- | --- | --- | --- |
| **Paseo** | yes | `0.7.0` | Everything. The plugin borrows the host's `@getpaseo/client` at runtime. | The plugin does not load. |
| **`git`** | yes | `2.51.2` | Reading the branch a workspace is on, and the repository's `origin`. Paseo itself needs it to create a worktree. | Creating a worktree fails with a message naming `git`. Workspace branches read as unknown, so nothing is ranked as an exact or stack match — everything falls back to "create". |
| **`gh`** | **no** | `2.98.0` | PR title, head and base branch names, and stack discovery (`gh pr list` rebuilds the whole Graphite stack, including its merged and closed members). | Sending still works. You lose the PR title, the branch names, exact/stack candidate ranking, and the `Title:`/`Branch:` lines in the agent's prompt. Stack detection is lost **entirely**, local git ancestry included: that check proves "this branch is an ancestor of a branch in the stack", and without `gh` there is no stack and no PR head branch to compare against. The bridge says so in the target picker, in the agent's prompt and in the log. |

Node is not a separate requirement: the plugin runs inside the Paseo daemon's
own Node runtime.

### Install commands

```sh
# macOS
xcode-select --install       # git
brew install gh              # optional

# Debian / Ubuntu
sudo apt install git
sudo apt install gh          # optional; see cli.github.com for other distros

# Fedora / RHEL
sudo dnf install git
sudo dnf install gh          # optional
```

Then, if you installed `gh`:

```sh
gh auth login                # optional, but this is what makes titles and stacks work
gh auth status               # should print the account and no error
```

### Where the plugin looks for them

This matters more than it sounds. A Paseo plugin runs in a daemon subprocess,
and the daemon is normally started by the desktop app rather than by your shell.
`/Applications/Paseo.app` itself is launched with

```
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin
```

— no `/opt/homebrew/bin`. Paseo does enrich `PATH` for plugin subprocesses in
`0.7.0` (measured: the subprocess got the full login `PATH`), but the plugin does
not rely on that. Every lookup searches, in order:

1. `SEND_TO_PASEO_GH_PATH` / `SEND_TO_PASEO_GIT_PATH`, if set;
2. every directory on the subprocess's `PATH`;
3. a short list of well-known install locations — `/opt/homebrew/bin`,
   `/usr/local/bin`, `/usr/bin`, `/bin`, `/opt/local/bin`, `~/.local/bin`,
   `/home/linuxbrew/.linuxbrew/bin`, `/snap/bin`, `/usr/local/git/bin`.

Set `SEND_TO_PASEO_BIN_DIRS` to replace step 3 with your own colon-separated
list if your tools live somewhere else entirely.

Nothing is ever spawned through a shell. `gh` is a shell *function* in some
people's `zsh`, so the plugin resolves the executable itself and calls it with an
argv array.

### Dependency self-check

Every plugin start logs one line per command, plus the `PATH` it actually got:

```
[send-to-paseo] dependency git: ok — git version 2.51.2 at /opt/homebrew/bin/git
[send-to-paseo] dependency gh: ok — gh version 2.98.0 (2026-08-20) at /opt/homebrew/bin/gh
[send-to-paseo] plugin subprocess PATH=~/.local/bin:...:/opt/homebrew/bin:...
```

```sh
paseo plugin logs send-to-paseo
```

The same information is on the **Requirements** card in the Paseo surface, which
is the place to look first if you have never opened a log file.

---

## Install

Plugins are trusted, unsandboxed code: this one runs an HTTP server that can
start agents which execute arbitrary code on the daemon machine. Read the source
before installing it.

One command, straight from the public repository. No clone, no `npm install`, no
build step:

```sh
paseo plugin add tomgrin10/send-to-paseo --path plugin
paseo plugin ls          # expect: send-to-paseo  running  yes
paseo plugin logs send-to-paseo
```

`paseo plugin add` clones the repo into `~/.paseo/plugins/`, compiles the plugin
itself, and starts it. `--path plugin` points it at this directory inside the
repo; `--ref <branch|tag|commit>` pins a revision. `pluginsEnabled` must already
be `true` in the daemon's `config.json`.

There is nothing to install because the plugin imports nothing at runtime that
the Paseo host does not already provide — see
[No runtime dependencies, ever](#no-runtime-dependencies-ever). To upgrade later,
re-run `paseo plugin add` (or `paseo plugin reload send-to-paseo` for a checkout).

### From a checkout (contributors)

Installing from a directory is the loop to use while editing, because
`paseo plugin reload` picks up changes in place:

```sh
git clone https://github.com/tomgrin10/send-to-paseo.git
cd send-to-paseo/plugin
npm install              # devDependencies only — for `npm run typecheck`
npm run typecheck
paseo plugin add /absolute/path/to/send-to-paseo/plugin
paseo plugin ls          # expect: send-to-paseo  running  yes
```

After editing the source:

```sh
npm run typecheck
paseo plugin reload send-to-paseo
```

Never restart the daemon to pick up plugin changes — that kills running agents.

### No runtime dependencies, ever

`paseo plugin add` compiles the plugin **with no packages installed** — there is
no `npm install` step in that path, and the daemon's bundler can only resolve the
specifiers the host provides at runtime:

```
@getpaseo/plugin   @getpaseo/plugin/server   @getpaseo/plugin/react-native
zod   react   react/jsx-runtime   react-native   @tanstack/react-query
node:*  (built-ins, in the server bundle)
```

Everything in `plugin/package.json` is therefore a **devDependency**, present only
so `npm run typecheck` works for contributors.

> **Nothing may be added to `dependencies`.** A runtime import of anything outside
> the list above fails `paseo plugin add` for every user with
> `Build failed: Could not resolve "<pkg>"`, while still working perfectly on any
> machine that has run `npm install` — so it will not be caught locally. Imports
> from `@getpaseo/client` and `@getpaseo/protocol` must stay `import type` (erased
> at build time) or be reimplemented locally; the one runtime use of the Paseo SDK
> goes through the assembled-specifier `require` in `daemon.server.ts`, precisely
> so the bundler cannot see it. Before changing an import, read
> [`VERIFICATION.md`](VERIFICATION.md) §18, which includes the exact
> no-`node_modules` build command that proves an install still works.

### Pairing

1. Open **Send to Paseo** in the Paseo sidebar.
2. Under **Pairing token**, press **Copy** (or **Reveal** and copy by hand).
3. Paste it into the extension's options page along with the bridge URL.

**Regenerate** issues a new token and immediately invalidates the old one, so any
paired extension has to be re-paired.

---

## Configuration

All of it lives in the Paseo surface; there is no config file to hunt for.

| Setting | Default | Notes |
| --- | --- | --- |
| Port | `7788` | Saving rebinds the listener straight away. Bind address is always `127.0.0.1`. |
| Pairing token | generated on first run | 32 random bytes, base64url. |
| Default model | the daemon's own default | `provider/model`, e.g. `claude/claude-opus-5`. A send may override it per request. |
| Agent profile | none | One of your saved Paseo profiles (`daemon.agentProfiles`), followed by id. |
| Default permission mode | follow Paseo | A mode id, e.g. `auto`. Mode ids are per provider. |

State is stored at `$PASEO_HOME/plugin-data/send-to-paseo/settings.json`, written
`0600` inside a `0700` directory. It holds the token, the port, the default
model, the followed profile id, the default mode, the paired flag, the last 20
sends, and an optional `allowedExtensionIds` list (see
[Security model](#security-model)).

`defaultProfileId` and `defaultModeId` are read with a schema default of `null`,
so a `settings.json` written before permission modes existed still validates. That
matters more than it looks: a failed parse regenerates the file, and the file holds
the pairing token — an upgrade must not silently unpair the extension.

### Permission mode, and the profile it can come from

The plugin used to send `config: { provider }` and nothing else, which made
Claude's provider fall back to `modeId: "default"` — the app's **"Always Ask"** —
so every agent it started came up in the strictest mode no matter what the user's
own default was.

Now the mode is resolved on every send, in this order, with **every candidate
validated against the chosen provider's advertised modes** before it is accepted:

1. `modeId` on the `/v1/send` request (the popover's explicit choice);
2. the `modeId` of the followed Paseo agent profile;
3. the plugin's own **Default permission mode** setting;
4. the chosen provider's `defaultModeId` from the daemon;
5. nothing — the field is omitted and Paseo applies its own default.

A candidate the provider does not advertise is skipped, logged, and the chain
continues:

```
[send-to-paseo] mode "bypassPermissions" from the plugin's default mode setting
is not offered by codex; trying the next option
```

That is deliberate: mode ids belong to a provider (`bypassPermissions` is Claude's,
`full-access` is Codex's), so a stored id becomes meaningless the moment the user
picks a different provider. A stale id must cost the send its preferred mode, not
the send. The same holds for a profile that has been deleted in Paseo — it is
ignored with a log line, and the send goes through.

**Profiles are followed live, by id.** There is no `profile` parameter on agent
creation; applying a profile is a field-by-field copy. So the plugin stores only
the id and re-reads `provider`, `model`, `modeId` and `thinkingOptionId` on every
send. Edit the profile in Paseo and the next send follows it — there is nothing to
re-copy here.

Two precedence rules worth stating outright:

- **An explicit `provider` on the request always beats the profile's provider.**
  Picking "Codex" in the popover is a visible choice and is never silently
  overridden by a profile that names Claude.
- **`thinkingOptionId` is copied from the profile only when the send actually
  landed on that profile's own `provider/model`.** Thinking options are per model,
  so carrying one across a model change would be a guess.

### Environment

| Variable | Effect |
| --- | --- |
| `SEND_TO_PASEO_DRY_RUN=1` | `POST /v1/send` resolves and validates everything but creates nothing, returning the same `200` shape with `"dryRun": true` and synthetic ids. |
| `SEND_TO_PASEO_GH_PATH` | Absolute path to the `gh` binary, if it is somewhere unusual. Checked before `PATH`. |
| `SEND_TO_PASEO_GIT_PATH` | Same for `git`. |
| `SEND_TO_PASEO_BIN_DIRS` | Colon-separated directories that **replace** the built-in well-known-location list (see [Requirements](#where-the-plugin-looks-for-them)). Set it to a nonexistent path to switch the probe off entirely, which is how `check-deps.mjs` simulates a machine with nothing installed. |
| `PASEO_HOME`, `PASEO_DAEMON_URL` | Standard Paseo variables; both are honoured. |

The plugin subprocess inherits the daemon's environment, so `SEND_TO_PASEO_DRY_RUN`
has to be exported for the daemon, which means it only takes effect at the next
daemon start.

### If the port is taken

The bridge does not start, the reason lands in the surface's status line and in
`paseo plugin logs send-to-paseo`, and the rest of the plugin keeps working:

```
[send-to-paseo] Port 7788 is already in use, so the Send to Paseo bridge did not
start. Pick another port in Paseo -> Send to Paseo.
```

Note that `test/mock-bridge.mjs` in this repository uses port **7799**; don't
configure the bridge onto it.

---

## Troubleshooting

Keyed on the text you will actually see — in the extension's popover, on the
**Requirements** card, or in `paseo plugin logs send-to-paseo`.

| What you see | What it means | Fix |
| --- | --- | --- |
| Target picker reads `Create worktree for PR #942 (gh not installed)` | `gh` is not on this machine. Sending still works; the title and branches are missing. | `brew install gh`, then `paseo plugin reload send-to-paseo` |
| Target picker reads `… (gh not signed in — run gh auth login)` | `gh` is installed but has no GitHub credential. | `gh auth login` |
| Target picker reads `… (gh cannot see this repo)` | `gh`'s account has no access to the repository — private repo, or SAML not authorised. Paseo may still have access, so the send is not blocked. | `gh auth status`, then authorise the org or switch account |
| Target picker reads `… (github.com unreachable)` | No route to github.com from the daemon machine. | Check the network or the proxy, then reopen the popover |
| No PR title anywhere, everything ranks as "same project" | Any of the above. | Check the **Requirements** card in the Paseo surface |
| A workspace on a **merged** stack branch still ranks as "same project" | Either the merged PR fell outside the 200 most recent merged/closed PRs (the log says so), or the branch is already contained in trunk — a true merge commit — and the trunk guard declined it. See "Merged and closed branches" below. | Nothing to fix; pick the workspace manually. The create option is still correct |
| `git was not found on this machine, and Paseo needs it to check a pull request out into a worktree.` | Genuinely fatal for the create path. | `xcode-select --install`, or `sudo apt install git` |
| `Pull request acmegizmos/gizmo-poc#942 does not exist on GitHub.` | `gh` read the repository fine and there is no such PR. This is the one `gh` answer that is an error rather than a degradation. | Check the number |
| `acmegizmos/gizmo-poc is not a project in Paseo.` | Paseo has no project for this repository. | `paseo project add /path/to/repo` |
| `The Paseo daemon is not reachable from the plugin.` | The plugin is up but the daemon socket is not answering. | Start Paseo, or `paseo daemon start` |
| `The GitHub CLI (gh) did not answer in time…` | A `gh` call hit its timeout (15 s for a PR read, 12 s for either stack list, 8 s for `gh repo view`). | Retry; if it persists, check `gh auth status` and the network |
| `dependency gh: missing (optional)` in the log, but `gh` works in your terminal | The daemon's `PATH` and your shell's `PATH` differ, and `gh` is installed somewhere the well-known list does not cover. | Compare against the `plugin subprocess PATH=` line in the same log, then set `SEND_TO_PASEO_GH_PATH` |
| `Port 7788 is already in use…` | Something else has the port. | Change the port on the surface |

Reproduce any of the dependency cases without touching your real setup:

```sh
cd plugin && node check-deps.mjs
```

It doctors `PATH`, builds fake `gh` executables in a temp directory, and asserts
the resulting messages. It never reads or writes `~/.config/gh`.

---

## Endpoints

Full request and response schemas, error codes and CORS rules are in
[`../CONTRACT.md`](../CONTRACT.md), which is frozen. This is the summary.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/ping` | optional | Health, version, daemon reachability. With a valid token it also validates that token and returns the provider and mode lists. |
| `POST` | `/v1/resolve` | bearer | PR metadata, the Paseo project, ranked workspace candidates, provider list, mode list and the resolved mode. Creates nothing. |
| `POST` | `/v1/send` | bearer | Ensures the workspace and starts a **new** agent. The only mutating endpoint. |

`/v1/ping` is the only endpoint where auth is optional, and it is not ignored:

| `Authorization` | Response |
| --- | --- |
| absent | `200`, `paired: false`, `providers: []`, `modes: []` — the liveness check, so the options page can tell "bridge down" from "bad token" |
| present and valid | `200`, `paired: true`, the full `providers` and `modes` lists (same payload as `/v1/resolve`) |
| present and invalid | `401 unauthorized` |

That is what lets the extension's options page actually validate a pasted token and populate
its default-model picker without needing a PR. The `forbidden_origin` and `forbidden_host`
checks apply to `/v1/ping` too, so it is not a bypass.

```sh
TOKEN=...   # from the Paseo surface

curl -s http://127.0.0.1:7788/v1/ping

curl -s -X POST http://127.0.0.1:7788/v1/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,
       "stackPrNumbers":[948,947]}'

curl -s -X POST http://127.0.0.1:7788/v1/send \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,
       "prompt":"Fix merge conflicts","target":{"kind":"create"},
       "modeId":"auto"}'
```

`/v1/resolve` reports the mode a send would actually use, so the popover can
preselect what will happen rather than guess:

```sh
$ curl -s -X POST http://127.0.0.1:7788/v1/resolve \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942}' \
  | jq '{resolvedModeId, modes: (.modes | map(select(.provider=="claude")) | map(.id))}'
{
  "resolvedModeId": "auto",
  "modes": ["plan", "default", "acceptEdits", "auto", "bypassPermissions"]
}
```

### The resolution ladder

`/v1/resolve` walks exactly the ladder CONTRACT.md specifies.

1. **`owner/repo` → Paseo project.** `remote:github.com/{owner}/{repo}` is the
   fast path. Otherwise a project whose `origin` remote parses to the same
   repository wins, which covers SSH remotes and renamed repos. No match →
   `404 project_not_found`.
2. **PR number → head branch**, via `gh pr view --json
   number,title,headRefName,baseRefName,state,url`. Cached for 60 s.

   **Degrades, never fails.** If `gh` is missing, unauthenticated, blocked from
   the repository, offline or slow, the bridge substitutes a placeholder — the
   number and the canonical URL, with `headBranch` and `baseBranch` left *empty
   rather than guessed* — records why, and carries on. Steps 3 and 5 then have
   nothing to match on, so every workspace ranks 3 and the default becomes
   "create a worktree", which is exactly right: Paseo checks the PR out from its
   number through `checkoutSource: { kind: "change_request" }` and never calls
   `gh`. The reason is visible in the create candidate's label, in the agent's
   opening prompt, and in `paseo plugin logs send-to-paseo`.

   The single exception is a `gh` that successfully reports the pull request does
   not exist: that is a real answer, so it is a real `404 pr_not_found`.
3. **The stack → its branches**, from GitHub itself. A Graphite stack is a real
   `base` → `head` chain: PR #943's `baseRefName` *is* PR #942's `headRefName`.
   So one `gh pr list --state open --json number,headRefName,baseRefName` (60 s
   cache) rebuilds the repo's PR graph, and a breadth-first walk from this PR
   gives the whole stack in both directions — downstack ancestors and upstack
   descendants — plus the hop distance to each.

   This replaced trusting the `stackPrNumbers` the extension scraped from the
   page. Graphite's stack panel collapses long stacks ("3 of 9, 2 hidden"), so a
   scrape could silently omit the very sibling the user's workspace was on.
   Those numbers are still honoured for members the graph did not find — a
   closed or merged stack PR — which is normally none and costs nothing. On
   github.com the extension deliberately sends `[]`, so there are no hints at
   all there.

   Strictly best-effort throughout: a failed lookup is logged and drops the
   rank-2 entries; it never fails the request.

   **Merged and closed branches (added 2026-09-02).** A workspace parked on a
   branch whose PR has merged is still a workspace in that stack, and the
   open-PR graph cannot see it at all. Two more passes cover it, each reached
   only when the previous one left a project workspace unexplained *and* nothing
   already matched — an exact branch match or an open sibling settles the
   default, and a merged branch can never outrank either, so paying for the
   wider lookups then would change nothing. Measured against the live bridge on
   a 38-workspace project: 0.94s for a PR whose stack already had an open
   sibling workspace, 1.6s for a PR that matched nothing at all, 0.01s once the
   lists are cached.

   - **Pass 2 — merged and closed PRs.** One more `gh pr list --state closed`
     (200 rows, 5-minute cache). One call, not two: GitHub treats a merged PR as
     closed, so `--state closed` returns MERGED rows as well, and each row's own
     `state` field separates them. This recognises a workspace sitting directly
     on a merged stack branch and reconnects a chain whose merged head branch
     still exists. An open PR always wins over a merged one for the same head
     branch. The 200-row cap is logged when hit, because on a busy repository
     the symptom of truncation — an older merged stack branch going unrecognised
     — is otherwise indistinguishable from the feature not working.
   - **Pass 3 — local git ancestry, read-only, no network.** When the bottom PR
     of a stack merges *and* its head branch is deleted, GitHub retargets the
     child's base to trunk and the `base` → `head` edge that joined them is gone
     from GitHub's data entirely — no widening of `gh pr list` can rebuild it.
     The commits can: a stack branch below this PR is by definition an ancestor
     of it, so `git branch -a --contains <branch>` in the project root,
     intersected with the stack's branches (and their `origin/` forms), answers
     the question offline. It can even recognise a stack branch that has no PR
     at all, in which case the candidate carries no `stackPrNumber`.

     **A trunk guard is mandatory here, not optional.** Every branch ever merged
     into trunk is an ancestor of every branch cut from trunk since, so without
     a guard a workspace parked on trunk — or on a branch merged a year ago —
     would become a rank-2 stack candidate for *every* PR in the repository. A
     branch already contained in trunk is therefore rejected, which leaves
     exactly the branches carrying commits trunk does not have: a squash- or
     rebase-merged stack branch whose child has not been restacked yet, and a
     stack branch with no PR. Trunk itself comes from
     `refs/remotes/origin/HEAD` (free, offline; present in 2 of 3 git projects
     measured on the development machine) and falls back to `gh repo view`. With
     no trunk name at all, pass 3 is skipped and says so in the log.

     The cost of the guard is the true-merge-commit case: such a branch *is* an
     ancestor of trunk and is indistinguishable from any other long-merged
     branch, so pass 2 has to carry it — and does, whenever the head branch
     still exists so the `base` → `head` edge survives. The combination "true
     merge commit AND head branch deleted AND child retargeted" is covered by
     neither, and falls back to the old behaviour: rank 3, default "create".

   Widening also breaks an assumption the open-only graph could rely on. Trunk
   cannot be a false edge among open PRs, because an edge requires one PR's base
   to be another PR's *head* and nobody opens a PR whose head is `main`.
   Merged PRs are different: measured in the public `vercel/turborepo`
   repository, PR #13875 is MERGED with `headRefName: "main"` — a release
   back-merge — and 13 open PRs are based on `main`, so admitting that one row
   would fuse them all into a single false "stack". Two guards reject it: the
   trunk name, and a fan-out backstop (a non-open head that four or more PRs are
   based on). Both were measured to leave that PR with zero stack members.
   Only non-open rows are filtered, so the open-PR behaviour is unchanged.

   **Not `gt`.** The Graphite CLI answers "what is *my current* stack" from
   local, per-worktree metadata relative to whatever branch is checked out where
   it runs. This endpoint runs while the user is typing in a browser and must not
   depend on, or disturb, any worktree — least of all the candidate workspaces,
   each on its own branch. `gh` is read-only, needs no second credential, and is
   optional — without it the only casualty is stack detection.
4. **Project workspaces → branches.** The branch normally comes free from the
   daemon's own workspace descriptor (`gitRuntime.currentBranch`). When that is
   missing, `git -C <cwd> rev-parse --abbrev-ref HEAD` fills the gap, cached
   against the mtime of the worktree's own `HEAD` file — the one inside
   `.git/worktrees/<name>`, not the main repository's.
5. **Rank.**

   | rank | reason | meaning |
   | --- | --- | --- |
   | 1 | `exact` | workspace HEAD == the PR head branch |
   | 2 | `stack` | workspace HEAD is another branch in this stack, whatever its own PR's state; carries `stackPrNumber` and, when that PR is not open, `stackPrState` |
   | 3 | `project` | any other workspace in the project |
   | 4 | `create` | the synthetic "create a worktree for this PR" option |

   Candidates come back sorted ascending by rank and always include the `create`
   entry. Rank-2 entries are ordered by PR state first — open before merged
   before closed before "no PR at all" — then by hop distance, then by
   `stackPrNumber`. State outranks distance because a live sibling is somewhere
   work is still happening while a merged branch is history the stack has been
   restacked past. Distances measured from GitHub's graph beat ones it could not
   measure, and both beat membership inferred from local ancestry; each has its
   own named constant so the three can never sort as one.

   `defaultCandidateIndex` points at the rank-1 exact match, else the best
   rank-2 stack match, else `create` — and is always a valid index, because
   `candidates` always ends with the `create` entry. Rank 3 is never a default —
   an unrelated workspace is a worse guess than a fresh worktree. Preferring
   rank 2 supports one workspace per *stack*: opening PR #4 while the worktree
   sits on PR #7's branch resolves to that workspace instead of proposing a
   second checkout. That now holds when PR #7 has already merged, which is the
   case that used to fall through to "create".

   The extension always shows the picker and requires an explicit send; nothing
   is ever created silently, whatever the default is.

### Sending

When the chosen workspace is on a branch other than the PR's head branch, the
composed prompt says so explicitly and names the PR branch to check out. Silence
would leave the agent believing it is on the PR branch — and committing there.
When that branch's own pull request is merged or closed, the wording says that
too: "a different branch of the same stack" reads as a live sibling, and a merged
branch is behind by construction. Establishing the state reuses the resolve
path's caches, so it is normally a cache read rather than a `gh` call, and a null
answer just keeps the generic wording.

`target: {kind:"existing"}` starts the agent through that workspace's own handle,
so it joins that workspace record rather than being given a fresh one for the
same directory.

`target: {kind:"create"}` asks Paseo for a worktree checked out to the PR — the
same request `paseo workspace create --isolation worktree --mode checkout-pr
--pr-number N --forge github --project <id>` sends:

```ts
paseo.workspaces.create({
  title: `PR #942: ...`,
  source: {
    kind: "worktree",
    projectId,
    action: "checkout",
    checkoutSource: { kind: "change_request", forge: "github", number: 942 },
  },
});
```

> **The local branch name can differ from the PR head branch.** If a local branch
> of that name already exists, Paseo's `checkout-pr` creates a uniquely-named
> local branch (`…-rule-1`) tracking `origin/<PR head branch>`. The commit and
> upstream are the PR's, so the workspace does contain the PR. `/v1/send`
> reports the branch actually checked out, which is the truthful value to
> display.

Every send creates a brand new agent — never reuses or messages an existing one:

- `title`: `PR #942 · <first line of the message, ≤60 chars>`
- `labels`: `send-to-paseo/pr = "github:owner/repo#942"` and
  `send-to-paseo/origin = "graphite"`
- `prompt`: the CONTRACT.md context header, then a blank line, then the user's
  text verbatim
- `deepLink`: built with `buildAgentDeepLink` from
  `@getpaseo/protocol/agent-deep-link`, giving
  `paseo://h/<serverId>/agent/<agentId>`. `serverId` is read at runtime from the
  daemon's `/api/status`.
- `dryRun`: always present, `false` on a real send.

`prompt` is validated as 1..16000 **Unicode code points after trim**, so an emoji counts once.
The 64 KiB byte cap on the body is independent and is applied first, so a prompt inside the
code-point limit whose body exceeds 64 KiB gets `payload_too_large`, not `bad_request`.

#### `pageUrl`

When a request carries `pageUrl`, exactly one `Page: <pageUrl>` line is appended
after the `PR:` line. With `pageUrl` absent the header is byte-for-byte the
contract's example. This is now pinned in CONTRACT.md's "Prompt composition"
block, so it is spec rather than interpretation.

#### On a sibling branch of the stack

```
Workspace branch: giz-1132-retire-legacy-cache-flag (NOT this PR's branch)
Note: this worktree is on a different branch of the same stack. If your change belongs to PR #942, check out giz-1133-widget-backed-inventory-audit-rule first.
```

When the bridge also established that the sibling branch's own pull request is
merged or closed, those two lines say so — "a different branch of the same
stack" reads as a live sibling, and a merged branch is behind by construction
because the stack has been restacked past it:

```
Workspace branch: giz-1132-retire-legacy-cache-flag (NOT this PR's branch; its own pull request is already merged)
Note: this worktree is on a branch of this stack whose pull request has already been merged, so it may be behind the rest of the stack. If your change belongs to PR #942, check out giz-1133-widget-backed-inventory-audit-rule first.
```

The advice is the same in every variant; only the description of where the agent
is standing changes. When the state cannot be established, the generic wording
is used — never wrong, only less specific.

#### With no `gh`

The `Title:` and `Branch:` lines are **omitted rather than filled with
placeholders**, and one `Note:` line explains why. Telling an agent it is on a
branch nobody verified is how a commit lands on the wrong branch, so nothing is
guessed. The "check out `<PR branch>` first" line is dropped for the same reason:
without `gh` there is no known PR branch to name.

```
[Sent from Graphite — github/acmegizmos/gizmo-poc PR #942]
PR: https://github.com/acmegizmos/gizmo-poc/pull/942
Workspace branch: giz-1132-retire-legacy-cache-flag
Note: the pull request title and branch names are missing from this header because gh not installed. Read them from the PR URL above if you need them.

<the user's message verbatim>
```

Prompt text is plugin behaviour, not wire shape — the extension never parses the
composed prompt — so `contract` stays at 1.

---

## Security model

The bridge can start agents that run arbitrary code on this machine, so it is
treated as a privilege boundary rather than a convenience.

1. **Loopback only.** `server.listen(port, "127.0.0.1")`. Never `0.0.0.0`.
2. **Bearer token on everything except `GET /v1/ping`.** 32 random bytes,
   base64url, compared with `timingSafeEqual`, stored `0600`, rotatable from the
   surface.
3. **Page origins are refused outright.** If an `Origin` header is present and
   does not start with `chrome-extension://`, the request gets
   `403 forbidden_origin` — on the CORS preflight *and* on the real request, and
   on `/v1/ping` too, so the unauthenticated endpoint is not a bypass. This
   matters because CORS only stops a page from *reading* a response; the request
   would otherwise still fire and cause the side effect. Requiring an
   `Authorization` header forces a preflight, and failing that preflight means
   the browser never sends the real request. Set `allowedExtensionIds` in
   `settings.json` to pin specific extension IDs.
4. **`Host` must be the loopback address actually bound** — `127.0.0.1:<port>` or
   `localhost:<port>`, tracking the live port, not the default. This closes
   DNS rebinding, where a hostile page resolves a name it controls to
   `127.0.0.1`. Anything else gets `403 forbidden_host`.
5. **CORS echo on success only.** The request's own `chrome-extension://` origin,
   `GET, POST, OPTIONS`, `Authorization, Content-Type`, `Max-Age: 600`. No
   `Access-Control-Allow-Credentials`, ever. `Vary: Origin` on every response,
   allowed or not, so no cache can mix them up.
6. **Requests with no `Origin` at all are allowed** (so `curl` works) but still
   need the bearer token.
7. **Body cap** of 64 KiB → `413 payload_too_large`. Oversized uploads are
   drained up to a bounded ceiling so the caller gets a real response instead of
   a connection reset.
8. **Rate limit** of 60 requests per 10 s → `429 rate_limited` with `Retry-After`.
   Keyed on the `Origin` header when there is one and on the remote address
   otherwise, so a `curl` flood from the CLI cannot consume the extension's
   budget. `GET /v1/ping` is counted, not exempt: the limit is defence-in-depth
   on an endpoint that is already loopback-only and token-gated, so keeping the
   total bounded beats carving out one unauthenticated path. 60 is sized for the
   extension's uncached `contract`-mismatch gate, which re-pings before every
   resolve and send — 4 requests per completed send, so ~15 sends per window. The
   window is pruned lazily on each request rather than on a timer, because a live
   timer in this subprocess is what hangs plugin teardown.
9. **Nothing sensitive is logged.** Not the token, not prompt bodies, not agent
   titles (which contain the user's first line). Refused-origin log lines
   deliberately do not echo the origin, so a hostile page cannot write
   attacker-controlled text into the user's log.
10. **No shell, ever.** `gh` and `git` are located as real executables and run
    with `execFile` and an argv array. `gh` is a shell *function* in some setups,
    so going through a shell would run something other than the program; and
    `owner`/`repo` are additionally constrained to `^[A-Za-z0-9._-]+$` before
    they reach argv.
11. **Errors are curated.** Only the codes in CONTRACT.md's table cross the wire.
    Anything unexpected becomes `500 internal` with a generic sentence, and the
    detail goes to the plugin log, so daemon internals and filesystem paths never
    reach a browser extension.

Two paths outside the frozen table, both staying inside its code set: an unknown
endpoint and a wrong method on a known endpoint both return
`400 bad_request` with a descriptive message.

---

## Layout

`*.client.tsx` / `*.server.ts` / `*.shared.ts` matter: Paseo bundles the three
runtimes differently and strips `*.server` imports out of the client bundle.

```
paseo-plugin.json      { "id": "send-to-paseo" }
index.ts               contribution wiring only
bridge.server.ts       the HTTP server, security checks, routing, lifecycle
resolve.server.ts      PR -> project -> workspace resolution and ranking
send.server.ts         workspace ensure + agent create + prompt composition
deps.server.ts         binary lookup, spawn wrapper, dependency self-check
gh.server.ts           the gh calls and their graceful degradation, cached
git.server.ts          read-only branch, remote, trunk and ancestry reads
daemon.server.ts       short-lived Paseo SDK connections, daemon identity
settings.server.ts     token, port, default model, recent sends
contracts.shared.ts    Zod schemas, error taxonomy, pure formatting, RPC contracts
lifecycle.shared.ts    teardown handoff (see below)
settings.client.tsx    the Paseo surface
check-deps.mjs         standalone dependency-degradation checks (not bundled)
```

### Three traps this plugin is built around

**A listening HTTP server wedges plugin reload.** The socket keeps the subprocess
event loop alive, Paseo's "Stopping plugin" step never returns, and
`paseo plugin reload` hangs forever. Teardown therefore calls `server.close()`
**and** `server.closeAllConnections()`, destroys every tracked socket (idle
keep-alive sockets otherwise hold the listener open), and awaits the close with a
grace timeout. There are no `setInterval`s anywhere in the plugin.

**Naming a server module from the cleanup function breaks every contribution.**
Paseo deletes `*.server` imports from the client bundle but keeps the surrounding
statements, and the cleanup returned by `contribute()` runs in the client too — so
a server identifier there is a `ReferenceError` that aborts all registrations.
`bridge.server.ts` therefore starts as an import side effect and publishes its
teardown through `lifecycle.shared.ts`; `index.ts` only ever touches that shared
object.

**A runtime import the host does not provide breaks the install, not the build.**
`npm run typecheck` passes, `paseo plugin reload` from a checkout passes, and
`paseo plugin add tomgrin10/send-to-paseo` fails for everyone — because only the
git path compiles with no `node_modules`. See
[No runtime dependencies, ever](#no-runtime-dependencies-ever); this is why
`buildAgentDeepLink` lives in `contracts.shared.ts` rather than being imported
from `@getpaseo/protocol`, and why `daemon.server.ts` reaches the SDK through an
assembled specifier.

The first two are demonstrated in [`VERIFICATION.md`](VERIFICATION.md) §3 and
§10: five consecutive reloads under a second each, and a harness process that
exits on its own once cleanup runs. The third is §18.
