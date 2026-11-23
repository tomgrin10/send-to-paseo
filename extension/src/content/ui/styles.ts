/**
 * All extension CSS, as strings injected into shadow roots.
 *
 * Shadow DOM is non-negotiable here (PLAN.md §4): Graphite's stylesheets cannot
 * reach in and ours cannot leak out onto a page whose class names we do not
 * control. Consequently every selector below is scoped to its own shadow tree
 * and there is not a single global rule in the extension.
 *
 * Light and dark both come from `prefers-color-scheme` on custom properties, so
 * a theme flip needs no JS and no re-render.
 */

const TOKENS = `
:host {
  /* light */
  --stp-bg: #ffffff;
  --stp-bg-subtle: #f6f7f9;
  --stp-bg-hover: #eef0f3;
  --stp-fg: #16181d;
  --stp-fg-muted: #676e79;
  --stp-border: #d7dae0;
  --stp-border-strong: #c2c7d0;
  --stp-accent: #5b57e0;
  --stp-accent-hover: #4a46d4;
  --stp-accent-fg: #ffffff;
  --stp-danger: #b42318;
  --stp-danger-bg: #fef3f2;
  --stp-danger-border: #fbcfc9;
  --stp-success: #0b7a4b;
  --stp-success-bg: #eefaf3;
  --stp-success-border: #b8e6cd;
  --stp-warn: #92500e;
  --stp-warn-bg: #fff8eb;
  --stp-warn-border: #f5dda6;
  --stp-shadow: 0 8px 28px rgba(16, 18, 23, 0.16), 0 1px 2px rgba(16, 18, 23, 0.08);
  --stp-radius: 6px;
  --stp-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  --stp-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :host {
    --stp-bg: #1d2025;
    --stp-bg-subtle: #24282e;
    --stp-bg-hover: #2c3138;
    --stp-fg: #e7e9ec;
    --stp-fg-muted: #98a0ab;
    --stp-border: #383e46;
    --stp-border-strong: #4a515b;
    --stp-accent: #7d78ff;
    --stp-accent-hover: #8f8bff;
    --stp-accent-fg: #12131a;
    --stp-danger: #ff9b92;
    --stp-danger-bg: #2e1c1a;
    --stp-danger-border: #57302c;
    --stp-success: #6ddba2;
    --stp-success-bg: #14261e;
    --stp-success-border: #2b4d3a;
    --stp-warn: #f2c169;
    --stp-warn-bg: #2a2213;
    --stp-warn-border: #524126;
    --stp-shadow: 0 10px 34px rgba(0, 0, 0, 0.55), 0 1px 2px rgba(0, 0, 0, 0.4);
  }
}

/* GitHub can pin its theme with html[data-color-mode] regardless of the OS
   setting. The page button already follows (it reads Primer's own tokens);
   without these two blocks the popover would open light on a page pinned dark,
   and vice versa. :host-context() is Chromium-only, which is fine for an MV3
   extension, and no page but github.com sets this attribute. */
:host-context(html[data-color-mode="dark"]) {
    --stp-bg: #1d2025;
    --stp-bg-subtle: #24282e;
    --stp-bg-hover: #2c3138;
    --stp-fg: #e7e9ec;
    --stp-fg-muted: #98a0ab;
    --stp-border: #383e46;
    --stp-border-strong: #4a515b;
    --stp-accent: #7d78ff;
    --stp-accent-hover: #8f8bff;
    --stp-accent-fg: #12131a;
    --stp-danger: #ff9b92;
    --stp-danger-bg: #2e1c1a;
    --stp-danger-border: #57302c;
    --stp-success: #6ddba2;
    --stp-success-bg: #14261e;
    --stp-success-border: #2b4d3a;
    --stp-warn: #f2c169;
    --stp-warn-bg: #2a2213;
    --stp-warn-border: #524126;
    --stp-shadow: 0 10px 34px rgba(0, 0, 0, 0.55), 0 1px 2px rgba(0, 0, 0, 0.4);
}
:host-context(html[data-color-mode="light"]) {
  --stp-bg: #ffffff;
  --stp-bg-subtle: #f6f7f9;
  --stp-bg-hover: #eef0f3;
  --stp-fg: #16181d;
  --stp-fg-muted: #676e79;
  --stp-border: #d7dae0;
  --stp-border-strong: #c2c7d0;
  --stp-accent: #5b57e0;
  --stp-accent-hover: #4a46d4;
  --stp-accent-fg: #ffffff;
  --stp-danger: #b42318;
  --stp-danger-bg: #fef3f2;
  --stp-danger-border: #fbcfc9;
  --stp-success: #0b7a4b;
  --stp-success-bg: #eefaf3;
  --stp-success-border: #b8e6cd;
  --stp-warn: #92500e;
  --stp-warn-bg: #fff8eb;
  --stp-warn-border: #f5dda6;
  --stp-shadow: 0 8px 28px rgba(16, 18, 23, 0.16), 0 1px 2px rgba(16, 18, 23, 0.08);
}

* { box-sizing: border-box; }
`;

