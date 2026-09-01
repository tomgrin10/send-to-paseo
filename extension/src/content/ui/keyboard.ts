/**
 * Keyboard containment for our shadow hosts.
 *
 * WHY THIS EXISTS — measured on live Graphite, 2026-09-01. Keyboard events are
 * `composed`, so they escape a shadow root and reach the page's document- and
 * window-level listeners. Shadow DOM isolates CSS, not events.
 *
 * Worse, they are *retargeted*: a listener outside the shadow tree sees
 * `event.target === <send-to-paseo-popover>`, not our `<textarea>`. Graphite's
 * shortcut handler asks "is the user typing in a text field?", sees an unknown
 * custom element, decides no, and treats every keystroke as a shortcut — it
 * stole focus on almost every key. Typing
 *
 *     "Fix merge conflicts? c/j k n p a g r"
 *
 * into the popover produced the literal value `"x "`.
 *
 * Stopping propagation at the host fixes it. The host is the last node on the
 * retargeted path, so listeners inside the shadow tree have already run by the
 * time we stop: Cmd/Ctrl+Enter and link activation still work. Default actions
 * are unaffected, because stopPropagation is not preventDefault — the character
 * still reaches the textarea.
 *
 * THE CEILING — do not mistake this for total isolation. Graphite also registers
 * keydown listeners at *capture* phase on `window` (its own page chunk, plus
 * Datadog RUM) and on `document` (ariakit). Capture on `window` is the very
 * first step of event propagation and our content script runs at
 * `document_idle`, so no listener we add can be ordered ahead of them, and
 * nothing we do can stop them. Measured: those handlers do fire, but take no
 * action — with containment in place typing is byte-exact, focus is retained,
 * and ArrowUp/ArrowDown/Enter/Escape have no side effects.
 *
 * If Graphite ever moves a shortcut into a window-capture listener, this
 * approach cannot fix it, and no variation of it can. The fix then is to move
 * the composer into an extension-page `<iframe>`, whose key events never enter
 * the page's propagation path at all. That is a real cost (positioning, sizing,
 * focus) which today's evidence does not justify.
 */

/**
 * Every composed event a text field produces. `keypress` is deprecated but
 * Graphite still listens for it. Composition events matter for IME input, and
 * clipboard events matter because a page-level paste handler would otherwise
 * see — and could hijack — a paste into our textarea.
 */
const CONTAINED = [
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "paste",
  "cut",
  "copy",
] as const;

/**
 * Keep keyboard events originating inside `host` from reaching the page.
 * Returns a disposer.
 *
 * Bubble phase, deliberately: a capture-phase listener here would fire before
 * the event descended into the shadow tree and would break our own handlers.
 */
export function containKeyboard(host: HTMLElement): () => void {
  const stop = (e: Event): void => {
    e.stopPropagation();
  };
  for (const type of CONTAINED) host.addEventListener(type, stop);
  return () => {
    for (const type of CONTAINED) host.removeEventListener(type, stop);
  };
}
