# Repository instructions

## Project

Two halves that meet at one frozen HTTP contract:

- `plugin/` — trusted, unsandboxed Paseo plugin `send-to-paseo`. Runs a local HTTP bridge on the
  daemon machine and contributes a settings surface inside Paseo.
- `extension/` — Chrome MV3 extension. Puts a "Send to Paseo" button on Graphite and github.com
  PR pages.

`CONTRACT.md` is the only integration point. **It is frozen.** Changing it means changing both
halves and re-running both verification suites — do that deliberately, bump `contract`, and never
unilaterally from one side. Additive optional fields, in requests as well as responses, are the
one exception and do not bump `contract`; the clause spells out the mechanism that makes that
safe, which is that both request schemas extend a non-strict `z.object` and therefore strip an
unknown field rather than rejecting the body.

`PLAN.md` records the design and, more importantly, the research that justifies it. Read it before
proposing an architectural change; several obvious-looking alternatives were tested and rejected.

Minimum supported Paseo is 0.7.0, which is also what the README badge claims. Keep the two in
sync.

## Hard-won facts — do not re-derive

- **The extension cannot talk to the Paseo daemon directly.** The daemon's API is a private
  WebSocket at `ws://127.0.0.1:6767/ws`; its HTTP surface is only `/api/health` and `/api/status`.
  The WebSocket enforces an Origin allowlist and returns `403 Origin not allowed` for any web
  origin. This is why the plugin bridge exists.
- **`gh` is a shell function in the user's zsh.** Always `execFile` the real binary with an argv
  array. Never spawn through a shell.
- **Graphite uses CSS-module class names whose hashes rotate every deploy**
  (`BranchPair_gds-branch-name__ZuvL7`). Only ever match with `[class*="Prefix_name"]`. Never take
  *data* from a class-selected node — PR identity comes from the URL.
- `graphite.dev` now redirects to `graphite.com`. Match both.
- Only one genuinely stable Graphite test id exists: `[data-testid="graphite-app-wrapper"]`.
- Paseo creates PR workspaces natively via `checkout-pr` mode. Don't hand-roll git.
- Project id mapping is a string match: `owner/repo` → `remote:github.com/{owner}/{repo}`.
- **A Graphite stack is a real `base` → `head` chain on GitHub.** PR #943's `baseRefName` is
  PR #942's `headRefName`. So one `gh pr list --state open --json number,headRefName,baseRefName`
  rebuilds the entire stack, and the stack is the connected component containing the PR
  (`viewStackGraph`). Verified on a live 7-PR stack. Trunk cannot create a false edge, because an
  edge needs one PR's base to be another PR's *head*, and `main` is never a head.
- **The `graphite-base/942` ref in Graphite's UI is display-only.** `gh` reports the real base
  (`main` for the bottom of a stack). Don't key anything off `graphite-base/*`.
- **Branch name prefixes do not identify a stack.** A single stack spanned `giz-1133`, `giz-1132`
  and `giz-1136` branches. Never group by ticket prefix.
- **Do not use `gt` for this.** The Graphite CLI answers "what is *my current* stack" from local,
  per-worktree metadata relative to whatever branch is checked out in the directory it runs in.
  Resolution runs while the user types in a browser and must not depend on — or disturb — any
  worktree, least of all the candidate workspaces, each of which is on its own branch. `gt` also
  needs a second credential, and its stack commands mutate repo-wide state (the reason for the
  standing `gt sync` prohibition). `gh` is read-only, already required, and sufficient. The one
  thing `gt` would add is stack branches with no PR yet; `gh` cannot see those.
- **Shadow DOM isolates CSS, not events.** Keyboard events are `composed`, so they escape our
  shadow root, and they are *retargeted*: page listeners see `event.target` as the shadow
  **host**, not our `<textarea>`. Graphite's shortcut layer therefore decides the user is not
  typing in a text field and eats the keystrokes — measured: typing a prompt yielded `"x "`.
  `containKeyboard()` (`src/content/ui/keyboard.ts`) is why the composer works. Do not remove
  it, and read that file before touching key handling.
- **Graphite binds `keydown` in both phases, on `window`, `document` and `body`** — its own
  page chunk, ariakit and Datadog RUM. A content script at `document_idle` can never be
  ordered ahead of a `window`-capture listener, so capture-phase handlers are unreachable by
  design. They fire and take no action today; that is the known ceiling.
