# send-to-paseo

[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.9.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![Release](https://img.shields.io/github/v/release/tomgrin10/send-to-paseo?display_name=tag&sort=semver&style=for-the-badge&label=release&color=6366f1)](https://github.com/tomgrin10/send-to-paseo/releases/latest)
[![License](https://img.shields.io/github/license/tomgrin10/send-to-paseo?style=for-the-badge&color=2563eb)](LICENSE)

Send work to a [Paseo](https://paseo.sh) agent from the pull request you are already looking at.

![The Send to Paseo composer open on a live github.com pull request — rails/rails #58627, state Open, merging Shopify:actionpack-singleton-class-attrs into rails:main — with the button anchored in GitHub's own PR header action row beside Code, and the popover below it showing the resolved target workspace, the target picker, the typed instruction "Fix the flaky test in this PR", the Provider and Mode selects, and the Cmd-Enter / Esc footer with Send enabled](docs/screenshots/hero-github-pr-popover.png)

Press **Send to Paseo** on any pull request, type what you want done, and it reaches the right
Paseo workspace — with a worktree checked out to the PR if you don't already have one. Choose in
the Paseo plugin whether each send starts a fresh agent or continues that workspace's main agent.
Works on github.com and on Graphite.

- **No setup per pull request.** It works out which of your workspaces belongs to the PR you are
  looking at, and offers to create one if none does.
- **Nothing happens silently.** The composer shows the target it picked and every alternative, and
  waits for you to press **Send**. Main-agent mode previews the exact existing agent it will
  message; if none exists, it says that a new one will be started.
- **Fresh context or continuity.** New-agent mode lets you choose the model and permission mode
  per send. Main-agent mode reuses the best root agent in that workspace and keeps its existing
  model, mode, and context; delegated subagents are never selected.
- **Stacked pull requests, handled.** Send from PR #4 while that worktree sits on PR #7's branch
  and it resolves to the workspace you already have, then tells the agent which branch the change
  belongs on — so one workspace per stack is enough. It still finds that workspace when the branch
  it is parked on has already merged.
- **More than one Paseo machine.** Pair the extension once with a Primary Paseo machine, then add
  a laptop, dev VM, or other machine to the plugin with one connection code. Every pull request is
  resolved on all of them at once, in one list, with the machine named on each row. The default is
  whichever machine already has a worktree for the PR, not whichever you configured first, and the
  send goes only to the machine you picked. A host that is asleep is a footnote in the composer,
  not a wall.
- **Hosts appear automatically in Paseo.** The plugin surface uses Paseo 0.9's configured-host
  inventory, shows live online/offline state, and checks each host through its explicit
  `serverId`. A connection code is still required only to give the browser's Primary bridge the
  private URL and token that Paseo intentionally does not expose to plugins.

## Install

Requires Paseo 0.9.0 or newer with plugins enabled, and `git`.

**Plugin:**

```sh
paseo plugin install npm:send-to-paseo
paseo plugin ls        # send-to-paseo must read `running` and `yes`
```

Or install the same release directly from Git:

```sh
paseo plugin add tomgrin10/send-to-paseo --path plugin
```

If plugins are disabled, turn them on in **Settings → Plugins** first.

**Extension:** download `send-to-paseo-extension.zip` from the
[latest release](https://github.com/tomgrin10/send-to-paseo/releases/latest) and unzip it. Open
`chrome://extensions` (or `edge://`, `brave://`, `arc://`), turn on **Developer mode**, press
**Load unpacked**, and pick the unzipped folder.

Keep that folder somewhere permanent — the extension ID comes from its path, and the pairing token
is tied to the ID.

<details>
<summary>Building from source instead</summary>

Only needed to work on the extension or run the test suite. Requires Node and npm.

```sh
git clone https://github.com/tomgrin10/send-to-paseo
cd send-to-paseo/extension
npm install
npm run build          # -> extension/dist, the load-unpacked root
```

Load `extension/dist` instead of the unzipped release. For the plugin, `paseo plugin add
/absolute/path/to/send-to-paseo/plugin` installs a checkout directly; `npm install` inside
`plugin/` is only for `npm run typecheck`, never for runtime. The end-to-end suite is
`node test/e2e.mjs` from the repository root — it runs headless, and `STP_HEADED=1` shows the
browser. [`AGENTS.md`](AGENTS.md) has the full verification procedure.

</details>

## Setup

Pair the two halves once:

1. In Paseo, open **Send to Paseo** in the sidebar and copy the **pairing token**.
2. Click the extension's toolbar icon, or the **cog** in the composer's header.
3. Paste the token and press **Test connection**.

Then open a pull request and press **Send to Paseo**. There is no config file on either side.
The Paseo surface's **Agent destination** setting chooses between a fresh agent on every send and
the main agent already in the selected workspace.

### Add another Paseo machine

Every host already configured in the Paseo app appears automatically under **Paseo machines**, even
while offline. The remaining setup below is only what lets the browser extension's local Primary
bridge resolve and send through that host; Paseo's discovery API deliberately contains no bridge
URL or credential.

These names are used throughout the setup:

- **Browser machine:** the computer running Chrome.
- **Primary Paseo machine:** the Paseo installation beside Chrome. The extension connects only to
  its loopback bridge at `http://127.0.0.1:7788`.
- **Additional Paseo machine:** a dev VM, workstation, or any other Paseo installation you want in
  the target list.

The normal setup is two copy/paste actions:

1. On the **Additional Paseo machine**, open Paseo → **Send to Paseo** → **Share this Paseo
   machine** and press **Enable private access**. Then press **Copy connection code**.
2. On the **Primary Paseo machine**, open Paseo → **Send to Paseo** → **Paseo machines**, find the
   automatically discovered host, paste the code, and press **Connect additional machine**.

That is all. Do not put the additional machine's address or token in the extension. The Primary
Paseo plugin resolves the pull request on every connected machine and proxies the selected send.
The connection code is a secret because it contains the Additional machine's `serverId`, private
bridge address and pairing token.

The one-click button uses [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve). It runs
on the **Additional Paseo machine**, publishes only to the tailnet, and survives a terminal closing.
Tailscale may ask you to enable HTTPS the first time. Use `tailscale serve off` on that same machine
to remove the proxy. Do not use Tailscale Funnel, which is public.

<details>
<summary>Advanced: manual private access or direct browser connections</summary>

If the one-click button cannot find Tailscale, expand **Advanced: configure private access
manually** on the Additional Paseo machine. Run the command shown there **in a terminal on that
Additional Paseo machine** (normally `tailscale serve --bg 7788`), then paste the printed
`https://…ts.net` address back into that same Paseo screen. Do not use the VM's `.internal`
hostname or its `100.x` Tailscale IP over plain HTTP.

The extension also retains **Advanced: connect the browser directly to each Paseo machine** for
special cases and existing setups. In that mode each machine needs its private HTTPS address, its
own token, and an exact Chrome permission. An SSH loopback tunnel is supported there as a temporary
fallback:

```sh
# Run on the Browser machine; this process must stay open.
ssh -L 7789:127.0.0.1:7788 devbox
```

Then add `http://127.0.0.1:7789` as an Advanced direct connection. Tailscale SSH policy controls
which login user is allowed; a rejected user cannot be fixed by this plugin.

</details>

## Where it shows up

- **A button on the pull-request page**, in the PR header next to the site's own actions. It
  re-targets as you navigate between PRs, so a stale PR number can never be sent.
- **The composer popover**, with the resolved target, a searchable picker holding every
  alternative — type a workspace name, a branch, a PR number, or a machine name — plus an Agent
  dropdown for choosing **Create a new agent** or **Use main agent** on this send. New-agent mode
  shows provider and mode pickers; main-agent mode shows the exact reusable agent instead.
  With more than one host paired, every row names its machine and the resolved target line leads
  with it. ⌘↵ sends, Esc closes. Resolution begins when the page button appears, so opening
  the composer normally has no workspace lookup wait.
- **The Send to Paseo surface** in Paseo's sidebar and under ⌘K: a compact connection summary,
  pairing token, agent destination, defaults, and recent sends. Paseo machines are discovered
  automatically; manual browser routes, bridge details, ports, and private sharing live behind
  **Advanced connection details**.
- **The extension's options page**: normally one pairing token for the Primary Paseo machine.
  Direct URLs, per-machine tokens, and Chrome permission controls live under **Advanced**.

## How it works

The page URL is the only source of PR identity. Nothing is read from the page except stack sibling
links, and those are only a hint — everything else is resolved on the daemon side:

1. `owner/repo` → the matching Paseo project
2. PR number → head branch, title and base branch, via `gh`
3. The PR's **stack** — stacked pull requests are a real `base` → `head` chain on GitHub
   (including the ones Graphite creates), so one `gh pr list` rebuilds it and a walk from this PR
   finds every sibling, up and down. Merged and closed siblings count too: a worktree parked on a
   branch that has already landed is still that stack's worktree
4. Each workspace in that project → its current branch
5. Candidates are ranked: **exact** branch match, then another branch in the same **stack**
   (nearest first), then any workspace in the **project**, then a synthetic **create** option

The Primary Paseo plugin runs all five steps locally and asks every connected Additional Paseo
machine to do the same, in parallel. The extension merges those machine slices into one list
ranked across machines: rank first, so an exact match on the dev box outranks a same-project
workspace on the laptop; then position within a rank, so each bridge's own nearest-first ordering
survives the interleave. Each host contributes its own **create** row, because creating a worktree
is a different action on each machine.

The default target is the exact match, else the nearest stack workspace — open siblings ahead of
merged ones — else create; across hosts, it is whichever host's own default ranks best, so a
machine that would only create a worktree never beats one that already has it.

For **Use main agent**, the plugin considers only non-archived root agents in that exact workspace.
An agent explicitly titled **Main** wins, then one open in a Paseo tab, then a live and recently
used root agent. If there is no eligible root agent — or the target is a newly created worktree —
the dropdown allows only **Create a new agent**. The saved plugin preference initializes the
dropdown but each send can override it. Provider and permission settings apply only to new agents.

When the target sits on a sibling branch, the composer says so, says whether that branch has
landed, and the agent's prompt names the branch the change belongs on.
Paseo does the hard part itself: it can already check a pull request out into a managed worktree,
so nothing here creates one by hand. The only git this project runs is read-only — the branch a
workspace is on, a remote's `owner/repo`, and one ancestry query that recognises a stack whose
chain GitHub has already retargeted past a merged branch.

The extension never talks to the Paseo daemon. In the normal setup it talks only to the Primary
plugin's bridge on `127.0.0.1:7788`; that plugin talks to Additional plugin bridges over their
declared tailnet-only HTTPS addresses. Advanced mode can still contact those bridges directly.
Both paths use one frozen contract,
[`CONTRACT.md`](CONTRACT.md).

<details>
<summary>Why a plugin, and not the extension talking to the daemon</summary>

The obvious design does not work, and this was verified rather than assumed. The daemon's entire
API is a private WebSocket at `ws://127.0.0.1:6767/ws`; its HTTP surface is only `/api/health` and
`/api/status`, with no REST API for agents or workspaces. That WebSocket also enforces an Origin
allowlist:

```text
$ curl -H "Origin: https://app.graphite.com" .../ws
HTTP/1.1 403 Forbidden — Origin not allowed
```

So the alternative would mean editing your daemon config *and* reimplementing an undocumented wire
protocol inside a Chrome extension. Plugin backend code is full Node, so it runs a small versioned
HTTP bridge instead. [`PLAN.md`](PLAN.md) records the whole investigation.

</details>

<details>
<summary>Without the GitHub CLI</summary>

Steps 2 and 3 above are the ones that need `gh`. Without it, sending still works — Paseo checks
the pull request out with its own forge credentials, which needs only the PR number. What you lose:
the PR title, the branch names, and stack detection, so every workspace ranks as "same project"
and the default becomes **create**. The target picker names the reason, the agent's prompt omits
the title and branch rather than guessing them, and `paseo plugin logs send-to-paseo` prints one
line per dependency at every start.

`git` is required. Per-platform install commands and the full requirements are in
[`plugin/README.md`](plugin/README.md#requirements).

</details>

## Security

The bridge can start agents that execute code on your machine, so it is treated as a real
privilege boundary:

- binds `127.0.0.1` only, never `0.0.0.0`; remote access uses a separately configured HTTPS
  reverse proxy, and the plugin explicitly allowlists that one origin
- bearer token on every endpoint except `GET /v1/ping`, whose auth is *optional*: with no
  `Authorization` header it is an unauthenticated liveness check, with a valid one it confirms
  pairing and returns the provider list, and with an invalid one it returns `401`. That is what
  lets **Test connection** tell "bridge down" from "bad token"
- rejects any request whose `Origin` is not `chrome-extension://…`, on the preflight *and* the
  real request — CORS alone stops a page reading a response, not the request firing
- validates the `Host` header, closing DNS rebinding: the hostname must be loopback or the exact
  origin declared as the **Private bridge address**. Remote bridges accept only HTTPS
- 64 KiB body cap, 60 requests per 10 s, no shell anywhere, and no token, prompt or agent title
  in any log line

The token lives only in the extension's service worker, never in the content script, so it is
never adjacent to GitHub's or Graphite's JavaScript. Plugins are trusted, unsandboxed code and
this one listens on a socket: read the source before installing it.

## Troubleshooting

- **No button on a PR page.** Check the URL matches `github.com/{owner}/{repo}/pull/{n}` or
  `app.graphite.com/github/pr/…` (or `.dev`). Then the browser's extensions page → **Errors**, and
  the page console for `[send-to-paseo]` warnings.
- **"Can't reach the Paseo bridge".** `paseo plugin ls` should show `send-to-paseo` as `running`;
  `paseo plugin logs send-to-paseo` says why if it is not.
- **"Not paired with Paseo" or "Token rejected".** Re-copy the token from the Paseo surface, on
  the machine that host points at. The two are deliberately different messages.
- **"Chrome hasn't been given access to this bridge".** This applies only to Advanced direct
  connections. Normal Primary-machine routing needs no remote Chrome permissions.
- **A host named in a warning row under the target picker.** That machine did not answer; the
  others still did. The row carries its own error code.
- **"Update required".** The plugin and extension are on different contract versions and sends are
  blocked on purpose. Update the older side.
- **No PR title, and everything ranks as "same project".** `gh` is missing or not signed in.
- **Typing triggers the host page's keyboard shortcuts.** You are on a stale build. Reload the
  extension, then the tab.

Longer tables, keyed on exact message text, are in
[`plugin/README.md`](plugin/README.md#troubleshooting) and
[`extension/README.md`](extension/README.md#troubleshooting).

## Docs

- [`plugin/README.md`](plugin/README.md) — requirements, configuration, endpoints, the resolution
  ladder, the security model, and troubleshooting keyed on the text you will actually see.
- [`extension/README.md`](extension/README.md) — build, load, pair, architecture, and the three
  things that break silently if you change them.
- [`CONTRACT.md`](CONTRACT.md) — the frozen bridge API. Currently `contract: 1`.
- [`PLAN.md`](PLAN.md) — the design and the research behind it. Read before changing the
  architecture; several plausible alternatives were tested and rejected.
- [`AGENTS.md`](AGENTS.md) — conventions and hard-won facts, so they don't get re-derived.
- [`test/fixtures/github-dom-notes.md`](test/fixtures/github-dom-notes.md) and
  [`test/fixtures/graphite-dom-notes.md`](test/fixtures/graphite-dom-notes.md) — measured page
  structure for both sites, and the class-name hash hazard they share.

Nothing here is claimed without evidence: [`plugin/VERIFICATION.md`](plugin/VERIFICATION.md) and
[`extension/VERIFICATION.md`](extension/VERIFICATION.md) record real output for both halves,
failures included, behind 63 end-to-end cases with the extension genuinely loaded in Chromium.
[`docs/screenshots/`](docs/screenshots/) is indexed and names, per image, which bridge answered it.

## Credits

The extension's icon is the Paseo brand mark, reproduced from Paseo's own `butterfly-white.svg` to
identify Paseo. Paseo is Apache-2.0, © 2025-present Mohamed Boudra. The composer's settings cog is
Lucide's `settings` outline (ISC), the icon set Paseo's own UI uses.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
