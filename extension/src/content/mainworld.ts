/**
 * MAIN-world shim. Registered as a second content script with `world: "MAIN"`.
 *
 * WHY THIS FILE EXISTS: a content script runs in an isolated world with its own
 * JS wrappers. Patching `history.pushState` there does NOT observe the page's
 * own navigations — Graphite's router calls the MAIN world's `history`, and the
 * isolated world's patch never fires. So the patch has to live here, in the
 * page's world, and hand the signal over as a DOM event (DOM events do cross
 * worlds).
 *
 * This is the only extension code that runs in the page's world. It is
 * deliberately five lines of navigation plumbing: no token, no settings, no
 * message passing, no bridge URL. Nothing here is privileged.
 */

const EVENT = "send-to-paseo:locationchange";

function announce(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore */
  }
}

function patch(name: "pushState" | "replaceState"): void {
  const original = history[name];
  if (typeof original !== "function") return;
  if ((original as { __stpPatched?: boolean }).__stpPatched) return;

  const wrapped = function (this: History, ...args: unknown[]) {
    const out = (original as (...a: unknown[]) => unknown).apply(this, args);
    announce();
    return out;
  } as unknown as History["pushState"];
  (wrapped as unknown as { __stpPatched: boolean }).__stpPatched = true;
  history[name] = wrapped;
}

patch("pushState");
patch("replaceState");
// popstate is a DOM event and already crosses worlds, but re-announcing keeps
// the isolated side on a single code path.
window.addEventListener("popstate", announce);
window.addEventListener("hashchange", announce);

/**
 * Router-specific navigation signals, listened for unconditionally.
 *
 * These are site-agnostic on purpose: they are just event names, and a site
 * that does not use that router never fires them (none of these ever fire on
 * Graphite). Adding them costs three listener registrations and no branching.
 *
 * Measured on live github.com, 2026-09-01 (test/fixtures/github-dom-notes.md):
 * GitHub's Turbo DOES call `history.pushState` on every soft navigation, so the
 * patch above is already sufficient and these are belt-and-braces rather than a
 * fix. They are worth having because the two GitHub navigation kinds emit
 * *different* event sets — a same-PR tab switch (`/` -> `/changes`) fires only
 * `soft-nav:*`, while a cross-page Turbo visit fires the full `turbo:*` set —
 * and because `turbo:render` replaces DOM after the URL has already changed,
 * which is exactly the moment a re-injection check is worth running again.
 *
 * They are dispatched on `document`, not `window`, hence the separate target.
 */
for (const type of ["turbo:load", "turbo:render", "soft-nav:end"]) {
  document.addEventListener(type, announce);
}