- **GitHub has the same class-name hazard, not the opposite one.** The PR header is Primer React
  with rotating hash suffixes (`prc-PageHeader-Actions-wawWm`), so `[class*=]` is mandatory there
  too. There is **no `data-testid` anywhere in the PR header**, and the whole legacy Rails
  vocabulary — `.gh-header-actions`, `#partial-discussion-header`, `.gh-header-title` — is gone.
  The primary anchor is the single `[class*="prc-PageHeader-Actions"]` row; the semantic
  `nav[aria-label="Pull request navigation"]` is the only unhashed hook on the page.
  `test/fixtures/github-dom-notes.md` is the measured ground truth, and it records what the
  from-memory skeleton got wrong. Re-measure rather than remember.
- **GitHub's "Files changed" route is `/changes`, not `/files`.** `/files` still resolves, so the
  adapter matches any trailing segment. A `/pull/{n}` URL for an *issue* number 302s to
  `/issues/{n}`, which does not match — that is the desired outcome, no button on an issue.
- **GitHub soft navigation always calls `history.pushState`**, verified by instrumenting it
  alongside fourteen candidate event names. The existing MAIN-world shim was therefore sufficient
  on its own. `turbo:load` / `turbo:render` fire only on cross-page navigation, not on a tab
  switch; `soft-nav:end` covers both and all three are now listened for as belt and braces.
  Observe `#repo-content-turbo-frame`, which survives cross-page Turbo by element identity —
  **not** `react-app`, which is replaced.
- **GitHub is slightly more containable than Graphite.** 390 key-listener registrations, of which
  45 are `document`-capture `keydown` and 2 are `window`-capture, and **zero** are `window`-bubble.
  So bubble containment at the shadow host covers everything reachable from `document_idle`.
  `containKeyboard()` is mandatory on GitHub too — `@github/hotkey` reads `event.target` and gets
  our custom element.
- **`findStackPrNumbers()` returns `[]` on GitHub, deliberately.** GitHub does not render a
  Graphite stack, the bridge derives the stack authoritatively from `gh pr list` anyway, and the
  only place the stack appears on a GitHub page is free-form markdown in a bot comment. `[]` is
  the honest answer and `CONTRACT.md` explicitly supports it.
- **The daemon's `PATH` is not the user's `PATH`.** `/Applications/Paseo.app` is launched by
  launchd with `PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin` — no `/opt/homebrew/bin`, so a
  Homebrew `gh` would be invisible to the plugin while working perfectly in a terminal. Paseo
  0.7.0 does enrich the subprocess environment (measured: the plugin subprocess got the full login
  `PATH`), so this is **latent, not currently biting**. `deps.server.ts` probes well-known install
  locations after `PATH` anyway, because that enrichment is a host behaviour and not a contract.
- **`gh` is optional; `git` is not.** Without `gh` the send still works, because Paseo checks the
  PR out with its own forge credentials and only needs the number. `/v1/resolve` returns 200 in
  that state — degradation is signalled through the create candidate's label
  (`Create worktree for PR #942 (gh not installed)`) and the composed prompt, because
  `CONTRACT.md` is frozen and has no notice field. Never turn a missing `gh` into an error.

## Code boundaries

### Plugin

Paseo bundles these differently — the suffixes are load-bearing, not style:

- `*.client.tsx` — React Native UI. Colour every `Text` from `theme.colors`
  (`foreground` / `foregroundMuted`), root view from `theme.colors.surface0`, spacing from
  `layout.compact`. Unstyled text is black and unreadable in dark themes.
- `*.server.ts` — Node APIs, filesystem, subprocesses, the daemon connection, credentials.
- `*.shared.ts` — Zod contracts and plain values safe in both runtimes.
- `index.ts` — contribution wiring only.

