---
name: Send to Paseo
description: Dispatch a PR to a Paseo agent from GitHub or Graphite; the agent's chat says where it landed and why.
colors:
  paseo-indigo: "#5b57e0"
  paseo-indigo-deep: "#4a46d4"
  on-indigo: "#ffffff"
  ink: "#16181d"
  ink-muted: "#676e79"
  paper: "#ffffff"
  paper-subtle: "#f6f7f9"
  paper-hover: "#eef0f3"
  hairline: "#d7dae0"
  hairline-strong: "#c2c7d0"
  failed-red: "#b42318"
  failed-red-wash: "#fef3f2"
  failed-red-edge: "#fbcfc9"
  done-green: "#0b7a4b"
  done-green-wash: "#eefaf3"
  done-green-edge: "#b8e6cd"
  needs-you-amber: "#92500e"
  needs-you-amber-wash: "#fff8eb"
  needs-you-amber-edge: "#f5dda6"
  dot-amber: "#b45309"
  dot-red: "#d1242f"
typography:
  lead:
    fontFamily: "host system sans"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "27px"
    fontFeature: "tnum"
  screen-title:
    fontFamily: "host system sans"
    fontSize: "24px"
    fontWeight: 600
  section-title:
    fontFamily: "host system sans"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "host system sans"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  body-sm:
    fontFamily: "host system sans"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  meta:
    fontFamily: "host system sans"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "17px"
    fontFeature: "tnum"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
  popover-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Inter, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
  popover-body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Inter, Roboto, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  popover-label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Inter, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  card: "12px"
  control: "8px"
  chip: "6px"
  web-control: "6px"
  web-card: "10px"
  keycap: "4px"
  pill: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  page: "32px"
components:
  paseo-button-primary:
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "32px"
  paseo-button-secondary:
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "32px"
  paseo-card:
    rounded: "{rounded.card}"
    padding: "16px"
  paseo-tool-row:
    rounded: "{rounded.control}"
    padding: "4px 8px"
  paseo-step-badge:
    rounded: "{rounded.pill}"
    size: "22px"
  github-button:
    rounded: "{rounded.web-control}"
    padding: "0 12px"
    height: "32px"
  graphite-button:
    textColor: "{colors.ink}"
    rounded: "{rounded.web-control}"
    padding: "0 10px"
    height: "28px"
  popover-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.web-card}"
    width: "392px"
  popover-button-primary:
    backgroundColor: "{colors.paseo-indigo}"
    textColor: "{colors.on-indigo}"
    rounded: "{rounded.web-control}"
    padding: "0 12px"
    height: "28px"
  popover-button-primary-hover:
    backgroundColor: "{colors.paseo-indigo-deep}"
  popover-button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.web-control}"
    padding: "0 12px"
    height: "28px"
  popover-error:
    backgroundColor: "{colors.failed-red-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.web-control}"
    padding: "9px 10px"
  options-button-primary:
    backgroundColor: "{colors.paseo-indigo}"
    textColor: "{colors.on-indigo}"
    rounded: "{rounded.web-control}"
    padding: "0 13px"
    height: "32px"
---

# Design System: Send to Paseo

## Overview

**Creative North Star: "The Dispatch Receipt"**

