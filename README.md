# send-to-paseo

[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.7.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/badge/license-MIT-2563eb?style=for-the-badge)](LICENSE)

Start a [Paseo](https://paseo.sh) agent on the pull request you are already looking at.

![The Send to Paseo composer open on a live github.com pull request — rails/rails #58627, state Open, merging Shopify:actionpack-singleton-class-attrs into rails:main — with the button anchored in GitHub's own PR header action row beside Code, and the popover below it showing the resolved target workspace, the target picker, the typed instruction "Fix the flaky test in this PR", the Provider and Mode selects, and the Cmd-Enter / Esc footer with Send enabled](docs/screenshots/hero-github-pr-popover.png)

Press **Send to Paseo** on any pull request, type what you want done, and a new agent starts in the
workspace for that PR — with a worktree checked out to the PR if you don't already have one. Works
on github.com and on Graphite.

- **No setup per pull request.** It works out which of your workspaces belongs to the PR you are
  looking at, and offers to create one if none does.
- **Nothing happens silently.** The composer shows the target it picked and every alternative, and
  waits for you to press **Send**. Every send starts a *new* agent; nothing existing is touched.
- **Your model and permission mode, per send.** Defaults follow one of your saved Paseo agent
  profiles, and both are overridable in the composer before you send.
- **Stacked pull requests, handled.** Send from PR #4 while that worktree sits on PR #7's branch
  and it resolves to the workspace you already have, then tells the agent which branch the change
  belongs on — so one workspace per stack is enough.

## Install

Requires Paseo 0.7.0 or newer with plugins enabled, and `git`. No Node, no npm, no build step.
The GitHub CLI (`gh`) is optional; "Without the GitHub CLI" below says what changes without it.

Install the plugin:

```sh
paseo plugin add tomgrin10/send-to-paseo --path plugin
paseo plugin ls        # send-to-paseo must read `running` and `yes`
```

If plugins are disabled, turn them on in **Settings → Plugins** first. To update later:
`paseo plugin update send-to-paseo`.

Then the extension. Download `send-to-paseo-extension.zip` from the
[latest release](https://github.com/tomgrin10/send-to-paseo/releases/latest) and unzip it. Chrome
will not install an extension from a file outside the Web Store, so it is loaded unpacked — three
clicks, and it survives browser restarts. Open your browser's extensions page:

- Chrome — `chrome://extensions`
- Edge — `edge://extensions`
- Brave — `brave://extensions`
- Arc — `arc://extensions`

Turn on **Developer mode**, press **Load unpacked**, and select the unzipped folder — the one
holding `manifest.json`. Keep it somewhere permanent: the extension ID comes from that path, so
the pairing token survives reloads as long as the folder stays put.

Last, pair the two halves:

1. In Paseo, open **Send to Paseo** in the sidebar and copy the **pairing token**.
2. Click the extension's toolbar icon, or **Details → Extension options**.
3. Paste the token and press **Test connection**.
4. Open a pull request on GitHub or Graphite and press **Send to Paseo**.

That is the whole install. There is no config file to edit on either side.

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

## Where it shows up

- **A button on the pull-request page**, in the PR header next to the site's own actions. It
  re-targets as you navigate between PRs, so a stale PR number can never be sent.
- **The composer popover**, with the resolved target, every alternative, and provider and mode
  pickers. ⌘↵ sends, Esc closes.
- **The Send to Paseo surface** in Paseo's sidebar and under ⌘K: bridge status, the pairing token,
  the port, which agent profile to follow, the default permission mode, a **Requirements** card,
  and your last 20 sends.
- **The extension's options page**: bridge URL, token, and **Test connection**.

## How it works

The page URL is the only source of PR identity. Nothing is read from the page except stack sibling
links, and those are only a hint — everything else is resolved on the daemon side:

1. `owner/repo` → the matching Paseo project
2. PR number → head branch, title and base branch, via `gh`
3. The PR's **stack** — stacked pull requests are a real `base` → `head` chain on GitHub
   (including the ones Graphite creates), so one `gh pr list` rebuilds it and a walk from this PR
   finds every sibling, up and down
4. Each workspace in that project → its current branch
5. Candidates are ranked: **exact** branch match, then another branch in the same **stack**
   (nearest first), then any workspace in the **project**, then a synthetic **create** option

The default target is the exact match, else the nearest stack workspace, else create. When the
target sits on a sibling branch, the composer says so and the agent's prompt names the branch the
change belongs on. Paseo does the hard part itself — it can already check a pull request out into
a managed worktree, so there is no hand-rolled git anywhere in this project.

The extension never talks to the Paseo daemon. It talks only to the plugin's local HTTP bridge on
`127.0.0.1:7788`, over one frozen contract, [`CONTRACT.md`](CONTRACT.md).

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

- binds `127.0.0.1` only, never `0.0.0.0`
- bearer token on every endpoint except `GET /v1/ping`, whose auth is *optional*: with no
  `Authorization` header it is an unauthenticated liveness check, with a valid one it confirms
  pairing and returns the provider list, and with an invalid one it returns `401`. That is what
  lets **Test connection** tell "bridge down" from "bad token"
- rejects any request whose `Origin` is not `chrome-extension://…`, on the preflight *and* the
  real request — CORS alone stops a page reading a response, not the request firing
- validates the `Host` header, closing DNS rebinding
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
- **"Not paired with Paseo" or "Token rejected".** Re-copy the token from the Paseo surface. The
  two are deliberately different messages.
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
failures included, behind 44 end-to-end cases with the extension genuinely loaded in Chromium.
[`docs/screenshots/`](docs/screenshots/) is indexed and names, per image, which bridge answered it.

## Credits

The extension's icon is the Paseo brand mark, reproduced from Paseo's own `butterfly-white.svg` to
identify Paseo. Paseo is Apache-2.0, © 2025-present Mohamed Boudra.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