Add nothing to `dependencies`. Every external module the plugin imports is host-provided, and
`@getpaseo/client` is deliberately borrowed at runtime through an assembled specifier so the
compiler cannot resolve it — that is what keeps the plugin installable with no package-manager
step and its protocol version identical to the daemon's. `npm install` exists for `npm run
typecheck` and nothing else.

Two failure modes that have already cost time elsewhere in this codebase's lineage:

1. **A listening HTTP server wedges plugin reload.** It keeps the subprocess event loop alive and
   hangs Paseo's "Stopping plugin" step. Cleanup must await `server.close()` *and*
   `server.closeAllConnections()`.
2. **Naming a `*.server.ts` identifier in the cleanup returned from `index.ts` breaks every
   contribution.** Paseo strips server imports from the client bundle but keeps the surrounding
   code. Hand teardown off through `lifecycle.shared.ts`.

There are no `setInterval`s anywhere in the plugin, and there must not be: the rate-limit window
is pruned lazily on each request precisely because a live timer in this subprocess is what hangs
teardown. Every external command goes through `deps.server.ts`, which resolves a real executable
and `execFile`s it with an argv array; a lookup that bypasses it also bypasses the well-known-path
probe and the self-check.

### Extension

- The bearer token lives **only** in the service worker (`chrome.storage`). The content script
  posts intents via `chrome.runtime.sendMessage`; the service worker performs every `fetch`. A
  daemon-controlling credential must never sit next to a host page's JS.
- Button and popover render in a **shadow root**. No global CSS, ever.
- All site-specific logic lives behind `SiteAdapter`. Adding a site touches exactly four places:
  `src/content/adapters/<site>.ts`, the `ADAPTERS` registry in `adapters/index.ts`, the
  `content_scripts[].matches` in `public/manifest.json`, and the `styleHint()` CSS branch in
  `src/content/ui/styles.ts`. Nothing else. If a change wants a fifth place, the seam is wrong —
  fix the seam.
- Injection is idempotent and must survive client-side navigation between PRs, on Graphite's
  router and on GitHub's Turbo alike.
- Every shadow host we attach to the page gets `containKeyboard()`. A new surface that accepts
  input and skips it will be silently unusable on both sites.
- `mainworld.js` must stay a `world: "MAIN"` content script at `document_start`. An isolated-world
  patch of `history.pushState` never sees the page's own navigations, and the button would keep
  pointing at the PR you first loaded.

## Security

The bridge can start agents that execute arbitrary code on the daemon machine. Treat it as a real
privilege boundary, and don't relax any of these without saying so out loud:

- bind `127.0.0.1` only
- bearer token on everything except `GET /v1/ping`
- reject any request with a non-`chrome-extension://` `Origin`, on the preflight *and* the real
  request — CORS alone does not stop a request firing, only a page reading the response
- validate the `Host` header (DNS rebinding)
- body cap, rate limit, no secrets in logs

`GET /v1/ping` takes *optional* auth, which is not the same as no auth: absent means the
unauthenticated liveness check, valid means paired plus the provider and mode lists, and invalid
means `401`. That third case is the whole reason the options page can tell "bridge down" from
"bad token" — do not collapse it.

Unattended permission modes (Claude `bypassPermissions`, Codex `full-access`) are **listed, not
hidden**, and marked. Hiding them would not make them safer; it would only make the mode the agent
actually runs in harder to see.

## Verify changes

Never restart the Paseo daemon; it kills running agents. Reloading the plugin is safe, and only
the global `pluginsEnabled` switch needs `paseo reload`.

### 1. Plugin

```sh
cd plugin
npm run typecheck
node check-deps.mjs                      # 45 checks; doctors PATH, never touches ~/.config/gh
paseo plugin reload send-to-paseo && paseo plugin ls
paseo plugin logs send-to-paseo          # expect the three dependency self-check lines, no stack traces
time paseo plugin reload send-to-paseo   # must finish in seconds, twice — proves no reload hang
```

Require `running`, an empty `ERROR` column, and `bridge listening on http://127.0.0.1:7788`.

### 2. Extension

```sh
cd extension
npm run typecheck
npm run build
node ../test/e2e.mjs                     # 44 cases; builds dist/ and dist-test/ itself
```

The suite runs Chromium **headless by default** (`--headless=new` loads MV3 extensions fine, so
it no longer steals focus). Set `STP_HEADED=1` to watch it.

The suite is the real unpacked extension in a real Chromium against captured fixtures and a mock
bridge. Case 13 additionally hits the *live* plugin bridge on 7788, and is read-only by
construction — it calls `/v1/ping` and `/v1/resolve` and never `/v1/send`, because a real send
starts a real agent on the user's machine. Keep it that way.

