# Send to Paseo — Chrome extension (MV3)

Puts a **Send to Paseo** button on Graphite **and github.com** PR pages. Click it, type an
instruction, and a new Paseo agent starts in the workspace that belongs to that PR's branch —
creating a worktree workspace if none exists.

| Site | Content-script match | Anchor |
| --- | --- | --- |
| Graphite | `https://app.graphite.com/github/pr/*`, `…graphite.dev…` | before **Review Changes** in the PR header |
| GitHub | `https://github.com/*/*/pull/*` | appended to the PR header action row, right of **Code** |

The extension never talks to the Paseo daemon. It talks only to the `send-to-paseo`
plugin's local HTTP bridge, over the frozen contract in [`../CONTRACT.md`](../CONTRACT.md).

---

## ⚠️ Three things that will silently break if you change them

**1. `mainworld.js` must stay a `world: "MAIN"` content script.**

A content script runs in an **isolated world**: it shares the DOM with the page but has its
own JS wrappers for every global, `history` included. Patching `history.pushState` from the
isolated content script therefore does **not** observe the page's own navigations —
Graphite's router calls the *page's* `history.pushState`, and the isolated patch never
fires. The button would then keep pointing at the PR you first loaded while you browsed the
stack, and a send would go to the wrong PR.

So the patch lives in `src/content/mainworld.ts`, registered as a second content script with
`"world": "MAIN"` in the manifest, and hands the signal to the isolated world as a DOM
`CustomEvent` (DOM events *do* cross worlds). If you ever "simplify" this by folding the two
scripts together, SPA navigation detection dies quietly — the extension will look fine on a
cold page load and be wrong on every subsequent PR. `test/e2e.mjs` case 8 is the guard: it
calls `history.pushState` from the page's MAIN world and asserts the next `/v1/resolve`
carries the new PR number.

There is a 1 s `location.href` poll as a backstop for the case where a page CSP blocks the
MAIN-world script, but it is a safety net, not the mechanism.

**2. The contract-version gate is intentionally not cached.**

`requireCompatibleContract()` pings before every `/v1/resolve` **and** every `/v1/send`. An
earlier draft memoised it for 60 s, which meant a plugin updated while the composer sat
open could still be sent to. CONTRACT.md says the extension must *refuse to send* on a
mismatch; that is a guarantee, and one loopback round trip is far cheaper than the call it
guards.

**3. `containKeyboard()` is not defensive tidying — the composer does not work without it.**

Shadow DOM isolates CSS, not events. Keyboard events are `composed`, so they escape our
shadow root, and outside it they are **retargeted**: Graphite's global listeners see
`event.target === <send-to-paseo-popover>`, never our `<textarea>`. Its shortcut layer asks
"is the user typing in a text field?", sees an opaque custom element, answers no, and
consumes the keystroke — stealing focus in the process. Measured on live Graphite: typing
`Fix merge conflicts? c/j k n p a g r` into the popover produced the literal value `"x "`.

**GitHub is the same hazard.** `@github/hotkey` runs the same `isFormField(event.target)`
check behind `s`, `/`, `c`, `t`, `g c`, `j`/`k`. Measured on live github.com 2026-09-01: 390
key-listener registrations, of which `keydown` globals are 45 on `document` in capture, 20 on
`document` in bubble and 2 on `window` in capture — and **zero** on `window` in bubble, which
makes GitHub slightly *more* containable than Graphite. Live, with containment on: 0
bubble-phase hits, 66 capture-phase, value byte-exact, focus retained.

`src/content/ui/keyboard.ts` stops the composed keyboard, composition and clipboard events at
the shadow host in **bubble** phase — late enough that our own in-shadow handlers have already
run (Cmd/Ctrl+Enter still sends), and without `preventDefault`, so characters still land in the
textarea. Both shadow hosts get it. Any new surface that takes input needs it too.

Read that file's header comment before touching key handling; it also records the ceiling —
`window`-capture listeners are unreachable from a `document_idle` content script.
`test/e2e.mjs` case **19** (Graphite) and case **28** (GitHub) are the guards, and both type
with real keystrokes because `locator.fill()` dispatches none and cannot see this class of bug
at all.

---

## Build

