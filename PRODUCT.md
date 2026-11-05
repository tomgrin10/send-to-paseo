# Send to Paseo

<!-- impeccable:product-schema 1 -->

> Written during the November 2026 UI polish pass without a live interview. Facts come from the
> README, AGENTS.md, PLAN.md, CONTRACT.md, the code and the owner's written brief; lines marked
> _(inferred)_ are assumptions to confirm.

## Platform

adaptive

## Users

Developers who review and land pull requests on GitHub or Graphite and run their coding agents in
Paseo. They are reading a PR in Chrome and want an agent to act on it (fix a review comment, chase
a flaky test, finish a stacked branch) without switching to Paseo, finding the right worktree, and
pasting context. _(inferred)_ Most have one machine; some run Paseo on a laptop plus a dev VM.

## Product Purpose

Start or message the right Paseo agent from the PR page in one step: the extension adds a
**Send to Paseo** button on the PR, the plugin's local bridge picks the workspace (exact branch,
same stack, or a new worktree for the PR) and the agent (new, main, or the one Follow Up
registered), and the agent gets the PR context plus the instruction. Success: a first send within
minutes of installing both halves, and every later send landing where the user expected.

## Positioning

The only Paseo integration that routes from the browser: it knows Graphite stacks, reuses the
workspace a stack already lives in, and keeps the daemon credential out of the page. _(inferred)_

## Operating Context

- Two halves: a Chrome MV3 extension (button + popover on github.com and graphite.com PR pages,
  options page for pairing) and a trusted Paseo plugin running an HTTP bridge on 127.0.0.1:7788.
- Pairing: one token copied from the plugin into the extension once. Additional machines are
  reached through the Primary plugin with `stp1_…` connection codes over Tailscale Serve.
- Inside Paseo: an overview screen (connection, token, defaults, machines, recent sends,
  dependencies), Display settings, ⌘K, and the agent tool `send_to_paseo_bridge_status`.
- Optional Follow Up integration reuses the pairing.

## Capabilities and Constraints

- CONTRACT.md is the frozen wire contract between the halves; only additive optional fields
  without a `contract` bump. Older extensions must keep working with a newer plugin and vice versa.
- The bearer token lives only in the service worker; button and popover render in a shadow root
  with `containKeyboard()`; site logic stays behind `SiteAdapter`.
- The bridge binds loopback only, checks Origin and Host, caps body and rate.
- Paseo ≥ 0.14; the plugin adds no runtime dependencies.
- PRIVACY.md must stay true: no analytics, requests go only to configured bridges.

## Brand Commitments

Part of Tom Gringauz's Paseo plugin family (Follow-up, Defer, Smart Session, Transcript Search,
Transfer, Vitals, Switcher): native to Paseo, host theme tokens only, the shared slate icon tile,
plain short copy, accent only for primary actions and switches. On GitHub and Graphite the button
must look like the host page's own buttons (Primer tokens on GitHub). The extension uses Paseo's
brand mark.

## Evidence on Hand

Chrome Web Store listing (1 install at the time of this pass), npm package `send-to-paseo` 2.2.0,
committed screenshots in docs/screenshots and docs/chrome-web-store, fixture PR pages in
test/fixtures. No testimonials or usage numbers beyond that; do not invent any.

## Product Principles

1. The send lands where the user expected, and the product says why it landed there.
2. Pairing and first send are the product's front door: every state names the next step.
3. Look native on each host: GitHub in GitHub, Graphite in Graphite, Paseo in Paseo.
4. Credentials never reach a page; failures name cause and fix.

## Accessibility & Inclusion

Keyboard-complete popover (existing e2e cases 19, 28–32), WCAG AA contrast in light and dark on
both sites, reduced motion respected.