Case 13 must also stay **free of the operator's own data**: the fixture's owner/repo is fictional
on purpose, so the live `/v1/resolve` returns `project_not_found` and the screenshot it writes
cannot contain real workspace labels or branch names. The populated-candidate path is opt-in via
`STP_LIVE_PR="owner/repo#number"` and takes no screenshot. Do not "fix" case 13 by pointing the
fixture at a real repository — every screenshot in `docs/screenshots/` is committed.

| Test | Guards |
| --- | --- |
| 8, 24 | SPA re-targeting. The MAIN-world `pushState` shim on Graphite's router and on GitHub's Turbo; a stale PR number can never reach `/v1/resolve`. |
| 11 | The bearer token is unreachable from the page — DOM, shadow roots, attributes, `window`, both storages, plus a static scan of the built bundles. |
| 12 | Every bridge security rule: Origin on preflight and real request, Host, body cap, rate limit and its keying. |
| 13 | The live bridge, read-only. The only test that proves the real plugin and the real extension agree. |
| 18 | No fixture host, test port or `dist-test` in a shipping artifact, and that the only `host:port` form anywhere in it is `127.0.0.1:7788`. Bare `localhost` is allowed only as the optional host permission and the bridge-URL hint, by exact allowlist — "zero occurrences of localhost" is the wrong invariant and was asserted wrongly once. |
| 19, 28 | Keyboard containment on Graphite and on GitHub, with faithful stand-ins for both shortcut layers. |
| 20 | One workspace per stack: a stack sibling is the default, not `create`. |
| 20a–20c | The mode select is filtered per provider with the resolved default preselected and unattended modes marked, `modeId` reaches `/v1/send`, and a degraded resolve with an empty `pr.headBranch` reads as unknown rather than "a different branch". |
| 21–27 | The GitHub adapter: anchor, Primer token colours, hash rotation, URL parsing, sub-routes, fallback rungs, and a full resolve-and-send. |

When changing a test, confirm it still fails for the right reason: break the thing on purpose,
watch it fail, then restore. A test that cannot fail is worse than no test.

### 3. Keyboard behaviour

Keyboard behaviour must be tested with **real keystrokes** (`page.keyboard.type`). Playwright's
`locator.fill()` sets `value` directly and dispatches no key events, so it cannot observe host-page
shortcut interference — that is exactly how the containment bug reached a user. Tests 19 and 28
are the regression tests; verify they can still fail by stubbing out `containKeyboard`.

### 4. UI

UI changes get checked in a wide window and a compact one, in both light and dark themes. On
GitHub, also check an explicit `data-color-mode` — the button reads Primer's own custom
properties, which inherit through the shadow boundary, so a theme pinned against the OS setting is
a distinct case.

### 5. Honesty

Keep `plugin/VERIFICATION.md` and `extension/VERIFICATION.md` honest: real commands, real output,
and failures recorded as failures. A limitation that is written down is worth more than one that
is quietly not tested. When a past claim turns out to be wrong, correct it and say so rather than
deleting the record.

## Create a release

**There is no git remote and no commits yet**, so nothing below has been exercised. It is the
intended procedure, and the first release will be the test of it.

- Release user-facing features, bug fixes, compatibility changes, or contract changes.
  Documentation-only edits normally do not need a release.
- Use SemVer: patch for compatible fixes, minor for backward-compatible features, major for
  breaking behaviour or compatibility changes. `contract` in `CONTRACT.md` is versioned separately
  and only increments on a breaking wire change — an additive optional field does not touch it.
- The version lives in four places and they must agree: `plugin/package.json`,
  `PLUGIN_VERSION` in `plugin/contracts.shared.ts`, `extension/package.json`, and `version` in
  `extension/public/manifest.json`. Update the Paseo minimum in the README badge only when
  compatibility actually changes.
- Before publishing, require a clean tree, passing typechecks on both halves, `node
  check-deps.mjs` green, the full e2e suite green, a successful plugin reload with clean logs, and
  a secret audit of the exact release snapshot — the pairing token and `settings.json` must never
  be committed.
- Tag the exact release commit as `vX.Y.Z`.

Never move or rewrite a published tag. Ship corrections as a new patch release.
