/**
 * The SiteAdapter seam.
 *
 * The five REQUIRED members below are exactly the interface specified in
 * PLAN.md §4 and must not drift — the GitHub adapter (phase 6) is meant to be a
 * drop-in. Everything else in the content script (injection loop, popover,
 * messaging, error handling) is site-agnostic and lives outside adapters/.
 *
 * The two optional members are extension points with safe defaults; an adapter
 * that omits them still works.
 */

import type { PrRef } from "../../shared/contract";

export interface AnchorPlacement {
  el: Element;
  mode: "append" | "before";
  /**
   * Optional, additive: which rung of the adapter's own ladder produced this
   * anchor. Lets the shared injection loop label the button without knowing a
   * single site-specific selector. Absent means "primary".
   */
  rung?: "primary" | "fallback";
}

export interface SiteAdapter {
  /** Does this adapter own the given page URL? */
  matches(url: URL): boolean;

  /** PR identity, from the URL only. Never from the DOM. */
  parse(url: URL): PrRef | null;

  /**
   * Sibling PR numbers in the same stack, scraped structurally from hrefs.
   * MUST exclude the PR the page is currently showing. `[]` is always fine.
   */
  findStackPrNumbers(): number[];

  /** Where to put the button, or null to use the floating fallback. */
  findAnchor(): AnchorPlacement | null;

  /** Which visual language the button should imitate. */
  styleHint(): "graphite" | "github";

  /* ---- optional ------------------------------------------------------- */

  /**
   * Element to hang the debounced MutationObserver on. Defaults to
   * `document.body` when absent — correct but noisier.
   */
  observeTarget?(): Element | null;

  /** Human name, used in log lines only. */
  readonly id?: string;
}