```bash
cd extension
npm install
npm run build        # -> extension/dist        (this is the load-unpacked root)
npm run typecheck    # must be clean
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Shipping build into `extension/dist/`. |
| `npm run build:test` | Test build into `extension/dist-test/` (adds the fixture-server host to the content-script matches, in both the Graphite `/github/pr/*` and the GitHub `/*/*/pull/*` path shapes — used only by the e2e suite). |
| `npm run watch` | Rebuild `dist/` on change. Reload the extension in `chrome://extensions` to pick changes up. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test:e2e` | Real Chromium end-to-end suite, headless by default — `STP_HEADED=1` to watch it (see [VERIFICATION.md](VERIFICATION.md)). |
| `npm run verify` | typecheck + build + e2e. |

### Why esbuild

MV3 content scripts are classic scripts and cannot use ESM `import`, so each entry point
is bundled into a self-contained IIFE by `build.mjs`. Sources stay TypeScript; nothing in
`dist/` is hand-written, and `dist/` is gitignored.

Bundles produced:

| File | Runs in |
| --- | --- |
| `content.js` | Content script, **isolated world** — injection, popover, SPA lifecycle. |
| `mainworld.js` | Content script, **MAIN world** — nothing but the `history.pushState`/`replaceState` patch (see "SPA lifecycle"). |
| `background.js` | Service worker — owns the token, performs every `fetch`. |
| `options.js` | Options page. |

Icons are generated at build time by a small PNG encoder in `build.mjs`, so no binaries
live in the repo.

## Load unpacked

**The load-unpacked root is `extension/dist`** — the directory containing `manifest.json`.
Not `extension/`, not `extension/public/`.

1. `npm run build`
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. **Load unpacked** → select `<repo>/extension/dist`

Chrome derives a stable extension ID from that directory path, so the pairing token
survives reloads as long as you don't move the folder.

## Pair with the bridge

1. In Paseo, open the **send-to-paseo** plugin surface and copy the **pairing token**.
   (It also lives at `$PASEO_HOME/plugin-data/send-to-paseo/settings.json`, mode `0600`.)
2. Click the extension's toolbar icon (or **Details → Extension options**).
3. Paste the token. Settings save as you type.
4. Click **Test connection**. It tells you which of these you have:

   | Result | Meaning |
   | --- | --- |
   | green **Paired with Paseo** | Token accepted. The **Default provider** dropdown is now populated from the bridge. |
   | amber **Bridge reachable, not paired yet** | The plugin is running but no token is stored. Paste one. |
   | red **Token rejected** | The plugin is running and refused this token. Copy it again. |
   | red **Can't reach the Paseo bridge** | The plugin isn't listening on that URL. |
   | red **Update required** | Plugin and extension speak different contract versions. Sends are blocked until you update one of them. |
   | amber **Bridge up, Paseo daemon unreachable** | Start the Paseo app. |

   These are distinguishable because `GET /v1/ping` takes *optional* auth: without a token
   it still returns 200 (liveness), with a valid token it returns `paired: true` plus the
   full provider list, and with an invalid token it returns 401.

5. Optionally pick a **Default provider**. The list comes from the bridge, so it is real —
   leave it on *(use the plugin's default)* to defer to the plugin's own setting.
6. Open a Graphite PR (`https://app.graphite.com/github/pr/...`) or a GitHub PR
   (`https://github.com/{owner}/{repo}/pull/{n}`) and click **Send to Paseo**.

Default bridge URL is `http://127.0.0.1:7788`. If your plugin runs on a different port,
change the Bridge URL field and click **Grant access to this address** — the manifest only
pre-declares `http://127.0.0.1:7788/*` as a required host permission, and other localhost
ports come from `optional_host_permissions` on demand.

## Security model

The bridge can start agents that execute code on your machine, so its bearer token is
treated as a real credential:

- **The token lives only in the service worker.** It is stored in `chrome.storage.local`
  and read exclusively by `src/background/bridge-client.ts`. The content script posts
  *intents* over `chrome.runtime.sendMessage`; the service worker performs every HTTP
  request and attaches the `Authorization` header.
- **`content.js` and `mainworld.js` contain no credential code at all** — no `Bearer`, no
  `Authorization`, no `chrome.storage`. The e2e suite asserts this statically against the
  built bundles *and* dynamically by scanning the page's DOM, shadow roots, attributes,
  `window`, `localStorage` and `sessionStorage` for the token string.
- Requests are sent with `credentials: "omit"`; the bridge does not send
  `Access-Control-Allow-Credentials`.
- The MAIN-world script is deliberately ~30 lines of navigation plumbing and nothing else,
  because it shares a JS context with Graphite's own code.

## Architecture

```
extension/
  build.mjs                     esbuild bundler + manifest/asset/icon emit
  public/manifest.json          MV3 manifest (source of truth; copied to dist/)
  public/options.html           options page markup + styles
  src/shared/contract.ts        client-side mirror of CONTRACT.md v1
  src/shared/errors.ts          error code -> specific headline + next step
  src/shared/format.ts          prose -> text + <code>; owns command formatting
  src/shared/messages.ts        content <-> service-worker intent protocol
  src/background/index.ts       intent router; the only fetch caller
  src/background/bridge-client.ts  HTTP client; the only token reader
  src/background/settings.ts    chrome.storage access
  src/content/index.ts          injection loop + SPA lifecycle (site-agnostic)
  src/content/mainworld.ts      MAIN-world history patch
  src/content/popover.ts        shadow-DOM composer (target / instruction / provider / mode)
  src/content/bridge.ts         chrome.runtime.sendMessage wrapper
  src/content/ui/{button,styles,dom}.ts
  src/content/adapters/
    types.ts                    the SiteAdapter interface
    index.ts                    registry + injectable host allowlist
    graphite.ts                 Graphite adapter
    github.ts                   GitHub adapter
  src/options/index.ts          options page logic
```

### The `SiteAdapter` seam

Everything site-specific hides behind the five required members of `SiteAdapter`
(`matches`, `parse`, `findStackPrNumbers`, `findAnchor`, `styleHint`). `src/content/index.ts`
contains no Graphite selector — not even for labelling the anchor rung, which the adapter
reports via the optional `rung` field on its `findAnchor()` result.

The seam held: adding GitHub was a new file in `adapters/`, one line in `adapters/index.ts`,
one match pattern per content script in `public/manifest.json`, and a `styleHint` branch in
`ui/styles.ts`. Not one line of `src/content/index.ts`, `popover.ts`, `bridge.ts`,
`ui/button.ts` or `ui/keyboard.ts` changed. (`mainworld.ts` gained three extra event
listeners, but site-agnostically — see "SPA lifecycle".)

Adding a third site is the same shape: implement `SiteAdapter`, register it in
`adapters/index.ts` with the `EXTRA_HOSTS` injection, add manifest matches, add a
`styleHint()` branch.

### PR identity comes from the URL

Graphite: `/github/pr/{owner}/{repo}/{number}/{slug}`.
GitHub: `/{owner}/{repo}/pull/{number}` plus any tab (`/commits`, `/checks`, `/changes` —
note the new diff experience renamed "Files changed" from `/files` to `/changes`; both
resolve and both match).

That URL is the only source of `owner`/`repo`/`number` on either site.

The single permitted DOM scrape is Graphite's stack sibling PR numbers from
`a[href^="/github/pr/{owner}/{repo}/"]` — structural, so it survives hash rotation — with the
current PR filtered out, because Graphite includes it.

**On GitHub `findStackPrNumbers()` returns `[]`, deliberately.** GitHub renders no stack, and
since 2026-09-01 the bridge derives the stack authoritatively from `gh pr list`
(`plugin/gh.server.ts` → `viewStackGraph`) using only the PR's own head branch. The field is
now a supplement for members that graph cannot see — i.e. **closed or merged** stack PRs,
since `listOpenPrs` lists open ones only. There is no structural place on a GitHub PR page to
read those from, so nothing is invented. `test/fixtures/github-pr-no-anchor.html` deliberately
contains `/pull/{n}` links and test 26 asserts `stackPrNumbers` stays `[]` anyway.

### Surviving Graphite's class-name rotation

Graphite ships CSS-module class names whose hash suffix changes on every deploy. All
selectors use attribute-**contains** matching (`[class*="PullRequestPageHeader_prPageHeader"]`).
The anchor ladder is:

1. the PR header action row, inserted **before** the `Review Changes` button
   (found via `[class*="ReviewChangesAction_"]`, then by button text as a backstop)
2. `[class*="MetadataSection_prInfoGroup"]`, appended
3. a fixed-position floating button

`test/fixtures/graphite-pr-rotated.html` is the same DOM with all 41 hashes rotated, and
the e2e suite asserts injection still lands on rung 1 there.

### Surviving GitHub's class-name rotation — yes, GitHub too

The PR header is Primer React, and its CSS-module class names carry rotating hash suffixes
in exactly the same way (`prc-PageHeader-Actions-wawWm`). The skeleton this adapter replaced
claimed GitHub had "real, stable data-testids"; it does not — there is **not one**
`data-testid` in the PR header, and the legacy `#partial-discussion-header` /
`.gh-header-actions` vocabulary is entirely gone. Everything measured is in
[`../test/fixtures/github-dom-notes.md`](../test/fixtures/github-dom-notes.md).

The GitHub anchor ladder:

1. `[class*="prc-PageHeader-Actions"]`, appended — the real action row next to **Code**
   (`display:flex; gap:8px`, so no margin of ours is needed). Present on every PR sub-route
   and on merged PRs.
2. `.gh-header-actions` (legacy Rails), appended. Not observed on live github.com in 2026-09;
   kept because it is two lines and Enterprise Server trails dotcom.
3. `[class*="prc-PageHeader-TitleArea"]`, appended — first match is the real header, the
   second is the sticky scrolled clone.
4. `nav[aria-label="Pull request navigation"]`, appended — the one semantic, unhashed hook.
   Only rung 4 because it is absent on some PR views.
5. `#partial-discussion-header` (legacy).
6. a fixed-position floating button.

`test/fixtures/github-pr-rotated.html` is the same DOM with all 47 Primer/CSS-module hashes
rotated (`test/fixtures/rotate.mjs` now handles both the `Name__hash` and the
`prc-Component-Part-hash` shapes), and test 21b asserts injection still lands on rung 1.

### SPA lifecycle

- `history.pushState` / `replaceState` are patched **in the MAIN world** — see the warning
  at the top of this file for why this is not optional. Verified on live github.com: Turbo
  calls `history.pushState` on **every** soft navigation, both a same-PR tab switch and a
  cross-page visit, so this one mechanism covers GitHub as well.
- `mainworld.ts` additionally re-announces on `turbo:load`, `turbo:render` and `soft-nav:end`,
  listened for unconditionally. This is site-agnostic by construction — they are just event
  names, and none of them ever fires on Graphite. They are belt-and-braces, not the mechanism:
  a same-PR tab switch fires only `soft-nav:*` while a cross-page Turbo visit fires the full
  `turbo:*` set, and `turbo:render` swaps DOM *after* the URL has already changed.
- Plus `popstate`, a debounced `MutationObserver` on the adapter's `observeTarget()`
  (`[data-testid="graphite-app-wrapper"]` on Graphite; `#repo-content-turbo-frame` on GitHub —
  measured to survive a cross-page Turbo navigation by element identity, unlike `react-app`,
  which is replaced), and a 1 s `location.href` poll as a backstop in case a page CSP blocks
  the MAIN-world shim.
- Injection is idempotent, guarded on the `data-send-to-paseo` marker attribute, and
  performs zero DOM writes when nothing changed — so a noisy observer cannot feed itself.
- Navigating to a different PR tears the old button down and re-creates it, so a stale PR
  number can never be sent.

### Style isolation

The button and the popover each live in their own shadow root, with all CSS injected as a
`<style>` inside it. The host page's stylesheets cannot reach in and ours cannot leak out.
Light and dark both come from `prefers-color-scheme` on custom properties.

`styleHint()` picks the visual language. The **GitHub** branch imitates Primer's default
button — 32px tall, `0 12px` padding, 8px gap, 6px radius, `500 14px` — with every colour
taken from GitHub's own tokens (`--button-default-bgColor-rest`, `--button-default-fgColor-rest`,
`--button-default-borderColor-rest`, `--focus-outlineColor`) and the measured value as a
fallback. Custom properties are *inherited* properties, so they cross the shadow boundary:
that one fact is why the button re-themes with `data-color-mode="auto"`, an explicit
`data-color-mode="dark"` and any custom Primer theme, with no JS and no re-render. Verified
live — every measured property of our button is byte-identical to GitHub's own **Code**
button in both themes.

Style isolation is all a shadow root buys you, though — **events still cross it**, which is
what `containKeyboard()` exists to deal with. See item 3 above.

### Contract handling

The client mirror of CONTRACT.md v1 lives in `src/shared/contract.ts`, and
`src/shared/errors.ts` types its presentation table as
`Record<ContractErrorCode | LocalErrorCode, PresentedError>` — so forgetting to handle a new
error code is a **compile** error, not a runtime "failed".

Specific behaviours worth knowing:

- **`GET /v1/ping` auth is optional.** The extension uses both forms deliberately: without
  a token for a pure liveness check, with one to validate pairing and fetch providers.
- **`contract` mismatch refuses everything.** Not just `/v1/send` — the popover won't even
  resolve, so you find out before typing.
- **`dryRun` is always present on a 200 send** and is surfaced distinctly: amber headline,
  a `DRY RUN` badge, an explicit "nothing was created" note, and a relabelled deep link.
- **`error.message` is plain prose; `hint` carries bare shell commands.** All code
  formatting happens client-side in `src/shared/format.ts`, against an exact-match list of
  known commands (`KNOWN_COMMANDS` in `src/shared/errors.ts`) rather than a regex that
  might mangle ordinary prose. Nothing from the bridge is ever parsed as HTML.
- **`prompt` is 1..16000 Unicode code points** after trim, counted with `[...text].length`
  so an emoji counts as one. The 64 KiB body cap is separate and enforced by the bridge.
- **Permission mode is a first-class field.** `/v1/ping` and `/v1/resolve` carry a flat
  `modes[]` tagged with the provider each mode belongs to, `/v1/resolve` also carries
  `resolvedModeId`, and `/v1/send` carries `modeId`. Three rules follow from mode ids being
  **per provider**:
  - the Mode select is filtered to the bare provider of the selected `provider/model`
    (`providerIdOf()` in `src/shared/contract.ts`);
  - changing the provider re-renders and re-picks the mode from scratch — a mode is never
    carried across a provider change;
  - the preselection is `resolvedModeId` when it belongs to this provider, else this
    provider's own `isDefault`, else its first mode. Preselecting `isDefault` blindly would
    ignore a profile the plugin is following; preselecting the first entry would silently pick
    Claude's "Always Ask".
- **Unattended modes are shown, not hidden.** "Bypass" and "Full Access" appear in the
  dropdown with a `⚠` glyph, `data-stp-mode-danger="true"`, and the `--stp-warn` colour (which
  is defined for light and dark); selecting one renders a sentence saying the agent will not
  ask for permission. Hiding a dangerous option does not make it safer, it makes it invisible.
- **Additive fields are ignored — in both directions.** `modes`, `resolvedModeId` and `modeId`
  are all typed optional here, so a plugin that predates them simply omits them and the Mode
  select does not render. Symmetrically, sending `modeId` to an older plugin is safe: the
  bridge's request schemas are non-strict, so an unknown field is stripped rather than
  rejected. Unknown error codes still render a specific headline naming the code.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No button on a Graphite PR page | Check the URL is `app.graphite.com/github/pr/...` (or `.dev`). Then `chrome://extensions` → **Errors**, and the page console for `[send-to-paseo]` warnings. |
| No button on a GitHub PR page | Check the URL is `github.com/{owner}/{repo}/pull/{n}` — if GitHub redirected you to `/issues/{n}` it is an issue, not a PR, and there is deliberately no button. Otherwise same checks as above. |
| Button appears bottom-right instead of in the header | Every anchor rung is missing — usually a site redesign. The extension still works; open an issue with the new header markup. |
| Popover says "Not paired with Paseo" | No token, or the wrong one. Options → paste the token from the Paseo plugin surface → **Test connection**. |
| Popover says "Can't reach the Paseo bridge" | The plugin isn't running (`paseo plugin ls` should show `send-to-paseo` as `running`), or the port differs from the Bridge URL. Check `paseo plugin logs send-to-paseo`. |
| "Bridge rejected the request host" | The Bridge URL must use `127.0.0.1` or `localhost`. Any other host name is refused by design (DNS-rebinding defence). |
| "This repo isn't a Paseo project" | Add the repository as a project in Paseo, then reopen the popover. |
| "GitHub CLI isn't authenticated" | Run `gh auth login` on the machine running Paseo. |
| Popover says **Update required** | Plugin and extension are on different contract versions. Sends are blocked deliberately. Update whichever side is older; **Test connection** prints both numbers. |
| Popover says **Token rejected** on the options page | The bridge is up and refused the token. Re-copy it from the Paseo plugin surface. Distinct from "Can't reach the Paseo bridge". |
| Success state says **Dry run — no agent created** | The plugin is running with `SEND_TO_PASEO_DRY_RUN=1`. Nothing was created and the ids are synthetic. Unset the env var and reload the plugin. |
| **Default provider** dropdown is empty | Providers come from an authenticated ping. Paste a valid token and click **Test connection**. |
| Typing in the instruction box triggers Graphite/GitHub shortcuts, or characters go missing | `containKeyboard()` isn't running — you're on a stale build, or key handling was refactored. Rebuild (`npm run build`), reload the extension, reload the tab. See item 3 at the top of this file; `test/e2e.mjs` cases 19 (Graphite) and 28 (GitHub) are the regression tests. |
| Button points at the wrong PR after browsing the stack | The MAIN-world history shim isn't running — check `chrome://extensions` → Errors and the page's CSP. See the warning at the top of this file. |
| Everything breaks after `npm run build` | You may have `dist-test/` loaded instead of `dist/`. Check the extension name in `chrome://extensions` — the test build is labelled "(test build)". |
| Changed code but nothing happened | Reload the extension in `chrome://extensions`, then reload the Graphite/GitHub tab. Content scripts are not hot-reloaded. |

Service-worker logs: `chrome://extensions` → **Service worker** link under the extension.
Content-script logs appear in the Graphite or GitHub page's own console.
