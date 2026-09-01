# Verification record

Every result below is copied from a real run. Nothing here is asserted from reading the
code. The raw machine-readable output of the last run is at `test/.last-run.json`.

> The live-integration runs used a private repository. Owner/repo names, branch names, ticket
> ids, PR titles and Paseo workspace/agent/server ids have been consistently replaced with
> fictional equivalents (`acmegizmos/gizmo-poc`, `GIZ-…`). Every measurement is untouched.

- **Date of run:** 2026-09-01 (fourth round: **GitHub adapter**, PLAN.md phase 6. Third round
  was the revised CONTRACT.md incl. the 60/10 s rate limit; those results are unchanged and
  were re-run green.)
- **Machine:** macOS (Darwin 25.6.0, arm64), Node v24.16.0
- **Browser:** cached Playwright Chromium 1223 —
  `~/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app`
  driven by `playwright-core@1.58.0-alpha-2026-01-16` (a devDependency; no browser download
  was triggered — the cached binary is used via `executablePath`).
- **Launch mode:** `chromium.launchPersistentContext(..., { headless: !headed, args: ["--disable-extensions-except=<dist-test>", "--load-extension=<dist-test>"] })`.
  The *persistent* context is required: MV3 service workers do not start in a non-persistent one.
  Headless is **not** a problem — Chrome's `--headless=new` is the real browser and loads MV3
  extensions, so the suite runs headless by default and does not steal focus. Set `STP_HEADED=1`
  to watch the run (or to debug a failure interactively).
  Confirmed working in both modes — the suite resolves a real extension ID from the service
  worker URL (e.g. `jpomndlffihbghhkglgiajojhgigdgoi`).

## Static checks

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **clean**, no output. `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` all on. |
| Shipping build | `npm run build` | **ok** — `dist/{content,options,background,mainworld}.js`, `manifest.json`, `options.html`, 4 generated icons. |
| Test build | `npm run build:test` | **ok** — `dist-test/`, manifest named "(test build)", extra content-script matches for the fixture host in **both** URL shapes (`/github/pr/*` for Graphite, `/*/*/pull/*` for GitHub) and an extra `host_permissions` entry for the mock bridge port. |
| Error-table exhaustiveness | `npm run typecheck` | **enforced at compile time.** `src/shared/errors.ts` types its table as `Record<ContractErrorCode \| LocalErrorCode, PresentedError>`. Verified by deliberately deleting the `daemon_unreachable` entry: `tsc` failed with `error TS2741: Property 'daemon_unreachable' is missing`. Restored, clean again. A future contract code cannot be silently forgotten. |
| Browser console during the whole e2e run | — | **no errors** (`consoleErrors: []`). |

## End-to-end suite

`node test/e2e.mjs` — **44 passed, 0 failed, 0 skipped.** Exit code 0.
(31 before the GitHub adapter, then 41 with it; the 3 new cases for permission modes are
**20a, 20b, 20c**. They are lettered rather than numbered 22-24 because the GitHub block
already owns those numbers.)

The suite loads the actual unpacked extension into Chromium and serves the captured fixtures
over HTTP at genuine, site-accurate PR-shaped paths — one shape per site, so each adapter's
URL parsing is really exercised:

```
Graphite  http://localhost:4173/github/pr/acmegizmos/gizmo-poc/942/GIZ-1133-...
GitHub    http://localhost:4173/acmegizmos/gizmo-poc/pull/942[/commits|/checks|/changes|/files]
```

Host matching is injected at build time (`--test --port 4173` → esbuild
`define: __STP_EXTRA_HOSTS__`, plus the two extra match patterns per content script); no
localhost **origin** exists in a shipping build (asserted — test 18).

### The 11 originally-required cases

