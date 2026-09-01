# Captured GitHub PR DOM structure

Captured **2026-09-01** from live, logged-in `github.com` with the Playwright MCP browser
(Chrome/152 UA). Pages measured:

| URL | Why |
| --- | --- |
| `https://github.com/microsoft/vscode/pull/333746` | primary capture — open PR, Conversation tab |
| `…/pull/333746/changes` | the "Files changed" sub-route (see the `/changes` note below) |
| `…/pull/333746/commits` | Commits sub-route |
| `https://github.com/microsoft/vscode/pulls` → PR (link click) | cross-page Turbo soft navigation |
| `acmegizmos/gizmo-poc#942`, `rails/rails#50000`, `nodejs/node#50000` | layout is identical across repos |
| `microsoft/vscode#333745/#333744/#333743` (merged) | layout is identical for merged PRs |

> Everything below was measured, not remembered. `github.ts.todo`'s selectors were written from
> memory and **all three of its primary guesses are gone** — see "What the skeleton got wrong".

## What the skeleton got wrong

| `github.ts.todo` guessed | Reality on 2026-09-01 |
| --- | --- |
| `[data-testid="pr-header-actions"]` | **does not exist.** No `data-testid` anywhere in the PR header. |
| `#partial-discussion-header .gh-header-actions` | **does not exist.** 0 occurrences of either token in the server HTML or the live DOM, on any of the 7 PRs measured. The legacy Rails PR header is gone. |
| `#partial-discussion-header` (title fallback) | same — gone. |
| `react-app[app-name='react-code-view']` (observe target) | `react-app` exists but has **no `app-name` attribute** on a PR page, and it is *replaced* by a cross-page Turbo navigation, so it is the wrong thing to observe. |
| "GitHub has real, stable data-testids … no `[class*=]` gymnastics needed" | **false.** The PR header is Primer React with CSS-module class names carrying rotating hash suffixes (`prc-PageHeader-Actions-wawWm`), exactly the Graphite problem. Same rule applies: attribute-CONTAINS only. |

## Stable anchors (verified; counts are `document.querySelectorAll(...).length`)

| Selector | Count | What it is |
| --- | --- | --- |
| `[class*="prc-PageHeader-Actions"]` | 1 | **primary injection target.** The header action row holding "View status" and "Code". `display:flex; gap:8px`. Appending puts our button to the right of "Code" with GitHub's own 8px gap. |
| `[class*="prc-PageHeader-TitleArea"]` | 2 | title area. `[0]` is the real header, `[1]` is the sticky (scrolled) header. |
| `nav[aria-label="Pull request navigation"]` | 1 | the Conversation / Commits / Checks / Files-changed tab bar. **Semantic ARIA hook, no hash.** Present on PR pages, absent on issue pages. |
| `#repo-content-turbo-frame` | 1 | `<turbo-frame>`. **Survives cross-page Turbo navigation by element identity** → the right `observeTarget()`. |
| `#js-repo-pjax-container` | 1 | `<main>`. Also survives. Second-choice observe target. |
| `.js-pull-header-details` | 1 | GitHub `js-*` behaviour hook inside the header. Unhashed, but empty and zero-height — not useful as an anchor. |
| `react-app` | 1 | **replaced** by cross-page Turbo nav. Do not observe. |
| `#repo-content-pjax-container` | 1 | **removed/replaced** by cross-page Turbo nav. Do not observe. |

Measured element-identity survival (tagged a JS property on each node, then navigated):

```
same PR, tab switch (/ → /changes → /commits):
  #js-repo-pjax-container   SAME    #repo-content-turbo-frame  SAME
  react-app                 SAME    [class*=prc-PageHeader-Actions]  SAME   (button stays put)

cross-page (/pulls → /pull/333746, Turbo):
  #js-repo-pjax-container   SAME    #repo-content-turbo-frame  SAME
  react-app                 REPLACED   #repo-content-pjax-container  MISSING
  body / html               SAME    (the JS realm survives too)
```

## Header action row — primary injection target