Two worlds, one product. Inside Paseo the plugin owns no colours: every value is a Paseo host theme token (`surface0/1/2`, `foreground`, `foregroundMuted`, `border`, `accent`, `accentForeground`, `statusSuccess/Warning/Danger`), shaped by the plugin family's helpers in `plugin/client/theme.ts` (`raised()`, `tint()`, `tabular`). On the PR page the extension borrows the host's button language (Primer tokens on GitHub, Graphite's action-row metrics) for the button, and paints its own quiet surface (the `--stp-*` palette in the frontmatter) for the popover and the options page.

Both ends read as a receipt: who sent it (repo #N, site), where it went (workspace, agent), and why it landed there (the route line). Density is calm and compact; one status sentence leads each screen; state is carried by small amber, red and green marks, never by the accent.

**Key Characteristics:**
- Host tokens only inside Paseo; host button tokens on GitHub; a self-contained light/dark palette only where the extension paints its own surface.
- Accent appears only on primary actions and switches.
- Amber = needs the person, red = failed or bridge down, green = done or sent.
- Raised cards (ring plus soft lift in light, 8% white ring in dark).
- Tabular numerals wherever counts, ages and PR numbers sit.
- One shared route sentence on the Paseo card and in the popover.

## Colors

Neutral grounds with one accent reserved for the action, and three status hues that each mean one thing.

### Primary
- **Paseo Accent** (Paseo host `accent` / `accentForeground`; in the extension, Paseo Indigo `paseo-indigo`, dark `#7d78ff`): the primary button ("Copy token", "Send", "Open in Paseo", "Test connection"), focus outlines, the options page's switches (`accent-color`), and Paseo's mark in the page button. Nothing else.

### Neutral
- **Ground and surfaces** (Paseo `surface0` page, `surface1` cards, `surface2` pressed/hover, inputs, secondary buttons; extension `paper`, `paper-subtle` for popover header/footer and options page ground, `paper-hover`).
- **Ink** (`foreground` / `ink`): titles, body, instruction text. **Muted ink** (`foregroundMuted` / `ink-muted`): facts strips, timestamps, route line at rest, secondary labels.
- **Hairlines** (`border` / `hairline`, `hairline-strong`): row dividers, card footers, secondary button strokes, inputs.

### Status
- **Needs-you Amber** (`statusWarning`; `needs-you-amber` with `-wash`/`-edge`): not paired yet, a merged or closed target branch, unattended permission modes, dry run, a host that did not answer while another did. Page-button dot uses `dot-amber` (Primer `--bgColor-attention-emphasis` on GitHub).
- **Failed Red** (`statusDanger`; `failed-red` with `-wash`/`-edge`): a failed send, the bridge not running, a rejected token, a required dependency missing. Page-button dot uses `dot-red` (Primer `--bgColor-danger-emphasis`).
- **Done Green** (`statusSuccess`; `done-green`): sent, agent started, bridge running, a completed setup step, dependency found. Primer `--fgColor-success` for the sent icon on GitHub.

### Named Rules
**The Accent Is a Verb Rule.** Accent fills or strokes only the primary action and on/off switches. Radios, selection rows and state never take it: radios are a neutral `foreground` ring and dot, selected rows are `surface2`.

**The Three Lights Rule.** Amber asks the person to do something; red says something broke; green says it went. "Not set up yet" is amber, never red. A status hue appears as text, an icon, a 7px dot, or a tint, never as a large fill.

**The Tint Rule.** A tag or badge fill is its own text hue at 12% alpha on light grounds and 16% on dark (`tint()`), e.g. the done step badge.

## Typography

**Body Font:** the host's system sans (Paseo's UI face; in the extension `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`; on GitHub the button uses Primer's `--fontStack-system`).
**Mono Font:** `ui-monospace, SFMono-Regular, Menlo, monospace` (Menlo on iOS, `monospace` on Android).

**Character:** One sans at a small, even ramp; weight 600 does all the emphasis. No display face.

### Hierarchy
- **Lead** (600, 20px / 27px; 18px / 24px compact): the one status sentence at the top of the Paseo screen.
- **Screen title** (600, 24px; 20px compact): settings screen title.
- **Section title** (600, 15-16px): "Recent sends", settings card headings, options `h2`.
- **Body** (400, 14px / 20px; 13px compact): step titles, instructions, the provenance card's instruction text (14px / 21px).
- **Body small** (400, 13px / 18px): PR titles, route line, step hints.
- **Meta** (400, 12px / 17px, tabular): facts strip, ages, muted labels, "Open PR".
- **Popover** (600 12px title and field labels, 400 12.5-13px body and inputs, 600 12.5px buttons, 600 13.5px result title).

### Named Rules
**The Tabular Rule.** Counts, ages, ports, versions and PR numbers use tabular numerals (`fontVariant: tabular-nums`; `font-variant-numeric: tabular-nums` on the options page and step badges).

**The Mono Means Exact Rule.** Mono is for strings the person might copy verbatim: branches (`head → base`), tokens and connection codes, shell commands, server ids, and the exact prompt the agent received. Repo names, PR references, titles and labels stay sans.

**The Sentence-Case Label Rule.** Field labels are sentence-case semibold, like Primer's and Graphite's form labels; no uppercase tracked labels.

## Layout

Paseo screen: one centred column, max 820px, padding 32px (16px compact), section gap 20px (16px compact); card padding 16px (12px compact), overview cards 18px (14px compact). At 390px the same order holds in one column; the facts strip joins with ", " instead of " · ", and the provenance card's site moves into the route line ("From Graphite · ..."). Provenance card: max 600px, right-aligned with user messages on wide layouts, stretched when compact. Recent-send rows: 12px vertical, 16px (12px compact) horizontal, hairline between rows.

Extension: popover card fixed 392px (capped at `100vw - 24px` and `100vh - 24px`, body scrolls); header and footer 10px 12px, body 12px with 10px gaps. Options page: one column, max 620px, 32px 20px padding, 18px between sections; below 440px padding drops to 20px 16px and the token input takes a full row.

## Elevation & Depth

Hybrid: rings, not drop shadows, inside Paseo; real lift only where the extension floats over a page.

### Shadow Vocabulary
- **Raised, light** (`box-shadow: 0 0 0 1px rgba(0,0,0,.07), 0 1px 2px -1px rgba(0,0,0,.06), 0 2px 6px 0 rgba(0,0,0,.04)`): every Paseo card (steps, recent sends, provenance, settings).
- **Raised, dark** (`box-shadow: 0 0 0 1px rgba(255,255,255,.08)`): the same cards on dark grounds.
- **Popover lift** (light `0 8px 28px rgba(16,18,23,.16), 0 1px 2px rgba(16,18,23,.08)`; dark `0 10px 34px rgba(0,0,0,.55), 0 1px 2px rgba(0,0,0,.4)`): popover card, target dropdown, floating fallback button.
- **GitHub button** (`0 1px 0 rgba(31,35,40,.04)` light, none dark): mirrors Primer's default button.

### Named Rules
**The Ring Not Border Rule.** Paseo cards carry no `borderWidth`; depth comes from `raised()` only. Hairline borders are for dividers, inputs and secondary buttons.

## Shapes

Gently rounded. Paseo: cards 12px, buttons, inputs, radios rows and tool rows 8px, small chips and "Clear"/"What the agent got" 6px, step badges and status dots fully round. Extension: controls 6px (GitHub's measured radius), popover and options sections 10px, host blocks 9px, keycaps 4px with a 2px bottom border.

## Components

### Buttons
- **Primary (Paseo):** `accent` fill and stroke, `accentForeground` 13px text (600 in the overview), 32px min height, 12px horizontal, 8px radius, optional 14px Lucide icon. Presses to `scale(0.97)`.
- **Secondary (Paseo):** `surface2` fill with `border` stroke, or transparent with `border` stroke, pressed `surface2`.
- **Popover / options:** 28px (popover) or 32px (options), 600 12.5px, 6px radius; primary `paseo-indigo` with `paseo-indigo-deep` hover; secondary `paper` with hairline, `paper-hover` on hover; disabled at 55% opacity; focus `2px solid` accent outline.

### Page button (signature, extension)
- **GitHub:** measured from the "Code" button: 32px high, 0 12px, 8px gap, 500 14px, 6px radius, colours from Primer `--button-default-*` tokens with measured fallbacks; 16px icon.
- **Graphite:** 28px, 0 10px, 500 12.5px, transparent fill (inherits Graphite's row), hairline stroke, neutral grey hover tint `rgba(127,133,145,.14)`; 14px icon.
- **States:** Paseo mark in accent at rest; muted spinner while sending; green check with a 180ms pop when sent; a 7px dot ringed in the button's surface for unpaired (amber) and failed (red). The label cell reserves "Send to Paseo" width so "Sent" never shifts the host row. Reduced motion slows the spinner to 2.4s and drops the pop.

### Cards / Containers
- **Corner Style:** 12px (Paseo), 10px (popover, options sections).
- **Background:** `surface1` / `paper`.
- **Shadow Strategy:** `raised()` in Paseo; popover lift in the extension.
- **Internal Padding:** 16px (12px compact); popover 12px.

### Provenance card (signature, Paseo chat)
Header: GitHub mark (or `GitPullRequest`) 14px, bold `owner/repo #N`, muted "· sent from Graphite", "Open PR" right. Route line: `Route` icon 13px, muted 13px, turning amber with `TriangleAlert` for a merged or closed target branch. PR title 13px, `head → base` in mono 12px. Hairline, then the instruction at 14px / 21px, selectable. A 6px-radius outlined "What the agent got" toggle reveals the exact prompt in mono, scroll-capped at 300px.

### Route line (shared wording)
The same phrases on the Paseo card and in the popover: "on the PR's branch", "on X, another branch of this stack", "on X, a merged branch of this stack" (amber), "on X, a closed branch of this stack" (amber), "New worktree for #N", joined with " · " to the workspace and "sent to this agent" / "new agent". Only the product's own leading phrase is capitalised; a workspace name is shown as Paseo shows it.

### Tool row (Paseo chat)
One quiet line sized like Paseo's own tool rows: 14px, tabular, 4px 8px padding, 22px icon slot with a 12px `Send` icon, muted at rest, `foreground` when hovered or running (72% opacity while running). Hover swaps the icon for a chevron; expanding attaches a hairline-bordered mono detail panel (max 240px). Warning/danger tone colours the line and uses `TriangleAlert`.

### Inputs / Fields
- **Paseo:** `surface2` fill, hairline, 8px radius, 8px 10px padding, 14px (13px compact).
- **Extension:** `paper` fill, hairline, 6px radius; 30px selects and combobox (popover), 32px inputs (options, token input in mono). Focus: 2px accent outline at -1px offset and accent border.

### Radios and selection (Paseo settings)
16px ring, 1.5px `foregroundMuted` stroke; on: `foreground` ring with an 8px `foreground` dot. Selected row: `surface2`, 8px radius.

### Steps
Numbered 1-2-3 first-run steps on both ends. Paseo: 22px round badge, `surface2` with a 600 12px tabular numeral; done becomes a `tint(statusSuccess)` badge with a green check. Extension: 20px round badge, `paper-subtle` with hairline-strong ring, 600 11px tabular numeral.

### Status blocks (extension)
Wash fill plus edge stroke in the state's hue, 6px (popover) or 8px (options) radius, title in the state hue at 600, body in ink, hints muted. Used for errors, setup, dry run and connection results.

### Navigation
The sidebar row is Paseo's own `SidebarRow` with the `Send` icon; it stays quiet unless something needs the person, then shows a 7px dot (amber: not paired; red: bridge down or last send failed). No tab bar duplicating the host header.

## Do's and Don'ts

### Do:
- **Do** take every Paseo colour from host theme tokens and derive alphas through `raised()` and `tint()` (12% light / 16% dark).
- **Do** keep the accent on primary buttons and switches only; use neutral radios and `surface2` selection.
- **Do** use amber for "needs the person", red for failed or bridge down, green for done or sent.
- **Do** lead each screen with one status sentence that says whether sending works and what is next.
- **Do** reuse the shared route wording verbatim on both ends.
- **Do** read GitHub's Primer tokens for anything drawn into GitHub's action row, with measured fallbacks.
- **Do** honour reduced motion: spinners slow to 2.4s, the sent pop and hover transitions are dropped.

### Don't:
- **Don't** use the accent as a state colour, a label colour or a selection mark.
- **Don't** show "not set up yet" in red.
- **Don't** put drop shadows or borders on Paseo cards; use the `raised()` ring.
- **Don't** set repo names, PR references or host names in mono.
- **Don't** use uppercase tracked labels or eyebrows above titles.
- **Don't** show the bracketed raw prompt header or raw error codes as visible copy.