| # | Requirement | Result | Real output |
| --- | --- | --- | --- |
| 1 | Button injects into the header action row | **PASS** | `sits before Button_gdsButton__SadwL ReviewChangesAction_reviewChangesAction__jRuEO`; `4 sibling buttons in the row`. Asserted: marker attribute present, `data-stp-mode=anchored`, `data-stp-style=graphite` (from the adapter's `styleHint()`), `data-stp-pr=942`, host inside `[class*="PullRequestPageHeader_prPageHeader"]`, `nextElementSibling` text contains "Review Changes", shadow root exists with label "Send to Paseo", exactly 1 host. |
| 2 | Button still injects on the **hash-rotated** fixture | **PASS** | `matched header with rotated hash __G1hCN` (was `__NRgNb`). The test first asserts the two fixtures genuinely differ, then asserts the *matched* header carries the **new** hash — so it cannot pass by accident. All 41 hashed class tokens are rotated by `test/fixtures/rotate.mjs`. |
| 3 | Floating fallback on the no-anchor fixture | **PASS** | `position:fixed right:18px bottom:18px`. Asserted first that the fixture has **0** `PullRequestPageHeader_prPageHeader` and **0** `MetadataSection_prInfoGroup` elements, then mode `floating`, parent `<body>`, computed `position: fixed`, PR number still `942` (from the URL). |
| 4 | Popover opens, calls `/v1/resolve`, shows target + candidates | **PASS** | Bridge saw `POST /v1/resolve {"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,"stackPrNumbers":[949,948,947,946,945,943,941]}`, `Authorization` present, `Origin: chrome-extension://<id>`. Summary `→ workspace brawny-dodo / giz-1133-widget-backed-inventory-audit-rule · acmegizmos/gizmo-poc`. Candidates: `brawny-dodo — … (exact match, 2 agents)` \| `candid-otter — … (stack #949, 0 agents)` \| `gizmo-poc (main checkout) — main (same project, 1 agent)` \| `Create worktree for PR #942 — …`. Also: `defaultCandidateIndex` honoured, 3 providers with the default marked and pre-selected, textarea autofocused, `Send` disabled while empty, and changing the dropdown to the create candidate updates the summary. Footer keycaps asserted: `⌘(sym)=13px ↵(sym)=13px Esc=10.5px` — symbol-only caps must compute larger than lettered ones (see the cosmetic fix below). |
| 5 | Stack PR numbers correct, **current PR excluded** | **PASS** | `page hrefs (8): includes /942/ = true`; `sent stackPrNumbers: [949,948,947,946,945,943,941]`. The test asserts the fixture *does* contain a self-link first, so the exclusion is meaningful. Belt and braces: test 12 separately asserts the bridge tolerates and filters a self-inclusive list. |
| 6 | Send hits `/v1/send` with a correct body; success renders the deep link | **PASS** | Bridge saw `POST /v1/send {"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,"prompt":"Fix merge conflicts with graphite-base/942","target":{"kind":"existing","workspaceId":"wks_4d1a8b7c2e0f9351"},"provider":"claude/claude-opus-5","pageUrl":"http://localhost:4173/github/pr/acmegizmos/gizmo-poc/942/GIZ-1133-legacy-tally-engine-retirement-3"}`. Exact key set asserted. Rendered `Agent started`, `data-stp-dryrun="false"`, **no** DRY RUN badge, href `paseo://h/srv_Ab3xY9pQ2mNt/agent/agt_mock0001` — asserted against `/^paseo:\/\/h\/[^/]+\/agent\/[^/]+$/`, never an exact string, because `deepLink` is opaque. |
| 7 | ⌘↵ sends; Esc closes | **PASS** | `Esc detached the popover` (host removed, `aria-expanded` reset to `false`); `Meta+Enter produced POST /v1/send with the typed prompt`. Esc uses a capturing document listener so it works regardless of which world holds focus. |
| 8 | SPA navigation re-targets the button | **PASS** | `history.pushState` executed from the page's MAIN world to `/github/pr/acmegizmos/gizmo-poc/948/...`. Button flipped to `data-stp-pr=948`, still exactly 1 host, still anchored in the header. The **next** `/v1/resolve` used `number: 948`, and `stackPrNumbers` became `[949,947,946,945,943,942,941]` — 948 self-filtered, 942 now a sibling. Popover header `acmegizmos/gizmo-poc #948`, default candidate `Create worktree for PR #948`. **This is the guard on the MAIN-world history shim.** |
| 9 | Error paths render specific messages | **PASS** (6 sub-tests) | See the error table below. |
| 10 | Options page "Test connection" | **PASS** (6 sub-tests) | See the options table below. |
| 11 | Token is NOT reachable from the page | **PASS** | `no token in DOM, shadow DOM, attributes, window, localStorage or sessionStorage`; `page world cannot see chrome.storage`; `content.js + mainworld.js: no Bearer / Authorization / chrome.storage references`; `background.js: contains both`. Caveat below. |

### Error paths (case 9)

| Sub-test | Result | Rendered |
| --- | --- | --- |
| 9a bridge down | **PASS** | `bridge_unreachable` → "Can't reach the Paseo bridge" / "Open Paseo and make sure the send-to-paseo plugin is running…" + options link |
| 9b wrong token | **PASS** | `unauthorized` → "Not paired with Paseo" + options link. **Now caught by the preflight ping**: asserted the bridge saw `authState: "bad"` on `/v1/ping` and that `/v1/resolve` was never attempted. |
| 9c project not found | **PASS** | `project_not_found` → "This repo isn't a Paseo project" / message `acmegizmos/gizmo-poc is not a registered Paseo project.` / hint "Add the repository as a project in Paseo, then retry." |
| 9d gh not authenticated | **PASS** | `forge_unauthenticated` → "GitHub CLI isn't authenticated" / hint `Run: gh auth login`. The bridge now sends that command **bare** per the Clarifications, and the test asserts the extension's own presentation layer wraps it in a real `<code>` element. |
| 9e **all 13 CONTRACT.md codes** | **PASS** | Each injected in turn and asserted to produce a non-generic headline and non-empty hint: `unauthorized` → "Not paired with Paseo"; `forbidden_origin` → "Bridge rejected this extension's origin"; `forbidden_host` → "Bridge rejected the request host"; `bad_request` → "The bridge rejected this request"; `payload_too_large` → "Message too long"; `rate_limited` → "Slow down"; `project_not_found` → "This repo isn't a Paseo project"; `pr_not_found` → "Couldn't find this pull request"; `forge_unauthenticated` → "GitHub CLI isn't authenticated"; `workspace_create_failed` → "Couldn't create a worktree for this PR"; `agent_create_failed` → "Paseo refused to start the agent"; `daemon_unreachable` → "Paseo daemon unreachable"; `internal` → "The bridge hit an unexpected error". |
| 9f first run, no token | **PASS** | `not_configured` → "Not paired with Paseo" + options link, and asserted **zero** HTTP requests reached the bridge. The preflight checks for a stored token before it does anything network-facing. |

### Options page: five distinct Test-connection outcomes (case 10)

Made possible by ping's now-optional auth. Each is a separate test with its own screenshot.

| Sub-test | Result | Real output |
| --- | --- | --- |
| 10a valid token | **PASS** | ok tone, `Paired with Paseo — send-to-paseo 0.1.0 · contract v1 · daemon 0.7.0 (srv_Ab3xY9pQ2mNt) · 3 providers`. Bridge log confirms `authState: "valid"`. **Provider picker populated from ping**: `(use the plugin's default) \| Opus 5 — claude/claude-opus-5 (plugin default) \| Sonnet 5 — claude/claude-sonnet-5 \| GPT-5 Codex — codex/gpt-5-codex`. Selecting `codex/gpt-5-codex` was asserted to persist to `chrome.storage`. |
| 10b no token | **PASS** | warn tone, `Bridge reachable, not paired yet — … · 0 providers`. Bridge log confirms `authState: "none"`, and the picker holds only the placeholder option. |
| 10c wrong token | **PASS** | bad tone, `Token rejected`, hint tells the user to re-copy it. Bridge log confirms `authState: "bad"` → 401. |
| 10d bridge down | **PASS** | bad tone, `Can't reach the Paseo bridge — Couldn't connect to the bridge at http://127.0.0.1:7799.` Distinct from 10c, which was the point of the contract change. |
| 10e contract mismatch | **PASS** | bad tone, `Update required — The plugin speaks bridge contract v2; this extension was built for v1.`, hint "Sends are blocked until the versions match." |
| 10f fresh state | **PASS** | `token input is type=password by default`; grant row hidden for an already-permitted URL; **and** asserted the page does not auto-ping when unpaired (status tone stays `idle`). |

### New tests for the revised contract

| # | Test | Result | Real output |
| --- | --- | --- | --- |
| 15 | `GET /v1/ping` optional auth, three outcomes (raw HTTP) | **PASS** | `no auth -> 200 paired:false providers:[]` (and `modes:[]`); `valid auth -> 200 paired:true providers:3 (one isDefault)`; `invalid auth -> 401 unauthorized`. Also asserts exactly one provider carries `isDefault`. |
| 16 | **`contract` mismatch refuses to send** | **PASS** | Two scenarios. (a) Mismatch present when the popover opens: rendered `Update required — The Paseo plugin speaks bridge contract v2; this extension was built for v1.`, and the bridge log shows **0** `/v1/resolve` and **0** `/v1/send` requests, with the `/v1/ping` gate present. (b) The harder case: composer opened and reached `ready` on contract v1, prompt typed, then the plugin flipped to v2 underneath, then **Send clicked** → refused with `contract_mismatch` and **0** `POST /v1/send` requests ever issued. Scenario (b) is why the gate is not cached. |
| 17 | `dryRun: true` surfaced distinctly | **PASS** | Headline `Dry run — no agent created` + badge `DRY RUN`; host attribute `data-stp-dryrun="true"`; note asserted to contain both `SEND_TO_PASEO_DRY_RUN=1` and "synthetic"; deep link relabelled `Open in Paseo (synthetic id)`. Test 6 asserts the converse for a real send (`data-stp-dryrun="false"`, no badge), so the two states are provably different. |
| 18 | **Shipping build carries no test host or port** | **PASS** | `shipping host_permissions: ["http://127.0.0.1:7788/*"]` — asserted by exact equality, not substring. `shipping optional_host_permissions: ["http://127.0.0.1/*","http://localhost/*"]` — also exact, so the user-consented breadth cannot silently grow. Content-script matches asserted by exact equality to be exactly `["https://app.graphite.com/github/pr/*","https://app.graphite.dev/github/pr/*","https://github.com/*/*/pull/*"]`, on **both** content scripts, and the pair asserted to be `mainworld.js@document_start/MAIN` + `content.js@document_idle/ISOLATED` — so a future edit cannot drop the MAIN-world SPA shim from a site. `no occurrence of 4173, 7799, dist-test in any shipping file` (manifest, all four bundles, options.html). `__STP_EXTRA_HOSTS__ compiles to []`. **Stronger since round four**, because `grep -c localhost dist/manifest.json dist/content.js` is *not* 0 and never was: the test now asserts (a) the only `localhost`/`127.0.0.1` **origin** (host:port form) anywhere in a shipping artifact is the real bridge `127.0.0.1:7788`, and (b) an exact allowlist of the remaining three bare `localhost` substrings — `optional_host_permissions: "http://localhost/*"` in the manifest, and the bridge-URL *hint* prose in `content.js` and `options.js` (`src/shared/errors.ts`). Neither is a host the extension talks to, and a fourth occurrence now fails the suite. Plus an inverse sanity assertion that the **test** build *does* carry `http://127.0.0.1:7799/*` and the "(test build)" name, so this test is capable of failing. |

### Permission modes and the degraded-branch guard (added 2026-09-01)

| # | Test | Result | Real output |
| --- | --- | --- | --- |
| 20a | **Mode select: filtered by provider, resolved default preselected, unattended mode marked** | **PASS** | `claude modes: plan, default, acceptEdits, auto, bypassPermissions (preselected auto)`. The preselection is the bridge's `resolvedModeId`, asserted to be `auto` and explicitly asserted *not* to be the first option and not `default` ("Always Ask"). Provider switched to `codex/gpt-5-codex` in the live popover → `codex modes: auto, auto-review, full-access (preselected auto-review)`, i.e. the select really refilters and re-preselects, and the stale `bypassPermissions` warning does not survive the switch. Danger marking asserted three ways: `data-stp-mode-danger="true"` on the Bypass option and absent on a safe one, a `⚠` glyph prefix, and the computed colour resolved through a throwaway `color: var(--stp-warn)` probe rather than a hard-coded hex — `unattended option colour rgb(146, 80, 14) == --stp-warn rgb(146, 80, 14); safe option rgb(22, 24, 29)`. Selecting Bypass renders `[data-stp-mode-warning]` containing "will not ask for permission". Screenshots in light and dark. |
| 20b | **`/v1/send` carries the chosen `modeId`** | **PASS** | Picked `acceptEdits` in the popover, then: `{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,"prompt":"Rebase onto main","target":{"kind":"existing","workspaceId":"wks_4d1a8b7c2e0f9351"},"provider":"claude/claude-opus-5","modeId":"acceptEdits","pageUrl":"..."}`. Asserted `modeId !== "auto"`, so the explicit choice provably beats `resolvedModeId`. Tests 6 and 27 additionally pin the full send-body key set to exactly `["forge","modeId","number","owner","pageUrl","prompt","provider","repo","target"]`, so a stray field cannot creep in. |
| 20c | **A degraded `pr.headBranch: ""` is UNKNOWN, not "a different branch"** | **PASS** | Regression test for a bug the dependency audit found. With `gh` unavailable the bridge deliberately never guesses the head branch and sends `""`; `c.branch !== resolved.pr.headBranch` was then true for *every* existing candidate, so the amber note "worktree is on another branch of this stack" fired while asserting a mismatch nothing could know. Two halves, so it cannot pass vacuously: **control** (gh present, rank-3 workspace on `main`) → `"worktree is on another branch of this stack"` still renders; **degraded** (`POST /__test/config {"noGh":true}`, and the response asserted to really carry `pr.headBranch === ""`) → `mismatch note = null`, with the same candidate still reporting its own branch `main`. |

The mock bridge gained the `modes` array, `resolvedModeId`, `modeId` validation on `/v1/send`
and a `--no-gh` / `POST /__test/config {"noGh":true}` degradation switch. Its `MODES` fixture is
transcribed from what the real daemon advertises, measured through `providers.snapshot()` on
2026-09-01, including `colorTier: "dangerous"` and `isUnattended: true` on Claude's
`bypassPermissions` and Codex's `full-access`.

### Other tests

| # | Test | Result | Real output |
| --- | --- | --- | --- |
| 2a | Injection idempotent under DOM churn | **PASS** | `30 mutation bursts -> still exactly 1 button host`. |
| 12 | Bridge security rules | **PASS** | `forbidden_origin on real request and on preflight`; `chrome-extension origin echoed, no Access-Control-Allow-Credentials, Vary: Origin`; `forbidden_host via raw socket with a spoofed Host header` (`HTTP/1.1 403 Forbidden`); `payload_too_large at >64 KiB`; `self-inclusive stackPrNumbers tolerated and filtered (200, stack candidate #949)`; **rate limit at the raised 60/10 s, with the keying rule proved** — see below. Tests the **mock** bridge, i.e. it validates the conformance reference, not the plugin. |
| 14 | Compact window (860×620), light and dark | **PASS** | `card 392x401 inside 860x620`; button still on the primary anchor rung; popover asserted fully inside the viewport on all four edges. Satisfies AGENTS.md's "wide window and a compact one, in both light and dark themes". |
| 13 | **Live integration against the real plugin bridge** | **PASS** | Extension pointed at the actual `send-to-paseo` plugin on `127.0.0.1:7788` with the real token from `~/.paseo/plugin-data/send-to-paseo/settings.json`. Authenticated `GET /v1/ping`: `contract 1, daemon 0.7.0, 44 providers, 10 modes`, `paired: true`. Then `/v1/resolve` through the popover for the fixture's repo — which is fictional, so it is a Paseo project on nobody's machine — returned the contract error `project_not_found` → "This repo isn't a Paseo project", with a specific title rather than a bare "Failed". That still exercises the whole path: extension → real HTTP → real plugin subprocess → real `gh`/daemon → contract error → render. The populated-candidate-list path is behind `STP_LIVE_PR="owner/repo#number"` and deliberately takes **no screenshot**, because candidate labels are the operator's own workspace and branch names; run that way during development against a repo registered in Paseo it returned `38 candidates, 44 providers` with a rank-2 stack sibling pre-selected. **`/v1/send` deliberately not called** — it would start a real agent. Skips cleanly if the plugin isn't running. |

### GitHub adapter (PLAN.md phase 6, added round four)

Ground truth for every selector: `test/fixtures/github-dom-notes.md`, measured on live
github.com on 2026-09-01. **The `github.ts.todo` skeleton's selectors were all wrong** — see
"What the skeleton got wrong" in that file — so `findAnchor()` was rewritten from measurement.

| # | Test | Result | Real output |
| --- | --- | --- | --- |
| 21 | Button injects into the PR header action row | **PASS** | `appended into prc-PageHeader-Actions-wawWm flex-items-center gap-2 position-relative, immediately after GitHub's Code button`; `imitates Primer's default button: 32px / 6px / 500 14px`. Asserted: marker attribute, `data-stp-mode=anchored`, `data-stp-style=github`, `data-stp-pr=942`, parent **is** the action row, host is its `lastElementChild`, previous sibling's text contains "Code", label "Send to Paseo", exactly 1 host, and the computed metrics `32px / 0px 12px / 6px / 500 / 14px / gap 8px` — the last two being exactly what the skeleton's `600 12px` guess got wrong. |
| 21a | Button colours come from GitHub's own Primer tokens | **PASS** | `sentinel token rgb(1,2,3) on <html> reached the shadow button -> tokens really do inherit`; `light #f6f8fa -> dark #212830 with no JS and no :host-context()`. Overriding `--button-default-bgColor-rest` / `--button-default-fgColor-rest` on `<html>` to sentinel values the extension's own fallbacks could not produce, and reading them back inside the shadow root, is what makes this a proof rather than a coincidence. |
| 21b | Still injects when every Primer hash rotates | **PASS** | `matched prc-PageHeader-Actions-JLAsw (was -wawWm)`. Asserts the two fixtures genuinely differ first, then that the *matched* row carries the **new** hash. |
| 22 | `PrRef` parsed from the URL (owner / repo / number) | **PASS** | `POST /v1/resolve body: {"forge":"github","owner":"acme-labs","repo":"widget.factory","number":5150,"stackPrNumbers":[]}` — from URL `/acme-labs/widget.factory/pull/5150`, while `the fixture DOM says #942 throughout`. Popover header rendered `acme-labs/widget.factory #5150`. A hardcoded PrRef anywhere in the pipeline fails here. |
| 23 | Button appears on every PR sub-route | **PASS** | `button anchored on all 5 sub-routes: /…/pull/942, /…/942/commits, /…/942/checks, /…/942/changes, /…/942/files`. `mode=anchored`, `pr=942`, inside the action row, exactly 1 host, on each. `/changes` is the new name for "Files changed"; `/files` still resolves and is covered too. |
| 24 | Turbo soft navigation between PRs re-targets the button | **PASS** | `pushState 942 -> 948 re-targeted the button and the next resolve`. `history.pushState` executed from the page's MAIN world; button flipped to `data-stp-pr=948`, exactly 1 host, still `anchored`, still `github` style; next `/v1/resolve` carried `number: 948` and `stackPrNumbers: []`; popover header `acmegizmos/gizmo-poc #948`. |
| 25 | Fallback rung when the action row is missing | **PASS** | `no-actions fixture -> anchored-fallback on prc-PageHeader-TitleArea-2n2J0`. Asserts first that the fixture has **0** `prc-PageHeader-Actions` and **0** `.gh-header-actions`, so both primary rungs really are absent. Then, in the same page, `injecting a legacy .gh-header-actions promotes the button back to the primary rung (1 host, relocated)` — the only exercise of rung 2, and simultaneously a test of the relocation path (the button *moves*, it is not cloned). |
| 26 | Floating fallback, and no stack invented from PR hrefs | **PASS** | `position:fixed right:18px bottom:18px`; `page hrefs present (/…/pull/941, /…/pull/943, /…/pull/948) but stackPrNumbers = []`. Asserts all five rungs are absent first. The second half is the anti-scrape guard: a GitHub adapter that copied Graphite's href scrape would report a stack here. |
| 27 | Popover resolves and sends with the right payload | **PASS** | `POST /v1/resolve {"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,"stackPrNumbers":[]}` with `Authorization` present; `POST /v1/send {"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,"prompt":"Rebase this onto main and fix the flaky diff test","target":{"kind":"existing","workspaceId":"wks_4d1a8b7c2e0f9351"},"provider":"claude/claude-opus-5","pageUrl":"http://localhost:4173/acmegizmos/gizmo-poc/pull/942"}`. Exact key set asserted; deep link asserted against the documented shape. Also asserted: **no rank-2 "stack" candidate appears**, which is the visible consequence of `stackPrNumbers: []` and is therefore worth pinning. |
| 28 | **GitHub keyboard containment (regression)** | **PASS** | See "Keyboard containment on GitHub" below. `typed "Fix flaky test? s / c g p t r j k" with real keystrokes; value byte-exact, focus retained`; `bubble-phase hits: 0 · capture-phase hits: 66`. |

Every one of these runs against the real unpacked extension in real Chromium; the only fake is
the bridge.

### Rate limiting (CONTRACT.md item 6, raised to 60 / 10 s)

Real output: `no-Origin: 60 allowed / 10 refused of 70 in 14ms; extension origin unaffected,
then capped`.

Asserted, not sampled:

- 70 no-`Origin` requests in one window → **exactly 60** allowed and **exactly 10** `429
  rate_limited`. Exact equality, not "several 429s" as before.
- The burst's elapsed time is asserted `< 6000 ms` (measured 14 ms) so the exact counts are
  guaranteed to sit inside a single 10 s window — a slow machine fails with that message
  instead of a confusing count mismatch.
- One further no-`Origin` request → still 429, i.e. the bucket really is exhausted.
- **Then, in the same window and from the same remote address**, one request carrying
  `Origin: chrome-extension://<id>` → **200**. This is the Clarifications' keying rule
  ("keyed on the `Origin` header when present, and on the remote address otherwise, so a
  `curl` flood can't consume the extension's budget") demonstrated rather than assumed.
- 70 more requests on that extension origin → its own bucket caps too, so the separate key
  is not an exemption.

`GET /v1/ping` is counted, not exempt, matching the contract's reasoning. The extension's
hint text for `rate_limited` was updated from 30 to 60 accordingly.

### Test infrastructure

| File | Purpose |
| --- | --- |
| `test/mock-bridge.mjs` | Conformance reference for CONTRACT.md v1, updated for the revision: **optional auth on `GET /v1/ping`** (none → `paired:false`+`providers:[]`, valid → `paired:true`+providers, invalid → 401 on every endpoint including ping); **`dryRun` always present** on a 200 send; **tolerates and filters self-inclusive `stackPrNumbers`**; prompt length in **code points**; **bare shell commands in `hint`**; rate limiting at **60 requests / 10 s** keyed on `Origin` when present and on the remote address otherwise. Plus 127.0.0.1-only bind, Origin rule on preflight and real requests, Host rule, CORS echo without `Access-Control-Allow-Credentials`, `Vary: Origin`, 64 KiB cap, all 13 error codes. Failure/behaviour injection via `--fail`, `--contract N`, `--dry-run`, `MOCK_FAIL`, `?fail=<code>`, or `POST /__test/{fail,config,reset}` (refused if an `Origin` header is present, so a browser can never reach it). |
| `test/fixtures/graphite-pr.html` | Reproduction of the captured header action row, metadata section, and 8 stack sibling links **including self**. |
| `test/fixtures/graphite-pr-rotated.html` | Generated by `rotate.mjs`: same DOM, all **41** CSS-module hash suffixes changed. The generator fails loudly if any original token survives. |
| `test/fixtures/graphite-pr-no-anchor.html` | Header and metadata removed; app wrapper and stack links retained. |
| `test/fixtures/github-dom-notes.md` | **New.** What was measured on live github.com on 2026-09-01, with the URLs and dates, plus a table of everything the `github.ts.todo` skeleton got wrong. |
| `test/fixtures/github-pr.html` | Reproduction of the live GitHub PR header: Rails shell (`main#js-repo-pjax-container` > `turbo-frame#repo-content-turbo-frame` > `.repository-content` > `react-app`), the `prc-PageHeader-Actions` row with **View status** and **Code**, both `prc-PageHeader-TitleArea` nodes (real + sticky clone), `nav[aria-label="Pull request navigation"]` with the real tab routes, and the `html[data-color-mode]` attributes plus enough Primer `:root` tokens to read the button's theming back. |
| `test/fixtures/github-pr-rotated.html` | Generated by `rotate.mjs`: same DOM, all **47** hash suffixes changed — both the Primer `prc-Component-Part-hash` shape and GitHub's own `Name-module__part__hash` shape. |
| `test/fixtures/github-pr-no-actions.html` | Action row removed (neither primary rung resolves); title area and tab nav retained, so the **fallback** rung is exercised rather than the floating fallback. |
| `test/fixtures/github-pr-no-anchor.html` | Every rung removed. Deliberately still contains `/pull/{n}` links, as an anti-scrape trap. |
| `test/fixtures/rotate.mjs` | Now runs two jobs (Graphite + GitHub) and understands two token shapes. Fails loudly if any original hash survives, per fixture. |
| `test/fixture-server.mjs` | Serves both shapes: `/github/pr/{owner}/{repo}/{number}/{slug}` (Graphite) and `/{owner}/{repo}/pull/{number}[/{tab}]` (GitHub), each with its own `?fixture=` set. The shapes are disjoint, which is what makes registering both adapters against one localhost origin unambiguous. |
| `test/e2e.mjs` | The suite above. |

## Bugs found and fixed during verification

1. **The `hidden` attribute was defeated by an author `display` rule.** The options page's
   "Grant access to this address" row has `class="row"` with `display: flex`, which overrides
   the UA stylesheet's `[hidden] { display: none }`, so the row was always visible. Fixed with
   `[hidden] { display: none !important; }`; covered by test 10f.
2. **The injected button looked foreign in dark mode.** It used its own surface colour, a
   shade lighter than Graphite's header. Shadow DOM prevents reading the host page's colours,
   so the fix is a `transparent` background with theme-agnostic `rgba()` tints for
   hover/expanded. The floating fallback keeps an opaque surface because it overlaps content.
3. **The rotated-fixture generator mangled compound CSS-module names.** A greedy regex turned
   `styles_gap__s__zuWdb` into `styles_gap__<hash>`, changing the stable part of the name.
   Fixed to split on the *last* `__`, which also handles Graphite's real hashes that begin or
   end with `_` (`Button_gdsButtonText__5kyh_`, `AgentChatSidebarSelector_splitButton___pVbq`).
4. **`fetch()` silently ignores a `Host` header override**, so the DNS-rebinding test was
   asserting nothing. Rewritten over a raw TCP socket, which is also closer to the real attack.
5. **The options page wrote to storage during a read-only page load.** `load()` called
   `testConnection()`, which flushed the input fields back into `chrome.storage` — so merely
   opening the page could clobber a concurrent write. Found because it broke five tests at
   once when the e2e harness used the options page to seed settings. Fixed with
   `testConnection({ flush: false })` on load, and the harness now seeds storage through the
   **service worker** with a read-back assertion so a silently-no-op seed can never
   invalidate a test again.
6. **The contract-version check was cached for 60 s.** That meant a plugin updated while the
   composer sat open could still be sent to — a hole in the contract's "refuse to send"
   requirement. The cache (and its `chrome.storage.onChanged` invalidation) was removed;
   the gate now re-pings before every resolve and every send. Test 16(b) is the guard.
7. **`assertEq` was order-sensitive on object keys.** `chrome.storage` returns keys sorted,
   so a correct value compared unequal. Replaced with a stable stringify that sorts object
   keys and preserves array order.


Cosmetic, reported by the coordinator from a crop of the live screenshot:

8. **Symbol-only keycaps rendered smaller and lighter than lettered ones.** The mono face
   draws `⌘` and `↵` at a small optical size, so at the shared 10.5 px they looked weaker than
   `Esc` in the popover footer. Symbol caps now carry a `sym` class and render at 13 px in the
   UI face, with `kbd` given `inline-flex` centring and a `min-width` so the caps line up.
   Text content is unchanged; test 4 asserts every symbol cap computes a larger font size than
   every lettered one, so the fix cannot silently regress.


Found in round four, building the GitHub adapter:

9. **Every primary selector in the `github.ts.todo` skeleton was wrong.** It had been written
   from memory. Measured on live github.com on 2026-09-01:
   `[data-testid="pr-header-actions"]` does not exist (the PR header has **no** `data-testid`
   at all); `#partial-discussion-header` and `.gh-header-actions` do not exist — 0 occurrences
   in the server HTML and the live DOM on all seven PRs checked; and
   `react-app[app-name='react-code-view']` does not exist either (there is a `react-app`, with
   no `app-name`, and it is *replaced* by a cross-page Turbo navigation, so observing it would
   have been wrong even if the selector had matched). The skeleton's claim that "GitHub has
   real, stable data-testids … no `[class*=]` gymnastics needed" is false: the header is
   Primer React with rotating CSS-module hashes, exactly the Graphite problem.
   `findAnchor()` and `observeTarget()` were rewritten from measurement; the measurements are
   in `test/fixtures/github-dom-notes.md`.
10. **The `styleHint()` GitHub branch's font was wrong.** It guessed `600 12px`; Primer's
    default button is `500 14px`. Also missing: the 8px gap, the real surface colours, and the
    `0 1px 0 rgba(31,35,40,.04)` resting shadow. Corrected against the live "Code" button and
    pinned by test 21.
11. **`--fgColor-default` is not the colour Primer's buttons use.** Caught by the first live
    capture, which showed our text at `rgb(31,35,40)` next to GitHub's `rgb(37,41,46)` — a
    real 6/6/6 mismatch on a button meant to be indistinguishable. The token is
    `--button-default-fgColor-rest`. Re-measured after the fix: byte-identical in both themes.
12. **A measurement artifact that would have produced a false green.** `button` carries
    `transition: background 90ms ease`, so reading `getComputedStyle(...).backgroundColor`
    immediately after a colour-scheme flip samples the *interpolated* value — the first run of
    test 21a failed with `rgb(89, 94, 101)`, exactly 26 % of the way from `#212830` to
    `#f6f8fa`. The same artifact had quietly produced a washed-out "dark theme" screenshot.
    Both now settle for 250 ms first. Worth recording because the failure mode is a
    plausible-looking colour, not an obvious error.

## Changes made for the revised CONTRACT.md

| Contract change | Extension change |
| --- | --- |
| `GET /v1/ping` takes optional auth and returns `providers` | `ping({ authenticated })` in `bridge-client.ts`; the options page's provider picker is a real `<select>` populated from the authenticated ping. **The `<datalist>` workaround is gone.** |
| Ping distinguishes bridge-down / bad-token / paired | Options page has five distinct outcomes with their own tone and headline (tests 10a–10e). |
| `dryRun` always present on a 200 send | Typed as required; surfaced with a distinct headline, badge, note and relabelled deep link (test 17). |
| Bridge tolerates self-inclusive `stackPrNumbers` | Mock updated to filter rather than reject; the extension still filters the current PR itself. |
| `contract` mismatch must refuse to send | `requireCompatibleContract()` gates both `/v1/resolve` and `/v1/send`, uncached (test 16). |
| `error.message` plain prose, `hint` bare commands | Formatting moved into `src/shared/format.ts`, driven by an exact-match `KNOWN_COMMANDS` list rather than a regex. The mock now sends bare commands. |
| `prompt` length in Unicode code points | `promptLength()` uses `[...text].length`; the mock counts the same way. |
| Rate limiting keyed on Origin, else remote address | Mock updated; test 12 proves the keying by exhausting one bucket and showing the other unaffected. |
| Rate limit raised 30 → **60 requests / 10 s**, `/v1/ping` still counted | Mock `RATE_MAX = 60`; the `rate_limited` hint now says 60; test 12 asserts exactly 60 allowed of 70. |
| Additive fields, ignore unknown | Client types treat unknown fields as ignorable; unknown error codes still get a specific headline naming the code. |

## Keyboard containment (bug reported by the user, 2026-09-01)

**Symptom reported:** "while typing in the extension's input box, graphite shortcuts are
triggering, and it's interfering with the extension."

**Root cause, measured on live `app.graphite.com`, not inferred.** Keyboard events are
`composed`, so they cross the shadow boundary, and outside the shadow tree they are
*retargeted*: every one of Graphite's global listeners saw

```
seenTarget: "send-to-paseo-popover"
```

instead of our `<textarea>`. Graphite's shortcut layer asks "is the user typing in a text
field?", sees an opaque custom element, answers no, and treats each keystroke as a shortcut —
including stealing focus. The damage was worse than reported: typing

```
Fix merge conflicts? c/j k n p a g r
```

into the popover produced the literal value `"x "`, with `focusRetained: false`. Not merely
stray shortcuts — the composer was unusable.

**What Graphite actually binds** (instrumented `addEventListener` from `document_start`,
before its bundle ran): `keydown` on `window` bubble *and* capture, `document` bubble *and*
capture, and `body` both phases — from its own page chunk, `vendor-ariakit`, `vendor-mobx`
and `vendor-datadog` (RUM). 139 key-listener registrations in total.

**Fix:** `containKeyboard()` in `src/content/ui/keyboard.ts` stops the composed keyboard,
composition and clipboard events at the shadow host, in **bubble** phase — after our own
in-shadow listeners have run, so Cmd/Ctrl+Enter and link activation still work, and without
`preventDefault`, so characters still reach the textarea. Applied to both shadow hosts (the
popover and the button).

### Measured before and after, live Graphite, real keystrokes

| | Without containment | With containment |
| --- | --- | --- |
| Typed value | `"x "` | `"Fix merge conflicts? c/j k n p a g r"` (exact) |
| Focus retained in textarea | no | yes |
| `ArrowUp`/`ArrowDown`/`Escape` | stole focus | no side effect |
| Bubble-phase page listeners reached | many | **0** |

### End-to-end on live Graphite with the real popover code

The shipping `dist/content.js` was injected into the real authenticated PR #942 page, the
real button clicked, the textarea entered with a **real mouse click**, and the prompt typed
with **real keystrokes**:

```json
{ "buttonPresent": true, "mode": "anchored",
  "typedValue": "Fix merge conflicts? c/j k n p a g r", "typedCorrectly": true,
  "focusInTextarea": true, "popoverStillOpen": true, "sendEnabled": true,
  "bubbleHits": 0, "captureHits": 468,
  "retargetedTargets": ["send-to-paseo-popover"] }
```

That measurement was made, and the JSON above is the whole of its published evidence: **no
screenshot of it is included in this repository**. The capture was of a private pull request
and showed internal PR content, real colleagues' names and real logins, so it was withheld
rather than redacted. Graphite has no unauthenticated equivalent to re-capture against — it
only ever renders the signed-in user's own private repositories — so there is no public
substitute for this one. `docs/screenshots/keyboard-containment-typed.png` is the *fixture*
equivalent (test 19), rendered from `test/fixtures/graphite-pr.html` and regenerated by every
suite run; it is not this measurement. No send was performed — no agent was created for this
test.

### Regression test, and proof it can fail

Test 19 installs a faithful stand-in for Graphite's shortcut layer (both phases on
`window`/`document`/`body`; only the bubble handlers act, mirroring the measurement) and
types for real. It asserts the value byte-for-byte, focus retention, and **zero** bubble-phase
hits, and it first asserts that the hostile listeners really saw the retargeted host so the
test cannot pass vacuously.

Verified as a genuine regression test by stubbing out `containKeyboard` and re-running.
Re-verified in round four, with both regression tests now in place:

```
=== 39 passed, 2 failed, 0 skipped (of 41) ===
FAIL  19. Host-page keyboard shortcuts cannot reach the popover (regression)
      keystrokes must reach the textarea byte-for-byte
    expected: "Fix merge conflicts? c/j k n p a g r"
    actual:   ""
FAIL  28. GitHub: host-page keyboard shortcuts cannot reach the popover (regression)
      keystrokes must reach the textarea byte-for-byte
    expected: "Fix flaky test? s / c g p t r j k"
    actual:   ""
```

Restored, the full suite is 41/41. (The stub was `if (1 as number) return () => {};` at the top
of `containKeyboard`, removed immediately afterwards; `grep -c "TEMPORARY STUB"` on the file is
`0`.)

**Why the existing suite missed this.** Test 6 types with Playwright's `locator.fill()`, which
assigns `value` and dispatches no keyboard events at all. No amount of fixture fidelity would
have caught it; only real keystrokes against real host-page handlers do.

### The ceiling, stated plainly

Capture-phase listeners on `window` are the first step of event propagation, and our content
script runs at `document_idle`, so **no listener we can register runs before them and nothing
we do can stop them.** They fired 468 times during the live test and took no action. If
Graphite ever moves a shortcut into a `window`-capture listener, this approach cannot fix it
and no variation of it can; the fix would be moving the composer into an extension-page
`<iframe>`, whose key events never enter the page's propagation path. That cost is not
justified by today's evidence.

Related, unfixed and unreported: **mouse** events also escape the shadow root and reach
Graphite's document-level handlers. No misbehaviour has been observed (clicking into the
textarea and dragging to select text both work), so this was left alone rather than
speculatively contained.