/**
 * The injected button. Mirrors Graphite's own button metrics and carries the
 * same data-kind / data-priority / data-size attributes they use, so it reads as
 * part of their action row rather than a bolted-on widget.
 */
export const BUTTON_CSS = `
${TOKENS}

:host {
  display: inline-flex;
  vertical-align: middle;
  font-family: var(--stp-font);
}

:host([data-stp-floating="true"]) {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
}

button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  margin: 0;
  font: 500 12.5px/1 var(--stp-font);
  color: var(--stp-fg);
  /* Transparent on purpose: the button sits inside Graphite's own action row,
     whose surface colour we do not know and cannot read through Shadow DOM.
     Inheriting the backdrop is what makes it look native in both themes. */
  background: transparent;
  border: 1px solid var(--stp-border);
  border-radius: var(--stp-radius);
  cursor: pointer;
  white-space: nowrap;
  transition: background 90ms ease, border-color 90ms ease;
  -webkit-font-smoothing: antialiased;
}

/* Theme-agnostic tints, for the same reason. */
button:hover { background: rgba(127, 133, 145, 0.14); border-color: var(--stp-border-strong); }
button:active { transform: translateY(0.5px); }
button:focus-visible { outline: 2px solid var(--stp-accent); outline-offset: 1px; }
button[aria-expanded="true"] { background: rgba(127, 133, 145, 0.2); border-color: var(--stp-border-strong); }

/* The floating fallback overlaps page content, so it needs a real surface. */
:host([data-stp-floating="true"]) button {
  height: 34px;
  padding: 0 14px;
  background: var(--stp-bg);
  box-shadow: var(--stp-shadow);
}
:host([data-stp-floating="true"]) button:hover { background: var(--stp-bg-hover); }

/* ---- icon slot and state ----------------------------------------------- */
:host {
  --stp-btn-icon: 14px;
  --stp-dot-bad: #d1242f;
  --stp-ok-icon: var(--stp-success);
  /* Workspace tones (direction D). GitHub's branch reads Primer's own below. */
  --stp-t-attention: #9a6700;
  --stp-t-danger: #d1242f;
  --stp-t-success: #1a7f37;
  --stp-t-accent: #0969da;
  --stp-t-muted: #59636e;
  /* Chip text: a step stronger than the dot's tone, so the word clears WCAG AA
     4.5:1 on its own tint (Follow-up's tone colour alone measured 3.5-4.2). */
  --stp-c-attention: #7d4e00;
  --stp-c-danger: #a40e26;
  --stp-c-success: #116329;
  --stp-c-accent: #0550ae;
  --stp-c-muted: #424a53;
  --stp-chip-mix: 10%;
}
@media (prefers-color-scheme: dark) {
  :host {
    --stp-dot-bad: #f85149;
    --stp-t-attention: #d29922;
    --stp-t-danger: #f85149;
    --stp-t-success: #3fb950;
    --stp-t-accent: #4493f8;
    --stp-t-muted: #9198a1;
    --stp-c-attention: #e3b341;
    --stp-c-danger: #ff7b72;
    --stp-c-success: #56d364;
    --stp-c-accent: #79c0ff;
    --stp-c-muted: #b7bdc8;
    --stp-chip-mix: 16%;
  }
}

.icon {
  position: relative;
  display: inline-flex;
  flex: none;
  width: var(--stp-btn-icon);
  height: var(--stp-btn-icon);
}
.glyph { display: inline-flex; width: 100%; height: 100%; }
svg { width: 100%; height: 100%; flex: none; color: var(--stp-accent); }

/* The mark's corner badge, bottom right like Paseo's own favicons. Read by
   SHAPE before colour, so it survives colour-blindness and greyscale:
     needs    9px solid dot in the state's tone (and a word chip, below)
     working  7px blue dot: an agent or Follow-up is on it
     cross    an ×: couldn't reach Paseo, or not set up
     failed   9px red dot: the last send failed
   The glyph is cut away around the badge (a mask, below) rather than ringed
   in a guessed surface colour: Graphite's button is transparent, so a painted
   ring showed as a halo in dark mode. The words are in the accessible name
   and the tooltip, never colour alone. */
.dot {
  display: none;
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  --tone: var(--stp-t-muted);
  background: var(--tone);
}
:host([data-stp-state="idle"]:not([data-stp-ws="none"])) .glyph,
:host([data-stp-state="failed"]) .glyph,
:host([data-stp-state="unpaired"]) .glyph {
  -webkit-mask: radial-gradient(circle at calc(100% - 0.5px) calc(100% - 0.5px), transparent 6.5px, #000 7px);
  mask: radial-gradient(circle at calc(100% - 0.5px) calc(100% - 0.5px), transparent 6.5px, #000 7px);
}
:host([data-stp-ws-tone="attention"]) { --stp-tone: var(--stp-t-attention); --stp-tone-text: var(--stp-c-attention); }
:host([data-stp-ws-tone="danger"]) { --stp-tone: var(--stp-t-danger); --stp-tone-text: var(--stp-c-danger); }
:host([data-stp-ws-tone="success"]) { --stp-tone: var(--stp-t-success); --stp-tone-text: var(--stp-c-success); }
:host([data-stp-ws-tone="accent"]) { --stp-tone: var(--stp-t-accent); --stp-tone-text: var(--stp-c-accent); }
:host([data-stp-ws-tone="muted"]) { --stp-tone: var(--stp-t-muted); --stp-tone-text: var(--stp-c-muted); }

:host([data-stp-state="idle"][data-stp-ws="needs"]) .dot { display: block; --tone: var(--stp-tone); }
:host([data-stp-state="idle"][data-stp-ws="working"]) .dot {
  display: block;
  --tone: var(--stp-t-accent);
  width: 7px;
  height: 7px;
  right: -3px;
  bottom: -3px;
}
/* The ×: two 2px bars in the cut-out, so it reads as a mark, not a smudge.
   Not set up wears it too: both mean "the next step is yours". */
:host([data-stp-state="idle"][data-stp-ws="cross"]) .dot,
:host([data-stp-state="unpaired"]) .dot {
  display: block;
  background: transparent;
}
:host([data-stp-state="idle"][data-stp-ws="cross"]) .dot::before,
:host([data-stp-state="idle"][data-stp-ws="cross"]) .dot::after,
:host([data-stp-state="unpaired"]) .dot::before,
:host([data-stp-state="unpaired"]) .dot::after {
  content: "";
  position: absolute;
  left: 3.5px;
  top: -0.5px;
  width: 2px;
  height: 10px;
  border-radius: 1px;
  background: var(--stp-t-muted);
  transform: rotate(45deg);
}
:host([data-stp-state="idle"][data-stp-ws="cross"]) .dot::after,
:host([data-stp-state="unpaired"]) .dot::after { transform: rotate(-45deg); }
:host([data-stp-state="failed"]) .dot { display: block; --tone: var(--stp-dot-bad); }

/* The word chip: only in needs-you states, so the row widens only when there
   is something to do. Clamped with an ellipsis; the full line is in the
   tooltip. While sending / sent show (seconds), it keeps its room (hidden, not
   removed) so the host page's action row never shifts. */
.chip {
  display: none;
  max-width: 112px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: -2px;
  padding: 0 7px;
  border-radius: 999px;
  font: 600 11.5px/18px var(--stp-font);
  color: var(--stp-tone-text, var(--stp-tone));
  background: color-mix(in srgb, var(--stp-tone) var(--stp-chip-mix), transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--stp-tone) 35%, transparent);
}
:host([data-stp-ws="needs"]) .chip { display: inline-block; animation: stp-chip-in 160ms ease-out; }
/* The chip lands after the first paint (the resolve), so the row grows once:
   let that read as arrival, not a jump. */
@keyframes stp-chip-in { from { max-width: 0; opacity: 0; padding-inline: 0; } to { max-width: 112px; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { :host([data-stp-ws="needs"]) .chip { animation: none; } }
:host([data-stp-style="graphite"]) .chip { margin-left: 0; }
:host([data-stp-ws="needs"]:is([data-stp-state="sending"], :is([data-stp-state="sent"], [data-stp-state="queued"]))) .chip { visibility: hidden; }
/* Failed lasts until the next open, so a held gap would look broken: the chip
   steps out, and the red dot says what happened. */
:host([data-stp-ws="needs"]:is([data-stp-state="failed"], [data-stp-state="unpaired"])) .chip { display: none; }

/* The tooltip. Fixed, so a clipping header row can't cut it; dark on both
   themes like GitHub's own. Shown on hover after a beat and on keyboard focus
   at once; Esc, blur, leaving or clicking hides it. */
.tip {
  display: none;
  position: fixed;
  z-index: 2147483001;
  max-width: min(360px, calc(100vw - 16px));
  padding: 6px 8px;
  border-radius: 6px;
  background: #25292e;
  color: #ffffff;
  font: 400 12px/1.4 var(--stp-font);
  text-align: left;
  pointer-events: none;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) { .tip { background: #3d444d; color: #f0f6fc; } }
.tip[data-open] { display: flex; flex-direction: column; }
.tip-line { overflow-wrap: anywhere; }
.tip-line.sub { color: color-mix(in srgb, currentColor 72%, transparent); }

:host([data-stp-state="sending"]) svg { color: var(--stp-fg-muted); }
:host([data-stp-state="sending"]) button { cursor: progress; }
:host(:is([data-stp-state="sent"], [data-stp-state="queued"])) svg { color: var(--stp-ok-icon); }

.spin { animation: stp-spin 800ms linear infinite; }
@keyframes stp-spin { to { transform: rotate(360deg); } }
:host(:is([data-stp-state="sent"], [data-stp-state="queued"])) .glyph { animation: stp-pop 180ms ease-out; }
@keyframes stp-pop { from { transform: scale(0.6); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .spin { animation-duration: 2.4s; }
  :host(:is([data-stp-state="sent"], [data-stp-state="queued"])) .glyph { animation: none; }
  button { transition: none; }
}

/* Width lock. The idle label is laid into the same grid cell, invisibly, so
   "Sent" occupies exactly the width "Send to Paseo" did and the host page's
   action row never shifts. */
.label { display: inline-grid; text-align: left; }
.label > .text, .label::after { grid-area: 1 / 1; }
.label::after {
  content: "Send to Paseo";
  visibility: hidden;
  height: 0;
  overflow: hidden;
}

/* Per-site visual language, selected by the adapter's styleHint().
   Graphite: 28px / 6px radius / 13px text, matching their action-row buttons.

   GitHub: measured from the real "Code" button in the PR header action row on
   live github.com, 2026-09-01 (test/fixtures/github-dom-notes.md):

     height 32px · padding 0 12px · gap 8px · border-radius 6px
     font   500 14px  (NOT the 600 12px this branch previously guessed)
     light  color #25292e  bg #f6f8fa  border #d1d9e0
     shadow 0 1px 0 rgba(31,35,40,.04)

   Unlike the Graphite branch this one paints a real surface rather than staying
   transparent, because GitHub's own header buttons do — a transparent button
   next to "Code" reads as a link, not a button.

   THEMING. Every colour is taken from GitHub's own Primer tokens with the
   measured value as a fallback. CSS custom properties are inherited properties,
   so they cross the shadow boundary; verified by planting a probe shadow root
   in the real action row and reading it back under both colour schemes. That
   means this tracks data-color-mode="auto", an explicit data-color-mode="dark",
   AND any custom Primer theme, with no :host-context() and no JS. The
   prefers-color-scheme block below only matters if GitHub's tokens are missing
   (a fixture, or a future Primer rename). */
:host([data-stp-style="github"]) {
  --stp-gh-fg: var(--button-default-fgColor-rest, var(--fgColor-default, #25292e));
  --stp-gh-bg: var(--button-default-bgColor-rest, #f6f8fa);
  --stp-gh-bg-hover: var(--button-default-bgColor-hover, #eff2f5);
  --stp-gh-border: var(--button-default-borderColor-rest, #d1d9e0);
  --stp-gh-border-hover: var(--button-default-borderColor-hover, #d1d9e0);
  --stp-gh-focus: var(--focus-outlineColor, #0969da);
  --stp-gh-shadow: 0 1px 0 rgba(31, 35, 40, 0.04);
  --stp-gh-font: var(--fontStack-system, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif);
}

@media (prefers-color-scheme: dark) {
  :host([data-stp-style="github"]) {
    --stp-gh-fg: var(--button-default-fgColor-rest, var(--fgColor-default, #f0f6fc));
    --stp-gh-bg: var(--button-default-bgColor-rest, #212830);
    --stp-gh-bg-hover: var(--button-default-bgColor-hover, #262c36);
    --stp-gh-border: var(--button-default-borderColor-rest, #3d444d);
    --stp-gh-border-hover: var(--button-default-borderColor-hover, #3d444d);
    --stp-gh-focus: var(--focus-outlineColor, #1f6feb);
    --stp-gh-shadow: 0 0 transparent;
  }
}

/* GitHub can also be pinned to a theme regardless of the OS setting, via
   data-color-mode on <html>. The token vars above already follow that, but the
   fallbacks would be stale, so pin those too. :host-context() is Chromium-only
   and this is a Chrome MV3 extension.

   These two blocks are not scoped to [data-stp-style="github"] because
   :host-context() cannot carry a further host condition. That is harmless: they
   define only --stp-gh-* custom properties, which no other style branch reads,
   and no page but github.com sets data-color-mode. */
:host-context(html[data-color-mode="dark"]) {
  --stp-gh-fg: var(--button-default-fgColor-rest, var(--fgColor-default, #f0f6fc));
  --stp-gh-bg: var(--button-default-bgColor-rest, #212830);
  --stp-gh-bg-hover: var(--button-default-bgColor-hover, #262c36);
  --stp-gh-border: var(--button-default-borderColor-rest, #3d444d);
  --stp-gh-border-hover: var(--button-default-borderColor-hover, #3d444d);
  --stp-gh-shadow: 0 0 transparent;
}
:host-context(html[data-color-mode="light"]) {
  --stp-gh-fg: var(--button-default-fgColor-rest, var(--fgColor-default, #25292e));
  --stp-gh-bg: var(--button-default-bgColor-rest, #f6f8fa);
  --stp-gh-bg-hover: var(--button-default-bgColor-hover, #eff2f5);
  --stp-gh-border: var(--button-default-borderColor-rest, #d1d9e0);
  --stp-gh-border-hover: var(--button-default-borderColor-hover, #d1d9e0);
  --stp-gh-shadow: 0 1px 0 rgba(31, 35, 40, 0.04);
}

:host([data-stp-style="github"]) button {
  height: 32px;
  padding: 0 12px;
  gap: 8px;
  font: 500 14px/1.5 var(--stp-gh-font);
  border-radius: 6px;
  color: var(--stp-gh-fg);
  background: var(--stp-gh-bg);
  border: 1px solid var(--stp-gh-border);
  box-shadow: var(--stp-gh-shadow);
}
:host([data-stp-style="github"]) button:hover {
  background: var(--stp-gh-bg-hover);
  border-color: var(--stp-gh-border-hover);
}
:host([data-stp-style="github"]) button[aria-expanded="true"] {
  background: var(--stp-gh-bg-hover);
  border-color: var(--stp-gh-border-hover);
}
:host([data-stp-style="github"]) button:focus-visible {
  outline: 2px solid var(--stp-gh-focus);
  outline-offset: -2px;
}
/* GitHub's action row is a flex container with its own 8px gap, so the button
   needs no margin of its own; the floating fallback still gets our surface. */
:host([data-stp-style="github"][data-stp-floating="true"]) button {
  height: 32px;
  padding: 0 12px;
  box-shadow: var(--stp-shadow);
}
:host([data-stp-style="github"]) {
  --stp-btn-icon: 16px;
  --stp-dot-bad: var(--bgColor-danger-emphasis, #cf222e);
  --stp-ok-icon: var(--fgColor-success, #1a7f37);
  /* Primer's own foreground tones, so a custom or pinned theme carries over;
     the fallbacks are the :host defaults above (light, or dark by media). */
  --stp-t-attention: var(--fgColor-attention, #9a6700);
  --stp-t-danger: var(--fgColor-danger, #d1242f);
  --stp-t-success: var(--fgColor-success, #1a7f37);
  --stp-t-accent: var(--fgColor-accent, #0969da);
  --stp-t-muted: var(--fgColor-muted, #59636e);
}
@media (prefers-color-scheme: dark) {
  :host([data-stp-style="github"]) {
    --stp-t-attention: var(--fgColor-attention, #d29922);
    --stp-t-danger: var(--fgColor-danger, #f85149);
    --stp-t-success: var(--fgColor-success, #3fb950);
    --stp-t-accent: var(--fgColor-accent, #4493f8);
    --stp-t-muted: var(--fgColor-muted, #9198a1);
    --stp-dot-bad: var(--bgColor-danger-emphasis, #da3633);
  }
}
:host-context(html[data-color-mode="dark"]) {
  --stp-chip-mix: 16%;
  --stp-dot-bad: var(--bgColor-danger-emphasis, #da3633);
  --stp-c-attention: #e3b341; --stp-c-danger: #ff7b72; --stp-c-success: #56d364; --stp-c-accent: #79c0ff; --stp-c-muted: #b7bdc8;
}
:host-context(html[data-color-mode="light"]) {
  --stp-chip-mix: 10%;
  --stp-c-attention: #7d4e00; --stp-c-danger: #a40e26; --stp-c-success: #116329; --stp-c-accent: #0550ae; --stp-c-muted: #424a53;
}
:host([data-stp-style="github"]) .chip { font: 600 12px/20px var(--stp-gh-font); }
:host([data-stp-style="github"]) .tip { font-family: var(--stp-gh-font); }
:host-context(html[data-color-mode="dark"]) .tip { background: #3d444d; color: #f0f6fc; }
:host-context(html[data-color-mode="light"]) .tip { background: #25292e; color: #ffffff; }
`;