```html
<header class="prc-PageLayout-Header-0of-R">
  <div class="prc-PageLayout-HeaderContent-gdFfN">
    <div class="js-pull-header-details"></div>
    <div>
      <div class="prc-PageHeader-PageHeader-YLwBQ flex-items-center PullRequestHeader-module__actionsAboveTitleOnNarrow__WHP6N …">
        <div class="prc-PageHeader-TitleArea-2n2J0">
          <div class="PullRequestHeader-module__titleWithAction__ODY5f">
            <h1 class="prc-PageHeader-Title-p0Mgh lh-condensed PullRequestHeader-module__inlineTitle__czbud prc-Heading-Heading-MtWFE">
              <span class="f1 text-normal markdown-title prc-Text-Text-9mHv3">Fix multi-diff virtualization layout failures</span>
              <span class="sr-only">- #333746</span>
            </h1>
            <span class="PullRequestHeader-module__titleSuffix__bR9SB"><span class="pl-2 fgColor-muted f1-light lh-condensed">#333746</span></span>
          </div>
        </div>

        <!-- ***** PRIMARY ANCHOR: append here ***** -->
        <div class="prc-PageHeader-Actions-wawWm flex-items-center gap-2 position-relative">
          <div class="d-flex gap-2">
            <div><button class="prc-Button-ButtonBase-9n-Xk MergeStatusButton-module__mergeStatusButton__CAjUA">View status</button></div>
            <button class="prc-Button-ButtonBase-9n-Xk PullRequestCodeButton-module__hideLeadingVisual__wxPft">Code</button>
          </div>
        </div>

        <div class="prc-PageHeader-Description-w-ejP …">Open · … wants to merge …</div>
        <div class="prc-PageHeader-Navigation--uLav tmp-pt-3">
          …+243 −47…
          <nav aria-label="Pull request navigation" class="PullRequestHeaderTabNav-module__TabNav__tXCxR">…</nav>
        </div>
      </div>

      <!-- sticky duplicate, appears on scroll; has its own TitleArea, no Actions -->
      <div class="prc-PageHeader-PageHeader-YLwBQ use-sticky-header-module__stickyHeader__sf0hv StickyPullRequestHeader-module__prHeader__P9n8q …">
        <div class="prc-PageHeader-TitleArea-2n2J0 flex-items-center justify-center container-xl …">…<h2>…</h2></div>
      </div>
    </div>
  </div>
</header>
```

Contents of the Actions row vary by sub-route — `/changes` adds a "Preview" button, `/commits`
drops it — but the row itself is present on all of them. Since it is a flex row with `gap: 8px`,
`mode: "append"` needs no margin of our own.

**No `data-testid` exists on the PR title area.** The only `data-testid`s on the whole page are
`top-nav-left`, `top-nav-center`, `top-nav-right`, `top-bar-actions`, `keybinding-hint`,
`github-avatar`, `copilot-immersive-embedded-header-button`, `addition diffstat`,
`neutral diffstat`, `mergebox-partial`, `mergebox-border-container`,
`mergeability-icon-wrapper`, `feature-request-cta` and a per-review
`copilot-code-review-feedback-*`. None is in the header, and none is a usable anchor.

## URL shape and sub-routes

`/{owner}/{repo}/pull/{number}` plus, as measured on the tab bar:

```
/microsoft/vscode/pull/333746            Conversation
/microsoft/vscode/pull/333746/commits    Commits            id="prs-commits-anchor-tab"
/microsoft/vscode/pull/333746/checks     Checks
/microsoft/vscode/pull/333746/changes    Files changed      id="prs-files-anchor-tab"
```

**Note `/changes`, not `/files`.** The new diff experience renamed the Files-changed route.
`/files` is still a valid URL and still resolves, so the adapter must match *any* trailing
segment — `^/([^/]+)/([^/]+)/pull/(\d+)(?:/|$)` does, and is unchanged from the skeleton.

`/{owner}/{repo}/pull/{n}` where `n` is an **issue** number 302-redirects to `/issues/{n}`, which
does not match `PR_PATH`. That is the desired outcome: no button on an issue page.

## Soft navigation (Turbo) — verified, not assumed

Instrumented `history.pushState` plus 14 candidate event names before navigating.

**Same-PR tab switch** (`/` → `/changes`):

```
history.pushState("/microsoft/vscode/pull/333746/changes")   <-- fires
document events: soft-nav:start, soft-nav:success, soft-nav:end
turbo:load / turbo:render / turbo:visit                       <-- do NOT fire
```

**Cross-page Turbo nav** (`/pulls` → `/pull/333746`):

```
history.pushState("https://github.com/microsoft/vscode/pull/333746")   <-- fires
document events: soft-nav:start, turbo:frame-load, turbo:visit,
                 turbo:before-render, turbo:render, turbo:load,
                 soft-nav:success, soft-nav:end
```

So **`history.pushState` is called on every soft navigation** and the extension's existing
MAIN-world shim (`src/content/mainworld.ts`) is sufficient on its own — this was verified, not
assumed. `turbo:load`/`turbo:render` are only a *partial* signal (absent on tab switches);
`soft-nav:end` covers both. `mainworld.ts` now also re-announces on `turbo:load`,
`turbo:render` and `soft-nav:end` unconditionally, as belt-and-braces; those events simply never
fire on Graphite.

## Theming — GitHub's tokens inherit through our shadow root

```html
<html data-color-mode="auto" data-light-theme="light" data-dark-theme="dark"
      data-a11y-animated-images="system" data-a11y-link-underlines="true"
      data-turbo-loaded class="js-skip-scroll-target-into-view js-focus-visible">
```

The real "Code" button, computed:

```
height 32px            padding 0 12px          border-radius 6px  (--borderRadius-medium: .375rem)
font   500 14px        gap 8px                 border 1px solid
light: color #1f2328   background #f6f8fa      border #d1d9e0     box-shadow 0 1px 0 rgba(31,35,40,.04)
```

