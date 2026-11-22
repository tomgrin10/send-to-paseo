/**
 * The injected "Send to Paseo" button.
 *
 * Rendered inside its own shadow root so that (a) Graphite's CSS-module rules
 * can't restyle it and (b) our rules can't touch Graphite. The host element is
 * a custom tag, which also makes the marker guard trivially greppable.
 */

import { accessibleName, LABEL, PLAIN, type WorkspaceState } from "../../shared/button-state";
import { checkIcon, el, paseoMark, spinnerIcon } from "./dom";
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
 *              `unauthorized`. An ×, like "couldn't reach Paseo": the next
 *              step belongs to the user, and the tooltip says which.
 * - `sending`  a send is in flight. Spinner in place of the icon, `aria-busy`.
 * - `sent`     a send succeeded. Check + "Sent" for SENT_MS, then `idle`.
 * - `failed`   the last send failed. Red dot until the popover is next opened.
 *
 * Exposed as `data-stp-state` on the host so tests (and a curious user in
 * DevTools) can read it without reaching into the shadow root.
 *
 * Under these sits the PR's workspace state (`setWorkspace`, direction D in
 * DESIGN.md): a dot read by shape, plus a word chip only when it's the user's
 * turn. `sending`, `sent` and `failed` win while they show; the chip keeps its
 * room then (hidden, not removed) so the host page's row never shifts.
 * Exposed as `data-stp-ws` (none | working | needs | cross) and
 * `data-stp-ws-tone`.
 */
export type ButtonState = "idle" | "unpaired" | "sending" | "sent" | "failed";

/** How long the "Sent" confirmation stays up. Same with reduced motion. */
export const SENT_MS = 4000;

const IDLE_LABEL = LABEL;
/** Hover waits a beat so passing the pointer over the row doesn't flash it; focus shows at once. */
const TIP_HOVER_MS = 350;

export interface ButtonHandle {
  /** Shadow host, lives in Graphite's DOM. */
  host: HTMLElement;
  /** The real <button>, inside the shadow root. Popover anchors to this. */
  button: HTMLButtonElement;
  setMode(mode: ButtonMode): void;
  setState(state: ButtonState): void;
  getState(): ButtonState;
  /** The PR's workspace state, from the resolve the page already made. */
  setWorkspace(state: WorkspaceState): void;
  getWorkspace(): WorkspaceState;
  remove(): void;
}