/** The composer popover. Lives in its own shadow root attached to <body>. */
export const POPOVER_CSS = `
${TOKENS}

:host {
  position: fixed;
  z-index: 2147483001;
  font-family: var(--stp-font);
}

/* Height-capped and column-flexed so the BODY is the scroller. The Target
   dropdown opens in normal flow and grows the card (ui/combobox.ts explains
   why it is not an absolute overlay); without this cap a tall dropdown in a
   short window could push the card past the viewport, which position() can
   only clamp, not shrink. */
.card {
  width: 392px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  display: flex;
  flex-direction: column;
  background: var(--stp-bg);
  color: var(--stp-fg);
  border: 1px solid var(--stp-border);
  border-radius: 10px;
  box-shadow: var(--stp-shadow);
  overflow: hidden;
}

header, footer { flex: none; }

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--stp-border);
  background: var(--stp-bg-subtle);
}

.title { font: 600 12px/1.3 var(--stp-font); letter-spacing: 0.01em; }
.head-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pr { font: 500 11px/1.3 var(--stp-mono); color: var(--stp-fg-muted); }

/* The settings cog. Transparent until hovered so it reads as a secondary
   affordance next to the PR reference rather than competing with Send, and
   sized 22px so it stays inside the header's 10px padding without growing it. */
.cog {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--stp-fg-muted);
  cursor: pointer;
}
.cog:hover { background: var(--stp-bg-hover); color: var(--stp-fg); }
.cog:focus-visible {
  outline: 2px solid var(--stp-accent);
  outline-offset: 1px;
  color: var(--stp-fg);
}

.body { padding: 12px; display: grid; gap: 10px; overflow-y: auto; }

/* ".field", not "label.field": the Target field cannot be a <label>, because a
   label wrapping its own control forwards clicks to it and would re-toggle the
   combobox trigger. */
.field { display: grid; gap: 4px; }
/* Sentence-case semibold, like Primer's FormControl labels and Graphite's
   field labels. Uppercase tracked eyebrows read as a third design language. */
.field > span.lbl {
  font: 600 12px/1.3 var(--stp-font);
  color: var(--stp-fg);
}

select, textarea {
  width: 100%;
  font: 400 13px/1.45 var(--stp-font);
  color: var(--stp-fg);
  background: var(--stp-bg);
  border: 1px solid var(--stp-border);
  border-radius: var(--stp-radius);
  padding: 6px 8px;
}
select { height: 30px; padding: 0 6px; }
textarea { resize: vertical; min-height: 78px; }

/* Unattended permission modes (Claude's "Bypass", Codex's "Full Access") are
   listed, never hidden — so the danger has to be visible instead. Amber, from
   the same --stp-warn token the branch-mismatch note uses, which is defined for
   both light and dark; plus a ⚠ glyph in the option text for the platforms that
   ignore <option> colours entirely. */
select > option.danger { color: var(--stp-warn); }
.mode-warning {
  color: var(--stp-warn);
  font: 500 11px/1.35 var(--stp-font);
}
textarea::placeholder { color: var(--stp-fg-muted); opacity: 0.62; }
select:focus, textarea:focus { outline: 2px solid var(--stp-accent); outline-offset: -1px; border-color: var(--stp-accent); }

/* ------------------------------------------------------------------------- *
 * Target combobox (ui/combobox.ts)
 *
 * Every colour is one of the --stp-* tokens, which are defined for light AND
 * dark in TOKENS above. Nothing here is site-specific: unlike the button, the
 * popover paints its own surface on both Graphite and GitHub, so a hardcoded
 * hex would be wrong on one of the four combinations rather than right on any.
 * ------------------------------------------------------------------------- */

.combo { position: relative; display: grid; gap: 4px; }
[hidden] { display: none !important; }

.combo-trigger {
  position: relative;
  display: block;
  width: 100%;
  height: 30px;
  margin: 0;
  padding: 0 26px 0 8px;
  font: 400 13px/28px var(--stp-font);
  text-align: left;
  color: var(--stp-fg);
  background: var(--stp-bg);
  border: 1px solid var(--stp-border);
  border-radius: var(--stp-radius);
  cursor: pointer;
  /* The option label is long and the card is a fixed 392px, so the label is
     clipped here rather than allowed to stretch the card. */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* Caret drawn in CSS, deliberately: appending a glyph node would put it in
   trigger.textContent, which is what both a screen reader and the e2e suite
   read as the committed value. */
.combo-trigger::after {
  content: "";
  position: absolute;
  right: 10px;
  top: 50%;
  width: 6px;
  height: 6px;
  margin-top: -5px;
  border-right: 1.5px solid var(--stp-fg-muted);
  border-bottom: 1.5px solid var(--stp-fg-muted);
  transform: rotate(45deg);
  pointer-events: none;
}
.combo-trigger:hover { background: var(--stp-bg-hover); border-color: var(--stp-border-strong); }
.combo-trigger:focus-visible,
.combo[data-stp-combo-open="true"] .combo-trigger {
  outline: 2px solid var(--stp-accent);
  outline-offset: -1px;
  border-color: var(--stp-accent);
}

.combo-panel {
  display: grid;
  gap: 0;
  border: 1px solid var(--stp-border-strong);
  border-radius: var(--stp-radius);
  background: var(--stp-bg);
  box-shadow: var(--stp-shadow);
  overflow: hidden;
}

.combo-search {
  width: 100%;
  height: 30px;
  padding: 0 8px;
  font: 400 13px/1.45 var(--stp-font);
  color: var(--stp-fg);
  background: var(--stp-bg-subtle);
  border: 0;
  border-bottom: 1px solid var(--stp-border);
  border-radius: 0;
  outline: none;
}
.combo-search::placeholder { color: var(--stp-fg-muted); opacity: 0.62; }

/* Scrollable and capped, so a project with thirty workspaces cannot make the
   dropdown taller than the window. vh keeps the cap honest in a short one. */
.combo-list {
  max-height: min(216px, 34vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  position: relative;
}

.combo-option {
  padding: 6px 8px;
  font: 400 12.5px/1.4 var(--stp-font);
  color: var(--stp-fg);
  cursor: pointer;
}
.combo-option[data-stp-active="true"] { background: var(--stp-bg-hover); }
.combo-option[aria-selected="true"] { font-weight: 600; }
.combo-option[aria-selected="true"]::before {
  content: "✓ ";
  color: var(--stp-accent);
}
.combo-option[aria-selected="false"]::before { content: ""; }

.combo-empty {
  padding: 8px;
  font: 400 12px/1.4 var(--stp-font);
  color: var(--stp-fg-muted);
}

.target-summary {
  font: 500 12px/1.45 var(--stp-font);
  padding: 7px 9px;
  border: 1px solid var(--stp-border);
  border-radius: var(--stp-radius);
  background: var(--stp-bg-subtle);
}
.target-summary .thead { display: flex; align-items: flex-start; gap: 6px; }
.target-summary .ticon { display: inline-flex; flex: none; height: 17px; align-items: center; color: var(--stp-fg-muted); }
.target-summary .ttext { min-width: 0; overflow-wrap: anywhere; }
/* Why this target. Same words as the Paseo card; amber only when the branch
   has merged or closed, i.e. when the user may not want this target. */
.reason { display: flex; align-items: flex-start; gap: 5px; margin-top: 4px; font: 400 11.5px/1.4 var(--stp-font); color: var(--stp-fg); overflow-wrap: anywhere; }
.reason > svg { flex: none; margin-top: 2px; color: var(--stp-fg-muted); }
.reason.attention, .reason.attention > svg { color: var(--stp-warn); }
.target-summary .reason, .target-summary .sub { margin-left: 20px; }
.target-summary code { font: 500 11.5px/1 var(--stp-mono); }
.target-summary .sub { display: block; margin-top: 3px; color: var(--stp-fg-muted); font-weight: 400; font-size: 11px; }

/* Host name. Weighted like a tag rather than prose, because with two Paseo
   machines paired it is the first thing to read on the line — it says which
   computer is about to run the agent — and it also has to survive being the
   left-hand prefix of every row in the Target list. */
.host {
  font: 600 11px/1 var(--stp-mono);
  letter-spacing: 0.01em;
  color: var(--stp-accent);
}

/* A host that did not answer, while another did. Warning, not danger: the
   composer still works, and the send the user came for is still available on
   the host that replied. */
.host-error {
  display: block;
  font: 400 11px/1.4 var(--stp-font);
  color: var(--stp-warn);
  padding: 5px 8px;
  border: 1px solid var(--stp-warn-border);
  border-radius: var(--stp-radius);
  background: var(--stp-warn-bg);
}
.host-error .host { color: inherit; }

/* Workspace for this PR (Follow-up). A compact list, not cards: up to three
   rows of name, Follow-up's one line and an Open link. The dot carries the
   same urgency as the line's colour so the list scans without reading. */
/* Follow-up's icon before the label: 14px inside the label's 15.6px line, so
   the heading keeps its height. In dark the tile (#222126) sits on a near
   equal surface, so a white hairline (invisible on light) keeps its edge. */
.field > span.owners-lbl { display: flex; align-items: center; gap: 6px; }
.fu-mark { flex: none; display: inline-flex; width: 14px; height: 14px; border-radius: 3px; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1); }
.fu-mark svg { display: block; width: 14px; height: 14px; }
.owner-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--stp-border); border-radius: var(--stp-radius); background: var(--stp-bg-subtle); }
.owner { display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px; }
.owner + .owner { border-top: 1px solid var(--stp-border); }
.owner-dot { flex: none; width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; background: var(--stp-border-strong); }
.owner-dot.warn { background: var(--stp-warn); }
.owner-dot.active { background: var(--stp-success); }
.owner-dot.danger { background: var(--stp-danger); }
.owner-text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.owner-line { font: 500 11.5px/1.4 var(--stp-font); overflow-wrap: anywhere; }
.owner-name { font: 600 12.5px/1.4 var(--stp-font); color: var(--stp-fg); overflow-wrap: anywhere; }
.owner-state { color: var(--stp-fg); }
.owner-state.warn { color: var(--stp-warn); }
.owner-state.danger { color: var(--stp-danger); }
.owner-agent { font-weight: 400; color: var(--stp-fg-muted); }
.btn.owner-open { flex: none; height: 26px; padding: 0 9px; gap: 5px; font-size: 12px; align-self: center; }
.owner-open svg { width: 12px; height: 12px; opacity: 0.8; }
.owners-empty { font: 400 12px/1.45 var(--stp-font); color: var(--stp-fg-muted); }
.owners-unreachable { font: 400 12px/1.45 var(--stp-font); color: var(--stp-fg-muted); }
.owners-unreachable.partial { font-size: 11px; line-height: 1.4; }
.owners-unreachable .linkish[disabled] { cursor: progress; opacity: 0.7; text-decoration: none; }
.owner-state.muted { color: var(--stp-fg-muted); font-weight: 400; }
.owners-rule { border: 0; border-top: 1px solid var(--stp-border); margin: 2px 0; }
.composer-lbl { font: 600 12px/1.3 var(--stp-font); color: var(--stp-fg); margin-bottom: -4px; }
.owners-foot { font: 400 11px/1.4 var(--stp-font); color: var(--stp-fg-muted); }
.linkish { font: inherit; color: var(--stp-fg-muted); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.linkish:hover { color: var(--stp-fg); }
.linkish:focus-visible, .btn.owner-open:focus-visible { outline: 2px solid var(--stp-accent); outline-offset: 1px; border-radius: 3px; }

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--stp-border);
  background: var(--stp-bg-subtle);
}

.kbd-hint { font: 400 11px/1 var(--stp-font); color: var(--stp-fg-muted); }
kbd {
  font: 500 10.5px/1 var(--stp-mono);
  border: 1px solid var(--stp-border-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 2px 4px;
  background: var(--stp-bg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
}

/* Symbol-only keycaps (⌘, ↵). At the mono 10.5px used for lettered keys these
   glyphs render visibly smaller and lighter than a word like "Esc" — the mono
   face draws them at a small optical size. Bumping the size and switching to the
   UI face evens the row out. Purely optical; the text is unchanged. */
kbd.sym {
  font-family: var(--stp-font);
  font-size: 13px;
  font-weight: 600;
  padding: 1px 4px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  font: 600 12.5px/1 var(--stp-font);
  border-radius: var(--stp-radius);
  border: 1px solid var(--stp-border);
  background: var(--stp-bg);
  color: var(--stp-fg);
  cursor: pointer;
}
.btn:hover { background: var(--stp-bg-hover); }
.btn.primary { background: var(--stp-accent); border-color: transparent; color: var(--stp-accent-fg); }
.btn.primary:hover { background: var(--stp-accent-hover); }
.btn[disabled] { opacity: 0.55; cursor: default; }
.btn:focus-visible { outline: 2px solid var(--stp-accent); outline-offset: 1px; }

.status { font: 400 12px/1.45 var(--stp-font); color: var(--stp-fg-muted); display: flex; align-items: center; gap: 6px; }

.spinner {
  width: 12px; height: 12px; flex: none;
  border: 2px solid var(--stp-border-strong);
  border-top-color: var(--stp-accent);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }

.error {
  border: 1px solid var(--stp-danger-border);
  background: var(--stp-danger-bg);
  border-radius: var(--stp-radius);
  padding: 9px 10px;
  display: grid;
  gap: 4px;
}
.error .etitle { font: 600 12.5px/1.35 var(--stp-font); color: var(--stp-danger); }
.error .emsg { font: 400 12px/1.45 var(--stp-font); color: var(--stp-fg); }
.error .ehint { font: 400 11.5px/1.45 var(--stp-font); color: var(--stp-fg-muted); }
.error .ehint code, .error .emsg code { font: 500 11.5px/1 var(--stp-mono); background: var(--stp-bg); padding: 1px 4px; border-radius: 3px; }
.error .copy-details {
  justify-self: start;
  display: inline-flex; align-items: center; gap: 4px;
  margin-top: 2px; padding: 2px 6px; border-radius: 4px;
  font: 500 11px/1.3 var(--stp-font); color: var(--stp-fg-muted);
  background: transparent; border: 1px solid transparent; cursor: pointer;
}
.error .copy-details:hover { color: var(--stp-fg); border-color: var(--stp-border); background: var(--stp-bg); }
.error .copy-details:focus-visible { outline: 2px solid var(--stp-accent); outline-offset: 1px; }
.error a.link { color: var(--stp-accent); font: 500 11.5px/1.4 var(--stp-font); cursor: pointer; text-decoration: underline; }

.success { display: grid; gap: 8px; padding: 4px 0 0; }
.success .stitle .badge {
  margin-left: 8px;
  font: 700 9.5px/1 var(--stp-font);
  letter-spacing: 0.08em;
  padding: 3px 5px;
  border-radius: 4px;
  background: var(--stp-warn-bg);
  border: 1px solid var(--stp-warn-border);
  color: var(--stp-warn);
  vertical-align: 1px;
}
.success.dry .stitle { color: var(--stp-warn); }
.success .dry-note {
  font: 400 11.5px/1.5 var(--stp-font);
  color: var(--stp-fg);
  background: var(--stp-warn-bg);
  border: 1px solid var(--stp-warn-border);
  border-radius: var(--stp-radius);
  padding: 8px 9px;
}
.success .dry-note code { font: 500 11px/1 var(--stp-mono); }
.success .stitle { font: 600 13.5px/1.35 var(--stp-font); color: var(--stp-success); display: flex; align-items: center; gap: 6px; }
.success .stitle svg { width: 15px; height: 15px; flex: none; }
.success .route { font: 500 12.5px/1.45 var(--stp-font); color: var(--stp-fg); overflow-wrap: anywhere; }
.success .reason { margin-top: -4px; }
.success .sdetail { font: 400 12px/1.5 var(--stp-font); color: var(--stp-fg-muted); overflow-wrap: anywhere; }
.success .sdetail code { font: 500 11.5px/1.3 var(--stp-mono); }
a.btn { text-decoration: none; }
.deep-link svg { width: 13px; height: 13px; flex: none; opacity: 0.85; }
.deep-link.muted { background: var(--stp-bg-hover); color: var(--stp-fg); border: 1px solid var(--stp-border-strong); }
.deep-link.muted:hover { background: var(--stp-bg-subtle); }

/* Footer variant whose buttons all sit on the right, secondary then primary. */
footer.actions { justify-content: flex-end; }

/* ---- setup card: first run, or a token Paseo no longer accepts ---------- */
.setup { display: grid; gap: 10px; padding: 2px 0; }
.setup-title { font: 600 13.5px/1.35 var(--stp-font); color: var(--stp-fg); }
.setup-why { margin: -4px 0 0; font: 400 12px/1.5 var(--stp-font); color: var(--stp-fg-muted); }
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; counter-reset: none; }
.steps li { display: grid; grid-template-columns: 20px 1fr; gap: 8px; align-items: start; font: 400 12.5px/1.45 var(--stp-font); color: var(--stp-fg); }
.steps .n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: -1px;
  border-radius: 50%;
  border: 1px solid var(--stp-border-strong);
  background: var(--stp-bg-subtle);
  color: var(--stp-fg-muted);
  font: 600 11px/1 var(--stp-font);
  font-variant-numeric: tabular-nums;
}

.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;
