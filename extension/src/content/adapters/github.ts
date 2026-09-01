/**
 * GitHub adapter (PLAN.md phase 6).
 *
 * Ground truth: test/fixtures/github-dom-notes.md, measured on live github.com
 * on 2026-09-01. It is worth reading before touching a selector here, because
 * the two things "everyone knows" about the GitHub PR page are both false now:
 *
 *  1. There is NO `data-testid` anywhere in the PR header. The whole page has
 *     thirteen of them and every one is in the global top bar or the mergebox.
 *  2. `#partial-discussion-header` / `.gh-header-actions` — the legacy Rails
 *     header this file's skeleton was written against — no longer exist. Zero
 *     occurrences, in the server HTML and the live DOM, on all seven PRs
 *     measured (open and merged, four different repos).
 *
 * The header is Primer React, whose CSS-module class names carry rotating hash
 * suffixes exactly like Graphite's (`prc-PageHeader-Actions-wawWm`). So the
 * same house rule applies: attribute-CONTAINS matching on the stable prefix,
 * never the full class name, and never any *data* taken from a class-selected
 * node — PR identity comes from the URL.
 */

import type { PrRef } from "../../shared/contract";
import type { AnchorPlacement, SiteAdapter } from "./types";

export const GITHUB_HOSTS = ["github.com"] as const;

/**
 * `/{owner}/{repo}/pull/{number}` plus any sub-route.
 *
 * The trailing `(?:\/|$)` deliberately accepts every PR tab, because the
 * manifest match `https://github.com/*​/*​/pull/*` runs the content script on
 * all of them. Measured tab routes: `` (Conversation), `/commits`, `/checks`
 * and `/changes` — note the new diff experience renamed "Files changed" from
 * `/files` to `/changes`; both resolve, and both match here.
 */
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

export interface GithubAdapterOptions {
  /**
   * Host allowlist. Injectable so the e2e suite can point the adapter at a
   * localhost fixture server without localhost ever appearing in a shipped
   * build. Production builds pass nothing and get GITHUB_HOSTS.
   */
  hosts?: readonly string[];
}

export function createGithubAdapter(
  options: GithubAdapterOptions = {},
): SiteAdapter {
  const hosts = options.hosts?.length ? options.hosts : GITHUB_HOSTS;

  function parse(url: URL): PrRef | null {
    const m = PR_PATH.exec(url.pathname);
    if (!m) return null;
    const number = Number.parseInt(m[3], 10);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return { forge: "github", owner: m[1], repo: m[2], number };
  }

  return {
    id: "github",

    matches: (url) => hosts.includes(url.host) && PR_PATH.test(url.pathname),

    parse,

    /**
     * Deliberately empty, and that is the right answer — not a stub.
     *
     * GitHub does not render a Graphite stack anywhere on a PR page, and
     * `CONTRACT.md` states `stackPrNumbers` is optional and may be `[]`.
     *
     * More to the point: since 2026-09-01 the bridge resolves the stack
     * authoritatively server-side. `plugin/gh.server.ts`'s `viewStackGraph`
     * rebuilds the whole base->head chain from one `gh pr list` using only this
     * PR's own head branch, so it needs nothing from us. The field survives
     * only as a *supplement* for stack members that graph cannot see — which,
     * because `listOpenPrs` lists open PRs only, means closed or merged ones.
     *
     * The sole candidate scrape on GitHub would be Graphite's bot comment,
     * which is free-form markdown in a comment body, only on the Conversation
     * tab, and absent from most repos. That is a fragile scrape of a
     * third-party string, so it is not done. Sending `[]` costs the user at
     * most a rank-2 candidate for a *closed* sibling PR.
     */
    findStackPrNumbers: () => [],

    /**
     * Anchor ladder, best first:
     *
     *   1. primary  — the header action row (`prc-PageHeader-Actions`), append.
     *                 Measured: exactly one per page, a flex row with an 8px
     *                 gap holding "View status" and "Code". Appending drops our
     *                 button to the right of "Code" with GitHub's own spacing
     *                 and needs no margin from us. Present on every PR
     *                 sub-route (`/commits`, `/checks`, `/changes`) and on
     *                 merged PRs.
     *   2. primary  — the legacy Rails action row. Not observed anywhere on
     *                 2026-09-01; kept because it costs two lines, GitHub ships
     *                 behind per-repo/per-user flags, and Enterprise Server
     *                 trails dotcom by months.
     *   3. fallback — the title area, append. Puts the button beside the PR
     *                 title. `querySelector` takes the first, which is the real
     *                 header; the second is the sticky scrolled clone.
     *   4. fallback — the tab bar, via its ARIA label. The one semantic,
     *                 unhashed hook in the header. Only a rung 4 because it is
     *                 absent on some PR views.
     *   5. fallback — the legacy header block.
     *   6. null     — the shared loop renders the fixed-position floating
     *                 button.
     *
     * Rungs 1 and 3 use `[class*=]`. That is the brittle-selector escape hatch
     * the house rules allow only with a reason, so: there is no id, no
     * data-testid and no ARIA role on either node, the class hash is a
     * *suffix* so prefix-contains is stable across a Primer release, and no
     * data is ever read from these nodes — they are used purely as insertion
     * points, with three further rungs and a floating fallback behind them.
     */
    findAnchor(): AnchorPlacement | null {
      const actions = document.querySelector(
        '[class*="prc-PageHeader-Actions"]',
      );
      if (actions) return { el: actions, mode: "append", rung: "primary" };

      const legacyActions = document.querySelector(
        "#partial-discussion-header .gh-header-actions, .gh-header-actions",
      );
      if (legacyActions) return { el: legacyActions, mode: "append", rung: "primary" };

      const titleArea = document.querySelector(
        '[class*="prc-PageHeader-TitleArea"]',
      );
      if (titleArea) return { el: titleArea, mode: "append", rung: "fallback" };

      const tabNav = document.querySelector(
        'nav[aria-label="Pull request navigation"]',
      );
      if (tabNav) return { el: tabNav, mode: "append", rung: "fallback" };

      const legacyHeader = document.querySelector("#partial-discussion-header");
      if (legacyHeader) return { el: legacyHeader, mode: "append", rung: "fallback" };

      return null;
    },

    styleHint: () => "github",

    /**
     * `<turbo-frame id="repo-content-turbo-frame">` — measured to survive a
     * cross-page Turbo navigation *by element identity*, while `react-app` is
     * replaced and `#repo-content-pjax-container` disappears outright. It also
     * contains the whole PR header, so observing it is both correct and much
     * quieter than observing `<body>`.
     *
     * `<main id="js-repo-pjax-container">` survives too and is the second
     * choice; `null` sends the shared loop to `document.body`.
     */
    observeTarget: () =>
      document.querySelector("#repo-content-turbo-frame") ??
      document.querySelector("#js-repo-pjax-container"),
  };
}
