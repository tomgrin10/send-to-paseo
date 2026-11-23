import { startGraphiteCompanion } from "./graphite-companion";
/**
 * Content script (isolated world). Owns injection and the SPA lifecycle.
 *
 * Everything site-specific is behind the SiteAdapter seam; this file never names
 * Graphite. It also never touches a credential — see src/content/bridge.ts.
 */

import type { PrRef } from "../shared/contract";
import type { MultiResolveResponse, Result } from "../shared/messages";
import { workspaceState } from "../shared/button-state";
import { adapterFor } from "./adapters";
import type { SiteAdapter } from "./adapters/types";
import {
  closePopover,
  invalidateWarmResolve,
  isPairingFailure,
  onResolve,
  togglePopover,
  warmPopoverResolution,
} from "./popover";
import { BUTTON_TAG, MARKER_ATTR, createButton, type ButtonHandle, type ButtonMode } from "./ui/button";

const LOCATION_EVENT = "send-to-paseo:locationchange";
const OBSERVER_DEBOUNCE_MS = 150;
const LOCATION_POLL_MS = 1000;
/**
 * The button's workspace state refreshes on tab focus and after a send, at most
 * once a minute: each refresh is a resolve, which runs `gh` on the bridge, and
 * the bridge caches that for 60 s. No polling: a hidden tab never refreshes.
 */
declare const __STP_REFRESH_MS__: number;
const WORKSPACE_REFRESH_MS = typeof __STP_REFRESH_MS__ === "number" ? __STP_REFRESH_MS__ : 60_000;

interface Mounted {
  pr: PrRef;
  mode: ButtonMode;
  handle: ButtonHandle;
  adapter: SiteAdapter;
  /** When this button last asked for a resolve (the warm-up counts). */
  refreshedAt: number;
  /** One deferred refresh, when one was asked for inside the minute. */
  refreshTimer?: number;
}

let mounted: Mounted | null = null;
let observer: MutationObserver | null = null;
let observedTarget: Element | null = null;
let debounceTimer: number | undefined;
let lastHref = location.href;

/* -------------------------------------------------------------------------- */
/* injection                                                                   */
/* -------------------------------------------------------------------------- */

function samePr(a: PrRef, b: PrRef): boolean {
  return a.forge === b.forge && a.owner === b.owner && a.repo === b.repo && a.number === b.number;
}

function unmount(): void {
  closePopover();
  if (mounted?.refreshTimer !== undefined) clearTimeout(mounted.refreshTimer);
  mounted?.handle.remove();
  mounted = null;
  // Belt and braces: if a previous script instance (extension reload, or a
  // duplicate injection) left a host behind, clear it. The marker attribute is
  // the single source of truth for "we are already here".
  for (const stale of document.querySelectorAll(`${BUTTON_TAG}[${MARKER_ATTR}="button"]`)) {
    stale.remove();
  }
}

/**
 * Idempotent. Safe to call on every mutation tick: when nothing has changed it
 * performs no DOM writes at all, which is what stops the MutationObserver from
 * feeding itself.
 */
function inject(): void {
  const url = new URL(location.href);
  const adapter = adapterFor(url);
  if (!adapter) {
    unmount();
    return;
  }
  const pr = adapter.parse(url);
  if (!pr) {
    unmount();
    return;
  }

  // A different PR: tear the old button down so it can never send to a stale
  // PR number. (SPA navigation between PRs is the common case here.)
  if (mounted && !samePr(mounted.pr, pr)) unmount();

  const placement = adapter.findAnchor();
  // Note what the adapter reports, not what the DOM looks like: this file must
  // stay free of site-specific selectors.
  const desiredMode: ButtonMode = !placement
    ? "floating"
    : placement.rung === "fallback"
      ? "anchored-fallback"
      : "anchored";

  if (mounted?.handle.host.isConnected) {
    if (isPlacedAsDesired(mounted.handle.host, placement)) {
      if (mounted.mode !== desiredMode) {
        mounted.handle.setMode(desiredMode);
        mounted.mode = desiredMode;
      }
      return; // nothing to do — no DOM write
    }
    // The anchor moved or a better anchor appeared (header renders after the
    // metadata block on a cold load). Relocate the same node; the popover, if
    // open, keeps its state.
    place(mounted.handle.host, placement);
    mounted.handle.setMode(desiredMode);
    mounted.mode = desiredMode;
    return;
  }

  const handle = createButton(pr.number, desiredMode, adapter.styleHint(), () => {
    const freshUrl = new URL(location.href);
    const freshPr = adapter.parse(freshUrl) ?? pr;
    togglePopover({
      pr: freshPr,
      stackPrNumbers: adapter.findStackPrNumbers(),
      pageUrl: location.href,
      anchor: handle.button,
      buttonState: handle.getState,
      setButtonState: (state) => {
        // A late answer for a button that has since been replaced (SPA nav to
        // another PR) must not paint the new one.
        if (mounted?.handle !== handle) return;
        handle.setState(state);
        // A send changes what the workspace is doing: ask again (rate-limited).
        if (state === "sent" || state === "queued") refreshWorkspace();
      },
    });
  }, () => {
    // About to read the tooltip: make it current (once a window at most, like focus).
    if (mounted?.handle === handle) refreshWorkspace();
  });

  place(handle.host, placement);
  mounted = { pr, mode: desiredMode, handle, adapter, refreshedAt: Date.now() };
  warmAndReflect(handle, { pr, stackPrNumbers: adapter.findStackPrNumbers() });
}