Primer custom properties at `:root`, light → dark:

| token | light | dark |
| --- | --- | --- |
| `--fgColor-default` | `#1f2328` | `#f0f6fc` |
| `--fgColor-muted` | `#59636e` | `#9198a1` |
| `--bgColor-default` | `#fff` | `#0d1117` |
| `--button-default-bgColor-rest` | `#f6f8fa` | `#212830` |
| `--button-default-bgColor-hover` | `#eff2f5` | `#262c36` |
| `--button-default-borderColor-rest` | `#d1d9e0` | `#3d444d` |
| `--borderColor-default` | `#d1d9e0` | `#3d444d` |
| `--borderColor-emphasis` | `#818b98` | `#656c76` |
| `--focus-outlineColor` | `#0969da` | `#1f6feb` |

**Measured fact that decides the CSS strategy:** CSS custom properties are *inherited*
properties, so they cross the shadow boundary. A throwaway shadow-root button styled with
`var(--button-default-bgColor-rest, …)` was planted in the real action row and read back:

```
prefers-color-scheme: light  ->  color rgb(31,35,40)   bg rgb(246,248,250)  border rgb(209,217,224)
prefers-color-scheme: dark   ->  color rgb(240,246,252) bg rgb(33,40,48)     border rgb(61,68,77)
```

So `ui/styles.ts`'s `github` branch consumes GitHub's own tokens with hard-coded fallbacks. That
tracks `data-color-mode="auto"`, an explicit `data-color-mode="dark"`, *and* any custom Primer
theme the user has chosen, with no `:host-context()` and no JS. The `prefers-color-scheme`
fallback block still exists for the case where GitHub's tokens are missing entirely.

## GitHub's keyboard shortcut layer — measured

`EventTarget.prototype.addEventListener` was instrumented from `document_start`
(`page.addInitScript`) and the PR page loaded normally. **390** key-listener registrations
(`keydown`/`keyup`/`keypress`/`beforeinput`/`input`/`paste`). Globals only:

| target | phase | `keydown` registrations |
| --- | --- | --- |
| `document` | **capture** | **45** |
| `document` | bubble | 20 |
| `window` | **capture** | **2** |
| `window` | bubble | 0 |
| `body` | either | 0 |

Registering scripts (by asset chunk, `keydown` only): `primer-react.js` 133, `r1.js` 42,
`fbt.js` 39, `j0.js` 27, `chunk-lazy-element-reactions-menu.js` 16, `react-dom-client.js` 10,
`nn.js` 9, `by.js` 5, `chunk-oa.js` 4, `ph4.js` 4, `behaviors.js` 2, and one each from
`hotkey.js` (`@github/hotkey`, the global single-key layer: `s`, `/`, `g c`, `c`, `t`, …),
`catalyst.js`, `diffs.js`, `hj.js`, `ja9.js`, `jz5.js`, `tp.js`, `z1.js`, `ibz.js`.

This is the same hazard shape as Graphite: `@github/hotkey` decides whether to treat a key as a
shortcut from `event.target`, and shadow-DOM retargeting hands it our custom element instead of
our `<textarea>`. `containKeyboard()` is therefore **mandatory** here too. The ceiling is also
the same and slightly *better* than Graphite's: 47 capture-phase global `keydown` listeners are
unreachable from a `document_idle` content script, but there are **zero** bubble-phase `window`
listeners, so bubble containment at the host covers everything we can reach.

## Stack sibling PRs — deliberately not scraped

GitHub does not render a Graphite stack. `findStackPrNumbers()` returns `[]`, which
`CONTRACT.md` explicitly supports. Since 2026-09-01 the bridge derives the stack authoritatively
from `gh pr list` (`plugin/gh.server.ts` → `viewStackGraph`) using only the PR's own head
branch, so the field is a supplement for members the graph cannot see — i.e. **closed or merged**
stack PRs, because `listOpenPrs` only lists open ones. There is no safe, structural place on a
GitHub PR page to read those from. Graphite's bot comment sometimes lists the stack, but it is
free-form markdown in a comment body, only on the Conversation tab, and absent in most repos:
not a selector worth trusting. `[]` is the honest answer.

## Environment facts

- Primer React CSS-module class names carry rotating hash suffixes
  (`prc-PageHeader-Actions-wawWm`). Match with `[class*="prc-PageHeader-Actions"]` only.
- The PR page is a Rails shell (`turbo-frame#repo-content-turbo-frame`) containing a React app.
  Both layers are live at once, which is why some hooks are `js-*` (Rails) and some are
  `prc-*`/`*-module__*` (React).
- No `#partial-discussion-header`, no `.gh-header-actions`, no `.gh-header-title`,
  no `.gh-header-show` — the whole legacy header vocabulary is absent.
- The adapter nonetheless keeps a legacy `.gh-header-actions` rung. It cost two lines, GitHub
  ships per-repo/per-user flags, and Enterprise Server lags dotcom by months.