## Keyboard containment on GitHub (round four)

The same hazard, verified rather than assumed.

**What GitHub actually binds.** `EventTarget.prototype.addEventListener` was instrumented from
`document_start` (`page.addInitScript`, before GitHub's bundles ran) and a PR page loaded
normally: **390** key-listener registrations
(`keydown`/`keyup`/`keypress`/`beforeinput`/`input`/`paste`). The global `keydown` ones:

| target | phase | registrations |
| --- | --- | --- |
| `document` | **capture** | **45** |
| `document` | bubble | 20 |
| `window` | **capture** | **2** |
| `window` | bubble | **0** |
| `body` | either | **0** |

Registering asset chunks (`keydown` only): `primer-react.js` 133, `r1.js` 42, `fbt.js` 39,
`j0.js` 27, `chunk-lazy-element-reactions-menu.js` 16, `react-dom-client.js` 10, `nn.js` 9,
`by.js` 5, `chunk-oa.js` 4, `ph4.js` 4, `behaviors.js` 2, and one each from `hotkey.js`
(`@github/hotkey` — the layer behind `s`, `/`, `c`, `t`, `g c`, `j`/`k`), `catalyst.js`,
`diffs.js` and six others.

This is Graphite's problem again: `@github/hotkey` decides whether a key is a shortcut from
`isFormField(event.target)`, and shadow-DOM retargeting hands it our custom element instead of
our `<textarea>`. `containKeyboard()` is inherited for free (it is called from `button.ts` and
`popover.ts`), but the point of round four was to measure it on the real site, not assume it.

The ceiling here is the same shape and slightly *better* than Graphite's: 47 capture-phase
global `keydown` listeners are unreachable from a `document_idle` content script, but there are
**zero** bubble-phase `window` listeners, so bubble containment at the host covers everything
we can reach.

### End-to-end on live github.com with the real popover code

The shipping `dist/content.js` was injected into the real, authenticated
`github.com/acmegizmos/gizmo-poc/pull/942` with `page.addInitScript` (CSP-safe, runs at
`document_start`), the real button clicked with a **real mouse click**, the textarea entered
with a **real mouse click**, and the prompt typed with **real keystrokes**
(`page.keyboard.type`, 25 ms delay). `locator.fill()` was deliberately not used anywhere: it
assigns `value` and dispatches no key events, which is exactly how the original containment bug
reached a user.

Button placement:

```json
{ "url": "https://github.com/acmegizmos/gizmo-poc/pull/942",
  "buttonPresent": true, "hostCount": 1, "mode": "anchored", "style": "github", "pr": "942",
  "parentClass": "prc-PageHeader-Actions-wawWm flex-items-center gap-2 position-relative",
  "parentIsActionRow": true, "isLastChild": true, "label": "Send to Paseo",
  "colorMode": "auto" }
```

Our button vs GitHub's own **Code** button, both read with `getComputedStyle` on the same page —
**byte-identical on every property measured, in both themes**:

| | ours (light) | Code (light) | ours (dark) | Code (dark) |
| --- | --- | --- | --- | --- |
| height | 32px | 32px | — | — |
| padding | 0px 12px | 0px 12px | — | — |
| border-radius | 6px | 6px | — | — |
| font | 500 / 14px | 500 / 14px | — | — |
| gap | 8px | 8px | — | — |
| background | `rgb(246,248,250)` | `rgb(246,248,250)` | `rgb(33,40,48)` | `rgb(33,40,48)` |
| color | `rgb(37,41,46)` | `rgb(37,41,46)` | `rgb(240,246,252)` | `rgb(240,246,252)` |
| border-color | `rgb(209,217,224)` | `rgb(209,217,224)` | `rgb(61,68,77)` | `rgb(61,68,77)` |
| box-shadow | `rgba(31,35,40,.04) 0 1px 0` | same | none | none |

No screenshot of *this* pass is published: it was a private pull request. The two states are
published as `docs/screenshots/real-github-injected-button.png` and `…-dark.png`, **re-captured
against a public pull request** — see "Re-captured for publication" below, where the same
property table was re-measured and came out identical.
The dark values arrived with **no JS and no re-render** — GitHub's tokens are inherited
properties and cross the shadow boundary. (The first live pass exposed a real one-token
mismatch: we used `--fgColor-default` (`#1f2328`) where Primer's buttons use
`--button-default-fgColor-rest` (`#25292e`). Fixed, and the table above is the re-measurement.)

Resolved against the **real** plugin bridge on `127.0.0.1:7788`:

```json
{ "phase": "ready", "prref": "acmegizmos/gizmo-poc #942",
  "candidateCount": 38, "providerCount": 44, "providerValue": "claude/claude-opus-5",
  "selected": "goofy-falcon — giz-1132-retire-legacy-cache-flag (stack #948, 1 agent)",
  "summary": "→ workspace goofy-falcon · stack #948 … worktree is on another branch of this stack" }
```

Then typing, with GitHub's shortcut layer live:

```json
{ "typedValue": "Fix flaky test? s / c g p t r j k", "typedCorrectly": true,
  "focusInTextarea": true, "activeElementOutside": "send-to-paseo-popover",
  "focusStolen": false, "popoverStillOpen": true, "sendEnabled": true,
  "bubbleHits": 0, "captureHits": 66,
  "retargetedTargets": ["send-to-paseo-popover"] }
```

**bubble-phase hits: 0. capture-phase hits: 66.** Every token in that prompt is a live GitHub
single-key shortcut (`s` and `/` search, `c` create, `g` prefix, `p`, `t` file finder, `r` quote
reply, `j`/`k` list navigation). `retargetedTargets: ["send-to-paseo-popover"]` is the
anti-vacuity guard: the page-level listeners really did fire and really did see the retargeted
shadow host, so a `0` in the bubble column means containment, not absence of events. No
screenshot of this pass is published either, for the same reason;
`docs/screenshots/real-github-keyboard-containment.png` is the **re-capture against a public
pull request** described below.

Sub-route soft navigation, on the live page, by clicking GitHub's own tabs:

```
/acmegizmos/gizmo-poc/pull/942/commits   present:true count:1 pr:942 mode:anchored inRow:true
                                          nav: ["pushState …/942/commits", "soft-nav:end"]
/acmegizmos/gizmo-poc/pull/942/changes   present:true count:1 pr:942 mode:anchored inRow:true
                                          nav: ["pushState …/942/changes", "soft-nav:end"]
```

That confirms two things measured earlier and asserted in the suite: Turbo does call
`history.pushState` on a soft navigation (so the existing MAIN-world shim is sufficient), and
`soft-nav:end` — not `turbo:load` — is the event that accompanies a same-PR tab switch.

**No send was performed and no agent was created.** The shim standing in for the service
worker refuses every bridge path except `/v1/ping` and `/v1/resolve` by construction, and
returns a `blocked_by_verification` error for `send`. `/v1/send` on GitHub was verified against
the mock bridge only (test 27).

### Re-captured for publication, on a public pull request

Every pass above ran against a private pull request, so none of its screenshots could be
published. The GitHub states were therefore re-captured, with the same technique, against
a **public** one: `https://github.com/rails/rails/pull/58627` ("Make ActionPack settings
instance variables"). Four files came out of that URL:
`docs/screenshots/real-github-injected-button.png`, `…-dark.png`,
`…-keyboard-containment.png`, and — added in a second sitting later the same day —
`docs/screenshots/hero-github-pr-popover.png`, the README hero.

What was live in the re-capture, and what was not:

- **Live:** github.com's own DOM and stylesheets, on a real PR page in a real Chromium. The
  shipping `extension/dist/content.js` — the same bytes `npm run build` produces — with
  `mainworld.js` injected at `document_start` via `page.addInitScript` (CSP-safe) and
  `content.js` evaluated after `load`, which is where the manifest's `run_at: "document_idle"`
  puts it. The button click, the click into the textarea and every keystroke were real input
  events (`page.keyboard.type`, 25 ms delay); `locator.fill()` was not used.
- **Not live: the bridge.** The service-worker shim answered `/v1/resolve` from a **local
  stub**, not from the plugin bridge, because the real bridge only ever returns the capturing
  developer's own private workspaces and branches and those must not be published. The
  workspace labels, ids and paths in the composer (`brawny-dodo`, `wks_…`,
  `~/.paseo/worktrees/…`) are therefore the same synthetic values the test fixtures use. The
  branch, base branch, PR number and title are the public PR's real ones. `send` is refused by
  the shim by construction, so **no agent was created**.
- **Cropped, not edited.** Each image is a crop of the live page — element bounds for the two
  button shots (the PR header) and the containment shot (header plus popover), and an explicit
  `page.screenshot({ clip: { x: 105, y: 112, width: 1236, height: 506 } })` rectangle at a
  1460×1020 viewport for the hero. Cropping keeps the signed-in account's avatar, notification
  counters and account menu, which all sit in GitHub's top app bar, out of frame. No pixels were
  retouched and no DOM was hidden or restyled for any shot.

### The hero frame

`docs/screenshots/hero-github-pr-popover.png` exists to answer one question in one glance: *is
this really a pull request, and what does the extension actually put on it?* Captured the same
way as the three above, on the same public PR, Conversation tab, light theme
(`emulateMedia({ colorScheme: "light" })`), with the composer open and the instruction
`Fix the flaky test in this PR` typed with real keystrokes at 25 ms. Asserted during the capture,
before the shutter:

```json
{ "hostCount": 1, "injectionMode": "anchored", "style": "github", "pr": "58627",
  "parentClass": "prc-PageHeader-Actions-wawWm flex-items-center gap-2 position-relative",
  "parentIsActionRow": true, "isLastChild": true, "label": "Send to Paseo",
  "colorMode": "auto",
  "phase": "ready", "prref": "rails/rails #58627",
  "summaryLines": ["→ workspace brawny-dodo", "actionpack-singleton-class-attrs · rails"],
  "selectedCandidate": "brawny-dodo — actionpack-singleton-class-attrs (exact match, 2 agents)",
  "providerSelect": "Opus 5 (default)", "modeSelect": "Auto mode (default)",
  "typedValue": "Fix the flaky test in this PR", "focusInTextarea": true,
  "sendEnabled": true, "bubbleHits": 0, "captureHits": 146,
  "retargetedTargets": ["send-to-paseo-popover"] }
```

(`injectionMode`, `providerSelect`, `modeSelect` and `summaryLines` are renamed and reshaped from
the raw probe output only to avoid two different `mode` keys in one object and to show the target
summary as the two lines it really renders as; every value is verbatim.)

`hostCount: 1` is asserted rather than eyeballed, and the capture aborts if it is anything else.
It matters because injecting `content.js` at `document_start` instead of after `load` races React
re-rendering the PR header and was observed to produce **two** button hosts during an earlier
sitting — a capture artifact of this technique, not an extension bug, since the manifest really
does load `content.js` at `document_idle`. The `bubbleHits: 0 / captureHits: 146` pair is the same
keyboard-containment measurement as above, taken again on this frame rather than assumed.

In frame: the PR title with `#58627`, the green **Open** pill, `etiennebarrie wants to merge 2
commits into rails:main from Shopify:actionpack-singleton-class-attrs`, the **Conversation /
Commits / Checks / Files changed** tab bar, the **Send to Paseo** button in GitHub's action row in
its expanded state, and the whole composer down to the ⌘↵ / Esc footer and an enabled **Send**.
Out of frame: GitHub's top app bar. Still in frame, deliberately accepted: the PR author's public
avatar and login beside their comment, which are public data on a public PR. The PNG carries no
`tEXt`, `iTXt`, `eXIf` or `tIME` chunk (`IHDR`/`IDAT`/`IEND` only), and a raw-byte grep for
the author's macOS username, real name, both GitHub logins, the private org and repo
names, and `/Users/` finds nothing. (Those terms are deliberately not spelled out here: writing
them down would put back into this repository exactly what the sweep exists to keep out.)

Button placement and metrics, re-measured on the public page:

```json
{ "url": "https://github.com/rails/rails/pull/58627",
  "buttonPresent": true, "hostCount": 1, "mode": "anchored", "style": "github", "pr": "58627",
  "parentClass": "prc-PageHeader-Actions-wawWm flex-items-center gap-2 position-relative",
  "parentIsActionRow": true, "isLastChild": true, "label": "Send to Paseo",
  "colorMode": "auto" }
```

Against that page's own **Code** button, both read with `getComputedStyle`: `32px` height,
`0px 12px` padding, `6px` radius, `500 / 14px` font, `8px` gap, and in light theme
`rgb(246,248,250)` / `rgb(37,41,46)` / `rgb(209,217,224)` / `rgba(31,35,40,.04) 0 1px 0` —
**identical on every property, and identical to the table above**. Dark theme was produced by
flipping `prefers-color-scheme` only (the page carries `data-color-mode="auto"`), so no JS ran
and nothing re-rendered; both buttons moved together to `rgb(33,40,48)` / `rgb(240,246,252)` /
`rgb(61,68,77)` / no shadow.

Typing, with GitHub's shortcut layer live on the public page:

```json
{ "typedValue": "Fix flaky test? s / c g p t r j k", "typedCorrectly": true,
  "focusInTextarea": true, "activeElementOutside": "send-to-paseo-popover",
  "focusStolen": false, "popoverStillOpen": true, "sendEnabled": true,
  "bubbleHits": 0, "captureHits": 166,
  "retargetedTargets": ["send-to-paseo-popover"] }
```

Global `keydown` registrations counted by the same passive instrumentation, installed at
`document_start` before GitHub's bundles ran and *before* our content script was evaluated:
`document` bubble **20**, `document` capture **3**, `window` capture **2**, `window` bubble
**0**, `body` either **0**. The bubble and `window` figures reproduce the earlier measurement
exactly; the capture figure is lower than the 45 recorded above because this pass exercised
fewer of GitHub's lazily-loaded chunks. The conclusion is unchanged and is the one that
matters: **0** bubble-phase hits with `retargetedTargets: ["send-to-paseo-popover"]` proving
the page's listeners did fire and did see the retargeted host.

## Honest limitations

- **Test 11 cannot enumerate the content script's isolated-world closure variables.**
  Playwright's `page.evaluate` runs in the MAIN world, and there is no API to inspect an
  extension's isolated-world scope. What test 11 *does* prove: the token is absent from the
  serialized DOM, every open shadow root, every attribute, `window`'s own string properties,
  `localStorage` and `sessionStorage`; the page world cannot see `chrome.storage`; and —
  statically, against the built bundles — `content.js` and `mainworld.js` contain no
  occurrence of `Bearer`, `Authorization`, `chrome.storage` or the token value, while
  `background.js` contains the first two. Strong, but structural evidence plus static
  analysis, not a direct read of the isolated heap.
- **The mock bridge port is 7799, not 7788.** The real `send-to-paseo` plugin is listening on
  7788 during development, and killing it would disrupt the other half of the project. The
  test build adds `http://127.0.0.1:7799/*` to `host_permissions`; test 18 asserts the
  shipping build does not. Test 13 uses the real 7788.
- **`/v1/send` has never been exercised against the real plugin** from the extension — only
  against the mock. Doing so would start a real agent. The request body shape was verified
  byte-for-byte against the mock, and `/v1/ping` + `/v1/resolve` were verified against the
  real bridge.
- **`SEND_TO_PASEO_DRY_RUN=1` was not exercised on the real plugin.** Test 17 drives the mock
  into `dryRun: true` via its control endpoint and asserts the extension's rendering. Whether
  the real plugin honours the env var is the plugin's own verification.
- ~~**`styleHint()` is wired but only one branch is reachable.**~~ **Resolved in round four.**
  Both branches ship and both are asserted: test 1 for `"graphite"`, test 21 for `"github"`
  plus its computed metrics, and test 21a for its token-driven theming.
- **This suite never loads real Graphite or real github.com.** All DOM testing in `e2e.mjs`
  is against fixtures reproduced from `test/fixtures/graphite-dom-notes.md` and
  `test/fixtures/github-dom-notes.md`; if a live site differs from the capture in a way the
  notes don't record, the fixtures inherit that error. The hash-rotation tests (2 and 21b) are
  designed to make the most likely such drift harmless. The live captures described in
  "Keyboard containment" and "Keyboard containment on GitHub" are the counterweight, and they
  are one-off measurements, not suite assertions.

  Separately — and this does not change the limitation above — the coordinator did run the
  shipping `dist/content.js` against the real authenticated `app.graphite.com` PR #942. In that
  pass the Graphite DOM and the `/v1/resolve` data were live; the **transport** was not, because
  the bridge correctly rejects `Origin: https://app.graphite.com`, so a test shim stood in for
  the service worker and the `REPLAY_PENDING` agent id was that shim's placeholder. Real agent
  creation was verified out-of-band: the captured intent was replayed by `curl` against the live
  bridge, creating a real agent that received the composed prompt, replied `ACK`, and was then
  deleted. None of that is asserted by this suite.

  **None of that pass is published.** Graphite requires authentication and shows only the
  signed-in user's own private repositories, so the popover, typed and success captures contained
  private PR titles, colleagues' names and real logins, and were deleted rather than committed.
  One frame did survive for a while — `docs/screenshots/real-graphite-injected-button.png`, a bare
  strip of the PR header action row with no title, repository, branch or avatar in it — and it
  was **deleted on 2026-09-01** when the README's two hero images were replaced by a single
  GitHub one. So there is now **no live Graphite screenshot in this repository at all**: the pass
  described above is evidenced by the text in this file and nothing else, and every Graphite
  screenshot in `docs/screenshots/` is fixture-derived and regenerated by `node test/e2e.mjs`.
- **GitHub-specific limitations and risks, stated plainly.**
  - **`findAnchor()` rung 1 and rung 3 use `[class*=]`.** There is no id, no `data-testid` and
    no ARIA role on either the action row or the title area — the whole PR header has none —
    so the house rule's escape hatch was taken, with a written reason in the source. The hash
    is a *suffix*, so prefix-contains survives a Primer release (test 21b), no data is ever
    read from those nodes, and four more rungs plus a floating fallback sit behind them.
  - **Rung 2 and rung 5 (the legacy `#partial-discussion-header` / `.gh-header-actions`
    layout) were never observed.** Zero occurrences on all seven live PRs measured, in the
    server HTML and the live DOM. They are kept because they cost two lines and Enterprise
    Server trails dotcom, but the only thing exercising them is a synthetic DOM insertion in
    test 25 — **not** a captured page, because there was no such page left to capture.
  - **Only one GitHub header variant was measured.** All seven PRs (open and merged, four
    repos, logged in) rendered identically: one `prc-PageHeader-Actions`, two
    `prc-PageHeader-TitleArea`, one tab nav. GitHub ships behind per-repo/per-user flags, so a
    variant with no action row is plausible — which is exactly why the fallback rungs and the
    `github-pr-no-actions.html` fixture exist. **Logged-out** GitHub *was* measured, once,
    during the public re-capture: `prc-PageHeader-Actions` is still present but carries `d-none`
    and is **empty** — no **Code** button, no **View status**. So on a logged-out PR page rung 1
    still matches and the button anchors into a row the page has hidden, which means it renders
    nowhere visible. That is not a case the extension is for (there is nothing to send without a
    Paseo project and a signed-in forge), and it is not covered by a fixture; it is recorded here
    because it is a real, measured gap in the anchor ladder's assumptions.
  - **`stackPrNumbers` is `[]` on GitHub and always will be from this adapter.** That is
    contract-legal and, since the bridge derives the stack from `gh pr list`, almost always
    invisible. The one case where a user is worse off on GitHub than on Graphite: a stack whose
    sibling PR is **closed or merged** — `viewStackGraph` walks `listOpenPrs` only, so such a
    sibling is invisible to both sides and no rank-2 candidate is offered for it. The cost is a
    worse *default* in the picker, never a wrong send: the user always confirms explicitly.
  - **`https://github.com/*/*/pull/*` is broader than the PR route.** Chrome's path wildcards
    match `/` too, so the content script also loads on a hypothetical
    `/a/b/c/pull/anything`. Harmless — the adapter's `PR_PATH` regex rejects it and no button
    is injected — but it is real extra surface, and it is the price of MV3 match patterns not
    supporting a segment-scoped wildcard.
  - **The live capture's transport was shimmed.** As with Graphite: the bridge correctly
    rejects `Origin: https://github.com`, so a Playwright-side proxy stood in for the service
    worker. In the private-PR pass the GitHub DOM and the `/v1/resolve` data were both real;
    the HTTP hop from a real service worker is only covered against the mock bridge. In the
    **published** re-capture against `rails/rails#58627` the `/v1/resolve` data is a local
    stub as well, deliberately — see "Re-captured for publication" — so those three
    screenshots evidence the DOM, the anchoring, the theming and the keyboard containment, and
    nothing about the bridge.
- **Chrome version coverage is one build.** Chromium 1223 only. `world: "MAIN"` in
  `content_scripts` requires Chrome 111+, declared via `minimum_chrome_version`, but older
  Chrome was not tested. The 1 s location poll exists as the backstop for that case.
- **The optional-host-permission grant flow is only partially covered.** Test 10f asserts the
  row stays hidden when the URL is already permitted; the actual `chrome.permissions.request()`
  path (a native Chrome dialog) is not driven by the suite.
- ~~**Rate-limit keying by remote address is not differentially tested.**~~ Now covered:
  test 12 exhausts the no-`Origin` bucket and then shows a `chrome-extension://` origin still
  getting a 200 from the same address in the same window. What remains untested is keying
  across *different* remote addresses, which a loopback-only bridge makes moot.

## Contract observations

Two earlier observations were **resolved by the coordinator in CONTRACT.md** and are struck
below rather than deleted, so the history is legible:

1. ~~**No way to enumerate providers without a PR.**~~ **RESOLVED** — `GET /v1/ping` now takes
   optional auth and returns `providers`. The `<datalist>` workaround has been removed; the
   options page uses a real `<select>` populated from the authenticated ping (test 10a).
2. ~~**`paired` can never become true from the options page alone.**~~ **RESOLVED** — an
   authenticated ping now returns `paired: true`, and an invalid token returns 401, so "Test
   connection" genuinely validates the token (tests 10a–10c, 15).

Still open, all minor, none blocking:

3. **`prompt` max (16 000 code points) and the body cap (64 KiB) can disagree.** Now explicitly
   documented in the Clarifications as intended behaviour, so this is no longer a defect —
   noted only because the extension pre-checks code points and maps a 413 to "Message too
   long", meaning the user sees a length complaint either way.
4. ~~**Rate limiting "per origin" is tight for interactive use.**~~ **RESOLVED** — the
   coordinator raised CONTRACT.md item 6 from 30 to **60 requests / 10 s**, with the reasoning
   recorded inline: the uncached contract gate costs 4 requests per completed send (ping,
   resolve, ping, send), so 30/10 s allowed only ~7 sends per window and 60 allows ~15.
   `GET /v1/ping` stays **counted rather than exempt**, deliberately, to keep the bound total —
   the limit is defence-in-depth on a loopback-only, token-gated bridge. The mock and the
   extension's `rate_limited` hint were updated to 60, and test 12 now asserts the new
   threshold exactly plus the Origin-vs-remote-address keying. The uncached gate stays.
5. **`defaultCandidateIndex` bounds** are now specified as always valid; the extension still
   clamps out-of-range or non-integer values to 0 rather than trusting it. Defensive, not a
   complaint.
6. **Observed, not required:** Chrome's MV3 service worker *does* send
   `Origin: chrome-extension://<id>` on these fetches (confirmed in the mock's request log).
   The contract tolerates both present and absent, which is right — just noting the real
   behaviour so the plugin side doesn't depend on the absence.

`deepLink` is treated as an **opaque** string throughout: rendered straight into the `href`,
never constructed, never parsed, and asserted only by shape.

## Reproducing

```bash
cd extension && npm install
npm run typecheck
npm run build
node ../test/e2e.mjs          # 44 cases, ~60 s, headless by default
                              # STP_HEADED=1 node ../test/e2e.mjs  to watch it
```

The suite regenerates `test/fixtures/graphite-pr-rotated.html` **and
`test/fixtures/github-pr-rotated.html`**, builds both `dist-test/` and `dist/`, starts both
servers, and writes every screenshot in `docs/screenshots/`. It cleans
up its Chrome profile and both servers on exit. If a previous run was killed mid-way, free
ports 4173 and 7799 first.