export function createButton(
  prNumber: number,
  mode: ButtonMode,
  /** From the adapter's styleHint() — selects the visual language to imitate. */
  styleHint: "graphite" | "github",
  onClick: () => void,
  /** The user is about to read the state (hover or focus): a chance to refresh it, rate-limited by the caller. */
  onIntent?: () => void,
): ButtonHandle {
  const host = document.createElement(BUTTON_TAG);
  host.setAttribute(MARKER_ATTR, "button");
  host.setAttribute("data-stp-pr", String(prNumber));
  host.setAttribute("data-stp-mode", mode);
  host.setAttribute("data-stp-style", styleHint);
  host.setAttribute("data-stp-state", "idle");
  host.setAttribute("data-stp-ws", "none");
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
    // The tooltip below, not `title`: a title never shows on keyboard focus.
    "aria-describedby": "stp-tip",
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
  // The word chip, only in needs-you states. aria-hidden: the name already
  // carries the word ("Send to Paseo, Merge ready"), so it would read twice.
  const chip = el("span", { class: "chip", "aria-hidden": "true", "data-stp-chip": "" });
  glyphBox.append(paseoMark());
  button.append(icon, label, chip);

  // Tooltip on hover AND focus: Follow-up's full line, the workspace and the
  // machine, or how to fix the ×. Fixed-position so a clipping header can't
  // cut it; never announced on its own (no aria-live), only as the description.
  const tip = el("span", { class: "tip", id: "stp-tip", role: "tooltip", "data-stp-tip": "" });
  let tipTimer: number | undefined;
  const placeTip = () => {
    const r = button.getBoundingClientRect();
    tip.style.top = `${Math.round(r.bottom + 8)}px`;
    // Right-aligned under the button, kept inside the viewport.
    tip.style.left = "0px";
    const w = tip.getBoundingClientRect().width;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    tip.style.left = `${Math.round(Math.max(8, left))}px`;
  };
  const showTip = () => {
    if (tipTimer !== undefined) { clearTimeout(tipTimer); tipTimer = undefined; }
    if (button.getAttribute("aria-expanded") === "true") return;
    tip.setAttribute("data-open", "");
    placeTip();
  };
  const hideTip = () => {
    if (tipTimer !== undefined) { clearTimeout(tipTimer); tipTimer = undefined; }
    tip.removeAttribute("data-open");
  };
  button.addEventListener("pointerenter", () => {
    onIntent?.();
    if (tipTimer !== undefined) clearTimeout(tipTimer);
    tipTimer = setTimeout(showTip, TIP_HOVER_MS) as unknown as number;
  });
  button.addEventListener("pointerleave", () => { if (!button.matches(":focus-visible")) hideTip(); });
  button.addEventListener("focus", () => { onIntent?.(); if (button.matches(":focus-visible")) showTip(); });
  button.addEventListener("blur", hideTip);
  button.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });

  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideTip();
    onClick();
  });

  root.append(style, button, tip);

  // Enter/Space on our button belong to us, not to Graphite's shortcut layer.
  const releaseKeyboard = containKeyboard(host);

  let state: ButtonState = "idle";
  let workspace: WorkspaceState = PLAIN;
  let sentTimer: number | undefined;
  let glyph: "send" | "spinner" | "check" = "send";

  const setGlyph = (next: typeof glyph) => {
    if (glyph === next) return;
    glyph = next;
    glyphBox.textContent = "";
    glyphBox.append(next === "spinner" ? spinnerIcon() : next === "check" ? checkIcon() : paseoMark());
  };

  /** Name and tooltip from the send state over the workspace state. */
  const describe = () => {
    let name: string | null;
    let lines: string[];
    if (state === "sending") { name = null; lines = ["Sending…"]; }
    else if (state === "sent") { name = null; lines = [`Sent to Paseo for PR #${prNumber}`]; }
    else if (state === "failed") { name = `${IDLE_LABEL}, last send failed`; lines = ["The last send failed", "Open to see why"]; }
    else if (state === "unpaired") {
      name = `${IDLE_LABEL}, Not set up`;
      lines = workspace.mark === "cross" && workspace.tip.length ? workspace.tip : ["Not set up", "Open Send to Paseo's settings to pair this browser with Paseo"];
    } else {
      name = workspace.spoken ? accessibleName(workspace) : null;
      // The click line only where Open in Paseo will be there: a workspace owns the PR.
      lines = !workspace.tip.length ? [idleTitle] : workspace.mark === "cross" ? workspace.tip : [...workspace.tip, "Send an instruction, or open it in Paseo"];
    }
    if (name) button.setAttribute("aria-label", name);
    else button.removeAttribute("aria-label");
    tip.textContent = "";
    lines.forEach((line, i) => tip.append(el("span", { class: i === 0 ? "tip-line" : "tip-line sub" }, [line])));
    if (tip.hasAttribute("data-open")) placeTip();
  };

  const setWorkspace = (next: WorkspaceState) => {
    workspace = next;
    host.setAttribute("data-stp-ws", next.mark);
    if (next.tone) host.setAttribute("data-stp-ws-tone", next.tone);
    else host.removeAttribute("data-stp-ws-tone");
    chip.textContent = next.chip ?? "";
    describe();
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
    describe();
    if (next === "sent") {
      sentTimer = setTimeout(() => {
        sentTimer = undefined;
        if (state === "sent") setState("idle");
      }, SENT_MS) as unknown as number;
    }
  };

  describe();

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
    setWorkspace,
    getWorkspace: () => workspace,
    remove() {
      if (sentTimer !== undefined) clearTimeout(sentTimer);
      hideTip();
      releaseKeyboard();
      host.remove();
    },
  };
}
