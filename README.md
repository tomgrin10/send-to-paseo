# send-to-paseo

[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.7.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/badge/license-MIT-2563eb?style=for-the-badge)](LICENSE)

A trusted local [Paseo](https://paseo.sh) plugin and a Chrome extension that start a Paseo agent
on the pull request you are already looking at.

![The Send to Paseo composer open on a live github.com pull request — rails/rails #58627, state Open, merging Shopify:actionpack-singleton-class-attrs into rails:main — with the button anchored in GitHub's own PR header action row beside Code, and the popover below it showing the resolved target workspace, the target picker, the typed instruction "Fix the flaky test in this PR", the Provider and Mode selects, and the Cmd-Enter / Esc footer with Send enabled](docs/screenshots/hero-github-pr-popover.png)

Click it, type an instruction — "Fix the flaky test in this PR" — and a **new** agent starts in the
workspace that belongs to that PR's branch, creating a worktree checked out to the PR if none
exists. Works on Graphite and on github.com.

The extension never talks to the Paseo daemon. It talks only to the plugin's local HTTP bridge on
`127.0.0.1:7788`, over one frozen contract, [`CONTRACT.md`](CONTRACT.md). The plugin reaches Paseo
through the supported SDK, and Paseo does the hard part itself: it can already check a pull
request out into a managed worktree, so there is no hand-rolled git anywhere in this project.

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

So the alternative would mean editing the user's daemon config *and* reimplementing an
undocumented wire protocol inside a Chrome extension. Plugin backend code is full Node, so it
runs a small versioned HTTP bridge instead. [`PLAN.md`](PLAN.md) records the whole investigation.

</details>

### Where it shows up

- **A button on the pull-request page.** On Graphite it goes into the PR header action row, just
  before **Review Changes**; on GitHub it is appended to the header action row, right of **Code**,
  taking its colours from GitHub's own Primer tokens so it tracks light, dark and any custom
  theme. Both sites ship CSS-module class names whose hashes rotate on every deploy, so every
  selector is a contains-match and each adapter has a fallback rung plus a floating button of last
  resort. Navigating between PRs re-targets the button; a stale PR number can never be sent.
- **The composer popover.** It opens with the resolved target already worked out, shows every
  alternative workspace, and requires an explicit **Send** — it never creates anything silently.
  Provider and permission mode are selectable per send, and unattended modes are listed rather
  than hidden, marked with a warning. ⌘↵ sends, Esc closes.
- **The Send to Paseo surface**, in Paseo's sidebar and under ⌘K. Bridge status, the pairing
  token, the port, the default model, the agent profile to follow, the default permission mode, a
  **Requirements** card, and the last 20 sends.
- **The extension's options page.** Bridge URL, token, **Test connection**, and a default provider
  list fetched from the bridge itself.

## Install

Requires Paseo 0.7.0 or newer with plugins enabled, and `git`. The GitHub CLI (`gh`) is
**optional**: without it sending still works, because Paseo checks the pull request out using its
own forge credentials — you lose the PR title, the branch names and stack detection, and the
target picker says so. Nothing here needs Node, npm, or a build step. Full requirements and
troubleshooting are in [`plugin/README.md`](plugin/README.md#requirements).

Install the plugin — it is the half that talks to Paseo:

```sh
paseo plugin add tomgrin10/send-to-paseo --path plugin
paseo plugin ls        # send-to-paseo must read `running` and `yes`
```

Paseo clones the repository, compiles the plugin itself, and supplies every runtime module it
imports. The plugin has no runtime dependencies, so no package manager ever runs on your daemon.
If plugins are disabled, turn them on in **Settings → Plugins** first — that is a daemon config
change and needs `paseo reload`, not a restart. To update later: `paseo plugin update send-to-paseo`.

Then the extension. Download `send-to-paseo-extension.zip` from the
[latest release](https://github.com/tomgrin10/send-to-paseo/releases/latest) and unzip it.
Chrome will not install an extension from a file outside the Web Store, so it is loaded unpacked —
which is three clicks and survives browser restarts. Open your browser's extensions page:

- Arc — `arc://extensions`
- Chrome — `chrome://extensions`
- Edge — `edge://extensions`
- Brave — `brave://extensions`

Turn on **Developer mode**, press **Load unpacked**, and select the unzipped folder — the one
holding `manifest.json`. Keep it somewhere permanent: the extension ID is derived from that path,
so the pairing token survives reloads for as long as you leave the folder where it is.

Last, pair the two halves:

1. In Paseo, open **Send to Paseo** in the sidebar and copy the **pairing token**.
2. Click the extension's toolbar icon, or **Details → Extension options**.
3. Paste the token and press **Test connection**. It distinguishes paired, not paired yet, token
   rejected, bridge unreachable, daemon unreachable and update required, so a failure tells you
   which thing is wrong.
4. Open a pull request on Graphite or GitHub and press **Send to Paseo**.

That is the whole install. There is no config file to edit on either side.

<details>
<summary>Building from source instead</summary>

Only needed to develop the extension or to run the test suite. Requires Node and npm.

```sh
git clone https://github.com/tomgrin10/send-to-paseo
cd send-to-paseo/extension
npm install
npm run build          # -> extension/dist, the load-unpacked root
```

Load `extension/dist` instead of the unzipped release. For the plugin, `paseo plugin add
/absolute/path/to/send-to-paseo/plugin` installs a checkout directly, and `npm install` inside
`plugin/` is needed only for `npm run typecheck` — never at runtime. The end-to-end suite is
`node test/e2e.mjs` from the repository root; it runs headless, and `STP_HEADED=1` shows the
browser. [`AGENTS.md`](AGENTS.md) has the full verification procedure.

</details>

## How a PR maps to a workspace

The page URL is the only source of PR identity — `/github/pr/{owner}/{repo}/{number}/{slug}` on
Graphite, `/{owner}/{repo}/pull/{number}` on GitHub. Nothing is read from the DOM except stack
sibling links, and those are a hint. Everything else is resolved on the daemon side:

1. `owner/repo` → Paseo project `remote:github.com/{owner}/{repo}`, falling back to a project
   whose `origin` remote parses to the same repository
2. PR number → head branch, title and base branch, via `gh`
3. The PR's **stack**, from GitHub itself — a Graphite stack is a real `base` → `head` chain, so
   one `gh pr list` rebuilds it and a walk from this PR finds every sibling, up and down
4. Each workspace in that project → its branch, from the daemon's own workspace descriptor or
   `git rev-parse --abbrev-ref HEAD`
5. Candidates are ranked: **exact** branch match, then another branch in the same **stack**
   (nearest first), then any workspace in the **project**, then a synthetic **create** option

The default target is the exact match, else the nearest stack workspace, else create — so keeping
**one workspace per stack** works: open PR #4 while that worktree sits on PR #7's branch and it
resolves to the workspace you already have. When the target is on a sibling branch, the popover
says so and the agent's prompt names the PR branch to check out. Steps 2 and 3 are the ones that
need `gh`; without it they are skipped, the request still succeeds, and the prompt omits the
title and branch lines rather than guessing them.

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
never adjacent to Graphite's or GitHub's JavaScript. Plugins are trusted, unsandboxed code and
this one listens on a socket: read the source before installing it.

## Verification

Nothing here is claimed without evidence. Both halves keep an honest log, failures recorded as
failures:

- [`plugin/VERIFICATION.md`](plugin/VERIFICATION.md) — real curl output, every security
  rejection, the dependency audit against a doctored `PATH`, and real agent creations (including
  `checkout-pr`), each cleaned up afterwards
- [`extension/VERIFICATION.md`](extension/VERIFICATION.md) — 44 end-to-end cases with the
  extension genuinely loaded in Chromium, against seven captured fixtures including
  **hash-rotated** Graphite and GitHub pages that prove the anchor ladders survive a deploy
- [`docs/screenshots/`](docs/screenshots/) — 43 indexed screenshots from real Chromium runs, no
  mockups and nothing hand-edited. 39 are regenerated from the captured fixtures by
  `node test/e2e.mjs`; four are live captures against the real Graphite and github.com apps,
  including the two images above. The index names, per image, which bridge answered and what
  was shimmed

## Docs

- [`plugin/README.md`](plugin/README.md) — requirements, configuration, endpoints, the resolution
  ladder, the security model, and troubleshooting keyed on the text you will actually see.
- [`extension/README.md`](extension/README.md) — build, load, pair, architecture, and the three
  things that break silently if you change them.
- [`CONTRACT.md`](CONTRACT.md) — the frozen bridge API. Currently `contract: 1`.
- [`PLAN.md`](PLAN.md) — the design and the research behind it. Read before changing the
  architecture; several plausible alternatives were tested and rejected.
- [`AGENTS.md`](AGENTS.md) — conventions and hard-won facts, so they don't get re-derived.
- [`test/fixtures/graphite-dom-notes.md`](test/fixtures/graphite-dom-notes.md) and
  [`test/fixtures/github-dom-notes.md`](test/fixtures/github-dom-notes.md) — measured page
  structure for both sites, and the class-name hash hazard they share.

## Troubleshooting

- **No button on a PR page.** Check the URL matches `app.graphite.com/github/pr/…` (or
  `.dev`) or `github.com/{owner}/{repo}/pull/{n}`. Then the browser's extensions page →
  **Errors**, and the page console for `[send-to-paseo]` warnings.
- **"Can't reach the Paseo bridge".** `paseo plugin ls` should show `send-to-paseo` as `running`;
  `paseo plugin logs send-to-paseo` says why if it is not.
- **"Not paired with Paseo" or "Token rejected".** Re-copy the token from the Paseo surface. The
  two are deliberately different messages.
- **"Update required".** The plugin and extension are on different contract versions and sends
  are blocked on purpose. Update the older side.
- **No PR title, and everything ranks as "same project".** `gh` is missing or not signed in. The
  target picker names the reason and `paseo plugin logs send-to-paseo` prints one line per
  dependency at every start.
- **Typing triggers the host page's keyboard shortcuts.** You are on a stale build. Rebuild,
  reload the extension, reload the tab.

Longer tables, keyed on exact message text, are in
[`plugin/README.md`](plugin/README.md#troubleshooting) and
[`extension/README.md`](extension/README.md#troubleshooting).

## Credits

The extension's icon is the Paseo brand mark, reproduced from Paseo's own `butterfly-white.svg`
to identify Paseo. Paseo is Apache-2.0, © 2025-present Mohamed Boudra. The mark is stored as SVG
path data and rasterised at build time, so no icon binaries are checked in — the only binaries
in this repository are the screenshots under `docs/screenshots/`. The extension's own in-page UI
keeps its indigo accent; only the icon is Paseo's.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