/** Paint one resolve answer on the button: the pairing dot, and the workspace state under it. */
function reflect(handle: ButtonHandle, result: Result<MultiResolveResponse>): void {
  if (mounted?.handle !== handle) return;
  const state = handle.getState();
  if (isPairingFailure(result)) {
    if (state === "idle") handle.setState("unpaired");
  } else if (state === "unpaired") {
    handle.setState("idle");
  }
  handle.setWorkspace(workspaceState(result));
}

/**
 * Re-ask for the workspace state, at most once per WORKSPACE_REFRESH_MS. Asked
 * inside the minute, it runs once when the minute is up (and only if the tab is
 * visible then; a hidden tab waits for focus instead).
 */
function refreshWorkspace(): void {
  const m = mounted;
  if (!m) return;
  const wait = m.refreshedAt + WORKSPACE_REFRESH_MS - Date.now();
  if (wait > 0) {
    if (m.refreshTimer === undefined) {
      m.refreshTimer = setTimeout(() => {
        m.refreshTimer = undefined;
        if (mounted === m && document.visibilityState === "visible") refreshWorkspace();
      }, wait) as unknown as number;
    }
    return;
  }
  m.refreshedAt = Date.now();
  const ctx = { pr: m.pr, stackPrNumbers: m.adapter.findStackPrNumbers() };
  invalidateWarmResolve(ctx);
  warmAndReflect(m.handle, ctx);
}

/**
 * Prewarm resolution (see popover.ts) and let its answer decide whether the
 * button wears the amber "not paired" dot. The resolve is happening anyway, so
 * this costs no request of its own — and with no token stored the service
 * worker answers `not_configured` without touching the network at all.
 */
function warmAndReflect(handle: ButtonHandle, ctx: { pr: PrRef; stackPrNumbers: number[] }): void {
  void warmPopoverResolution(ctx).then((result) => reflect(handle, result));
}

/**
 * Back on the tab. Pairing may have been finished in the options tab, so the
 * not-set-up × re-checks at once. Otherwise the workspace state refreshes,
 * at most once a minute.
 */
function onVisibilityChange(): void {
  if (document.visibilityState !== "visible" || !mounted) return;
  if (mounted.handle.getState() !== "unpaired" && mounted.handle.getWorkspace().mark !== "cross") {
    refreshWorkspace();
    return;
  }
  mounted.refreshedAt = Date.now();
  const ctx = { pr: mounted.pr, stackPrNumbers: mounted.adapter.findStackPrNumbers() };
  invalidateWarmResolve(ctx);
  warmAndReflect(mounted.handle, ctx);
}

function place(host: HTMLElement, placement: ReturnType<SiteAdapter["findAnchor"]>): void {
  if (!placement) {
    document.body.append(host); // floating fallback
    return;
  }
  if (placement.mode === "before") placement.el.parentElement?.insertBefore(host, placement.el);
  else placement.el.append(host);
}

function isPlacedAsDesired(
  host: HTMLElement,
  placement: ReturnType<SiteAdapter["findAnchor"]>,
): boolean {
  if (!placement) return host.parentElement === document.body;
  if (placement.mode === "before") {
    return host.nextElementSibling === placement.el && host.parentElement === placement.el.parentElement;
  }
  return host.parentElement === placement.el;
}

/* -------------------------------------------------------------------------- */
/* lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

function schedule(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    runInjection();
  }, OBSERVER_DEBOUNCE_MS) as unknown as number;
}

function runInjection(): void {
  // Pause observation while we write, so our own insertion can never re-enter.
  const wasObserving = observer !== null;
  if (wasObserving) observer!.disconnect();
  try {
    inject();
  } catch (e) {
    console.warn("[send-to-paseo] injection failed", e);
  } finally {
    if (wasObserving) attachObserver();
  }
}

function attachObserver(): void {
  const target = mounted?.adapter.observeTarget?.() ?? currentObserveTarget() ?? document.body;
  observedTarget = target;
  observer ??= new MutationObserver(() => schedule());
  observer.disconnect();
  observer.observe(target, { childList: true, subtree: true });
}

function currentObserveTarget(): Element | null {
  const adapter = adapterFor(new URL(location.href));
  return adapter?.observeTarget?.() ?? null;
}

function onLocationChange(): void {
  if (location.href === lastHref) return;
  lastHref = location.href;
  // A navigation invalidates any open popover: its PR ref, candidates and
  // resolve result all belong to the previous page.
  closePopover();
  schedule();
}

function start(): void {
  // Every resolve the popover makes for this PR repaints the button for free.
  onResolve((pr, _stack, result) => {
    if (mounted && samePr(mounted.pr, pr)) reflect(mounted.handle, result);
  });
  runInjection();
  attachObserver();

  // Signal from the MAIN-world shim (src/content/mainworld.ts). An isolated
  // world cannot see the page's history calls on its own.
  window.addEventListener(LOCATION_EVENT, onLocationChange);
  window.addEventListener("popstate", onLocationChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  setInterval(() => {
    // Safety net for a router that swaps the URL without touching history (or
    // if the MAIN-world shim was blocked by a page CSP)...
    onLocationChange();
    // ...and re-target if the observed root itself was replaced (route swap).
    const want = currentObserveTarget() ?? document.body;
    if (want !== observedTarget || (mounted && !mounted.handle.host.isConnected)) {
      // A replacement root may already contain the finished header. Merely
      // observing future mutations would leave the button missing forever.
      runInjection();
    }
  }, LOCATION_POLL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

startGraphiteCompanion();
