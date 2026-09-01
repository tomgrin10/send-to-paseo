/**
 * The injected "Send to Paseo" button.
 *
 * Rendered inside its own shadow root so that (a) Graphite's CSS-module rules
 * can't restyle it and (b) our rules can't touch Graphite. The host element is
 * a custom tag, which also makes the marker guard trivially greppable.
 */

import { el, sendIcon } from "./dom";
import { containKeyboard } from "./keyboard";
import { BUTTON_CSS } from "./styles";

export const BUTTON_TAG = "send-to-paseo-button";
export const MARKER_ATTR = "data-send-to-paseo";

/** Site-neutral: which rung of the anchor ladder placed the button. */
export type ButtonMode = "anchored" | "anchored-fallback" | "floating";

export interface ButtonHandle {
  /** Shadow host, lives in Graphite's DOM. */
  host: HTMLElement;
  /** The real <button>, inside the shadow root. Popover anchors to this. */
  button: HTMLButtonElement;
  setMode(mode: ButtonMode): void;
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
  if (mode === "floating") host.setAttribute("data-stp-floating", "true");

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = BUTTON_CSS;

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
    title: `Send an instruction to a Paseo agent for PR #${prNumber}`,
  }) as HTMLButtonElement;
  button.append(sendIcon(), el("span", {}, ["Send to Paseo"]));
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });

  root.append(style, button);

  // Enter/Space on our button belong to us, not to Graphite's shortcut layer.
  const releaseKeyboard = containKeyboard(host);

  return {
    host,
    button,
    setMode(next: ButtonMode) {
      host.setAttribute("data-stp-mode", next);
      if (next === "floating") host.setAttribute("data-stp-floating", "true");
      else host.removeAttribute("data-stp-floating");
    },
    remove() {
      releaseKeyboard();
      host.remove();
    },
  };
}
