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
  font: 500 13px/1 var(--stp-font);
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

svg { width: 14px; height: 14px; flex: none; color: var(--stp-accent); }

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
:host([data-stp-style="github"]) svg { width: 16px; height: 16px; }
`;

/** The composer popover. Lives in its own shadow root attached to <body>. */
export const POPOVER_CSS = `
${TOKENS}

:host {
  position: fixed;
  z-index: 2147483001;
  font-family: var(--stp-font);
}

.card {
  width: 392px;
  max-width: calc(100vw - 24px);
  background: var(--stp-bg);
  color: var(--stp-fg);
  border: 1px solid var(--stp-border);
  border-radius: 10px;
  box-shadow: var(--stp-shadow);
  overflow: hidden;
}

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
.pr { font: 500 11px/1.3 var(--stp-mono); color: var(--stp-fg-muted); }

.body { padding: 12px; display: grid; gap: 10px; }

label.field { display: grid; gap: 4px; }
label.field > span.lbl {
  font: 600 10px/1 var(--stp-font);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--stp-fg-muted);
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

.target-summary {
  font: 500 12px/1.45 var(--stp-font);
  padding: 7px 9px;
  border: 1px solid var(--stp-border);
  border-radius: var(--stp-radius);
  background: var(--stp-bg-subtle);
}
.target-summary .arrow { color: var(--stp-accent); font-weight: 700; }
.target-summary code { font: 500 11.5px/1 var(--stp-mono); }
.target-summary .sub { display: block; margin-top: 3px; color: var(--stp-fg-muted); font-weight: 400; font-size: 11px; }
.target-summary .mismatch { display: block; margin-top: 3px; color: var(--stp-warn); font-weight: 400; font-size: 11px; }

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
.error .ecode { font: 500 10px/1 var(--stp-mono); color: var(--stp-fg-muted); }
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
.deep-link.muted { background: var(--stp-bg-hover); color: var(--stp-fg); border: 1px solid var(--stp-border-strong); }
.deep-link.muted:hover { background: var(--stp-bg-subtle); }
.success .stitle { font: 600 13px/1.35 var(--stp-font); color: var(--stp-success); display: flex; align-items: center; gap: 6px; }
.success .sdetail { font: 400 12px/1.5 var(--stp-font); color: var(--stp-fg-muted); }
.success .sdetail code { font: 500 11.5px/1 var(--stp-mono); }
.deep-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--stp-radius);
  background: var(--stp-accent);
  color: var(--stp-accent-fg);
  font: 600 12.5px/1 var(--stp-font);
  text-decoration: none;
  width: fit-content;
}
.deep-link:hover { background: var(--stp-accent-hover); }
.deep-link-raw { font: 400 10.5px/1.4 var(--stp-mono); color: var(--stp-fg-muted); word-break: break-all; }

.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;
