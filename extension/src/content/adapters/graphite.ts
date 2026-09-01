/**
 * Graphite adapter.
 *
 * Ground truth: test/fixtures/graphite-dom-notes.md (captured from the live app).
 *
 * Two rules drive everything here:
 *  1. PR identity comes from the URL, never the DOM.
 *  2. Any DOM selector uses [class*="Prefix_name"] attribute-CONTAINS matching,
 *     because Graphite's CSS-module hashes are suffixes that rotate on every
 *     deploy (`PullRequestPageHeader_prPageHeader__NRgNb`).
 */

import type { PrRef } from "../../shared/contract";
import type { AnchorPlacement, SiteAdapter } from "./types";

/** graphite.dev now redirects to graphite.com; match both. */
export const GRAPHITE_HOSTS = ["app.graphite.com", "app.graphite.dev"] as const;

/** `/github/pr/{owner}/{repo}/{number}/{slug}` — the sole source of identity. */
const PR_PATH = /^\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/|$)/;

export interface GraphiteAdapterOptions {
  /**
   * Host allowlist. Injectable so the e2e suite can point the adapter at a
   * localhost fixture server without localhost ever appearing in a shipped
   * build. Production builds pass nothing and get GRAPHITE_HOSTS.
   */
  hosts?: readonly string[];
}

export function createGraphiteAdapter(
  options: GraphiteAdapterOptions = {},
): SiteAdapter {
  const hosts = options.hosts && options.hosts.length ? options.hosts : GRAPHITE_HOSTS;

  function parse(url: URL): PrRef | null {
    const m = PR_PATH.exec(url.pathname);
    if (!m) return null;
    const number = Number.parseInt(m[3], 10);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return { forge: "github", owner: m[1], repo: m[2], number };
  }

  return {
    id: "graphite",

    matches(url: URL): boolean {
      return hosts.includes(url.host) && PR_PATH.test(url.pathname);
    },

    parse,

    /**
     * The one safe scrape: stack siblings live in link hrefs, which are
     * structural and immune to hash rotation. The list Graphite renders
     * INCLUDES the current PR, so it is filtered out here — the bridge
     * contract says stackPrNumbers "excludes the PR itself".
     */
    findStackPrNumbers(): number[] {
      const self = parse(new URL(location.href));
      if (!self) return [];
      const prefix = `/github/pr/${self.owner}/${self.repo}/`;
      const links = document.querySelectorAll<HTMLAnchorElement>(
        `a[href^="${cssEscapeAttr(prefix)}"]`,
      );
      const out = new Set<number>();
      for (const a of links) {
        // Use getAttribute, not .href: we want the raw relative path Graphite
        // wrote, so the prefix comparison can't be defeated by a base tag.
        const href = a.getAttribute("href") ?? "";
        const rest = href.slice(prefix.length);
        const n = Number.parseInt(rest.split("/")[0] ?? "", 10);
        if (!Number.isSafeInteger(n) || n <= 0) continue;
        if (n === self.number) continue; // <-- exclude self
        out.add(n);
      }
      return [...out].sort((a, b) => b - a);
    },

    /**
     * Anchor ladder:
     *   1. the PR header's action row, immediately before "Review Changes"
     *   2. the metadata section's info group (append)
     *   3. null -> the caller renders a fixed-position floating button
     */
    findAnchor(): AnchorPlacement | null {
      const header = document.querySelector(
        '[class*="PullRequestPageHeader_prPageHeader"]',
      );

      if (header) {
        const review = findReviewChangesButton(header);
        if (review?.parentElement) return { el: review, mode: "before", rung: "primary" };

        // Header exists but "Review Changes" doesn't (logged-out, draft PR,
        // Graphite restructure). Fall back to the last button row inside it.
        const row = findButtonRow(header);
        if (row) return { el: row, mode: "append", rung: "primary" };
      }

      const infoGroup = document.querySelector(
        '[class*="MetadataSection_prInfoGroup"]',
      );
      if (infoGroup) return { el: infoGroup, mode: "append", rung: "fallback" };

      return null;
    },

    styleHint() {
      return "graphite";
    },

    observeTarget(): Element | null {
      // The only genuinely stable test id on the page.
      return document.querySelector('[data-testid="graphite-app-wrapper"]');
    },
  };
}

/**
 * Find Graphite's "Review Changes" button inside the header.
 * Preferred: the CSS-module prefix `ReviewChangesAction_`. Fallback: button
 * text, so a renamed module still resolves.
 */
function findReviewChangesButton(header: Element): Element | null {
  const byModule = header.querySelector('[class*="ReviewChangesAction_"]');
  if (byModule) return closestButton(byModule) ?? byModule;

  const buttons = header.querySelectorAll("button");
  for (const b of buttons) {
    if ((b.textContent ?? "").trim().toLowerCase() === "review changes") return b;
  }
  return null;
}

function closestButton(el: Element): Element | null {
  if (el.tagName === "BUTTON") return el;
  return el.closest("button") ?? el.querySelector("button");
}

/**
 * Last-resort row finder: the deepest element inside the header that directly
 * contains two or more buttons. Deliberately structural — no utilities_* hashes.
 */
function findButtonRow(header: Element): Element | null {
  let best: Element | null = null;
  let bestDepth = -1;
  const walk = (el: Element, depth: number) => {
    let direct = 0;
    for (const child of el.children) {
      if (child.tagName === "BUTTON") direct++;
      walk(child, depth + 1);
    }
    if (direct >= 2 && depth > bestDepth) {
      best = el;
      bestDepth = depth;
    }
  };
  walk(header, 0);
  return best;
}

/** Minimal escaping for embedding a path into an attribute selector. */
function cssEscapeAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
