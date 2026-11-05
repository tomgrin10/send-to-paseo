/**
 * The injected "Send to Paseo" button.
 *
 * Rendered inside its own shadow root so that (a) Graphite's CSS-module rules
 * can't restyle it and (b) our rules can't touch Graphite. The host element is
 * a custom tag, which also makes the marker guard trivially greppable.
 */

import { checkIcon, el, sendIcon, spinnerIcon } from "./dom";
import { containKeyboard } from "./keyboard";
import { BUTTON_CSS } from "./styles";

export const BUTTON_TAG = "send-to-paseo-button";
export const MARKER_ATTR = "data-send-to-paseo";

/** Site-neutral: which rung of the anchor ladder placed the button. */
export type ButtonMode = "anchored" | "anchored-fallback" | "floating";

/**
 * What the button tells the user without being opened.
 *
 * - `idle`     the default.
 * - `unpaired` no token stored, or the last resolve said `not_configured` /
 *              `unauthorized`. Amber dot: the next step belongs to the user.
 * - `sending`  a send is in flight. Spinner in place of the icon, `aria-busy`.
 * - `sent`     a send succeeded. Check + "Sent" for SENT_MS, then `idle`.
 * - `failed`   the last send failed. Red dot until the popover is next opened.
 *
 * Exposed as `data-stp-state` on the host so tests (and a curious user in
 * DevTools) can read it without reaching into the shadow root.
 */
export type ButtonState = "idle" | "unpaired" | "sending" | "sent" | "failed";

/** How long the "Sent" confirmation stays up. Same with reduced motion. */
export const SENT_MS = 4000;

const IDLE_LABEL = "Send to Paseo";

export interface ButtonHandle {
  /** Shadow host, lives in Graphite's DOM. */
  host: HTMLElement;
  /** The real <button>, inside the shadow root. Popover anchors to this. */
  button: HTMLButtonElement;
  setMode(mode: ButtonMode): void;
  setState(state: ButtonState): void;
  getState(): ButtonState;
  remove(): void;
}

export function createButton(
  prNumber: number,
  mode: ButtonMode,
  /** From the adapter's styleHint() — selects the visual language to imitate. */
  styleHint: "graphite" | "github",
  onClick: () => void,
): ButtonHandle {
  const host = document.createElement(BUTTON_TAG);
  host.setAttribute(MARKER_ATTR, "button");
  host.setAttribute("data-stp-pr", String(prNumber));
  host.setAttribute("data-stp-mode", mode);
  host.setAttribute("data-stp-style", styleHint);
  host.setAttribute("data-stp-state", "idle");
  if (mode === "floating") host.setAttribute("data-stp-floating", "true");

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = BUTTON_CSS;

  const idleTitle = `Send an instruction to a Paseo agent for PR #${prNumber}`;
  const button = el("button", {
    type: "button",
    "data-stp-button": "",
    // Graphite's own buttons carry these; matching them keeps the visual
    // language consistent if they ever style by attribute.
    "data-kind": "neutral",
    "data-priority": "secondary",
    "data-size": "s",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    title: idleTitle,
  }) as HTMLButtonElement;

  // The icon slot holds exactly one glyph at a time; the dot is a sibling so a
  // state that only adds a dot never rebuilds the icon.
  const glyphBox = el("span", { class: "glyph" });
  const dot = el("span", { class: "dot", "aria-hidden": "true" });
  const icon = el("span", { class: "icon" }, [glyphBox, dot]);
  // The label is a one-cell grid. `.label::after` lays the idle text into the
  // same cell invisibly, so the button is always as wide as "Send to Paseo"
  // and switching to "Sent" cannot shift the host page's action row. A
  // pseudo-element rather than a hidden node, because a node would land in
  // `textContent`, which screen readers and the e2e suite read as the label.
  const text = el("span", { class: "text" }, [IDLE_LABEL]);
  const label = el("span", { class: "label" }, [text]);
  glyphBox.append(sendIcon());
  button.append(icon, label);
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });

  root.append(style, button);

  // Enter/Space on our button belong to us, not to Graphite's shortcut layer.
  const releaseKeyboard = containKeyboard(host);

  let state: ButtonState = "idle";
  let sentTimer: number | undefined;
  let glyph: "send" | "spinner" | "check" = "send";

  const setGlyph = (next: typeof glyph) => {
    if (glyph === next) return;
    glyph = next;
    glyphBox.textContent = "";
    glyphBox.append(next === "spinner" ? spinnerIcon() : next === "check" ? checkIcon() : sendIcon());
  };

  const setState = (next: ButtonState) => {
    if (sentTimer !== undefined) {
      clearTimeout(sentTimer);
      sentTimer = undefined;
    }
    state = next;
    host.setAttribute("data-stp-state", next);
    setGlyph(next === "sending" ? "spinner" : next === "sent" ? "check" : "send");
    text.textContent = next === "sent" ? "Sent" : IDLE_LABEL;
    if (next === "sending") button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    button.title =
      next === "unpaired"
        ? "Set up Send to Paseo to start sending"
        : next === "failed"
          ? "The last send failed. Open to see why."
          : next === "sent"
            ? `Sent to Paseo for PR #${prNumber}`
            : idleTitle;
    if (next === "sent") {
      sentTimer = setTimeout(() => {
        sentTimer = undefined;
        if (state === "sent") setState("idle");
      }, SENT_MS) as unknown as number;
    }
  };

  return {
    host,
    button,
    setMode(next: ButtonMode) {
      host.setAttribute("data-stp-mode", next);
      if (next === "floating") host.setAttribute("data-stp-floating", "true");
      else host.removeAttribute("data-stp-floating");
    },
    setState,
    getState: () => state,
    remove() {
      if (sentTimer !== undefined) clearTimeout(sentTimer);
      releaseKeyboard();
      host.remove();
    },
  };
}
