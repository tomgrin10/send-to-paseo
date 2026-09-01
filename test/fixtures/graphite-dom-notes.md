# Captured Graphite DOM structure

Captured 2026-09-01 from the live app at
`https://app.graphite.com/github/pr/acmegizmos/gizmo-poc/942/GIZ-1133-...`

**Everything with a `__XXXXX` suffix is a rotating CSS-module hash. Never match on the full
class name — always use `[class*="Prefix_name"]` (attribute-contains), because the hash is a
suffix.** The fixtures must include a "hash-rotated" variant to prove the selectors survive a
Graphite deploy.

## Stable anchors (verified, each matched exactly once)

| Selector | What it is |
| --- | --- |
| `[data-testid="graphite-app-wrapper"]` | app root. The only genuinely stable test ID. Observe this. |
| `[class*="PullRequestPageHeader_prPageHeader"]` | sticky PR header. Has `data-scrolled="false"`. |
| `[class*="MetadataSection_metadataSection"]` | metadata block (branch pair, file counts) |
| `[class*="MetadataSection_prInfoGroup"]` | inner row of the metadata block |

## Header action row — primary injection target

Inside `PullRequestPageHeader_prPageHeader__NRgNb`, the right-hand button row is:

```html
<div class="utilities_flexShrink0__bTHA_ utilities_flexAlignCenter__YBoRN styles_gap__s__zuWdb">
  <button class="Button_gdsButton__SadwL Button_gdsIconButton__wdKAF" ...>…</button>
  <button class="Button_gdsButton__SadwL ReviewChangesAction_reviewChangesAction__jRuEO">
    <span class="Button_gdsButtonContents__5B2fy"><span class="Button_gdsButtonText__5kyh_"><span>Review Changes</span></span></span>
  </button>
  <button class="Button_gdsButton__SadwL" data-kind="emphasis" data-priority="primary">… Not Ready to Merge …</button>
  <hr role="separator" aria-orientation="vertical" class="Separator_gdsSeparator__1GQ43">
  <button aria-label="Open comments sidebar (0 unresolved threads)" class="Button_gdsButton__SadwL">…</button>
  <div class="SplitButton_splitButton__BmDKa AgentChatSidebarSelector_splitButton___pVbq utilities_flex__w_5SS">
    <button class="Button_gdsButton__SadwL utilities_flex1__pd1WH SplitButton_mainAction__OKuY5">Agent</button>
    …
  </div>
</div>
```

Best way to find this row without depending on `utilities_*` hashes: locate
`[class*="PullRequestPageHeader_prPageHeader"]`, then find the button whose text is
`Review Changes` (or the `[class*="ReviewChangesAction_"]` element) and use its `parentElement`.
Insert our button **before** the `Review Changes` button so it sits left of Graphite's own actions.

Graphite's buttons carry `data-kind` / `data-priority` / `data-size` attributes — useful for
visually matching their design language.

## Branch name (informational only — never the source of truth)

```html
<div class="BranchPair_gds-branch-pair__CBYwJ MetadataSection_branchMetadata__ffkUY utilities_flexGrow1__SIc3P">
  <button class="BranchPair_gds-branch-name__ZuvL7 utilities_textCode__NwGum BranchMetadata_sourceBranchMenu__kq4Bg">
    giz-1133-widget-backed-inventory-audit-rule
  </button>
  →
  <button aria-label="Base branch graphite-base/942, open actions"
          class="BranchPair_gds-branch-name__ZuvL7 utilities_textCode__NwGum BranchSelector_branch...">
    graphite-base/942
  </button>
</div>
```

The plugin resolves the branch authoritatively via `gh`, so the extension must **not** need this.

## Stack sibling PRs — the one safe scrape

Structural `href` matching, immune to hash rotation:

```
a[href^="/github/pr/{owner}/{repo}/"]
```

Captured hrefs on PR #942 (note: **includes #942 itself — filter the current PR out**):

```
/github/pr/acmegizmos/gizmo-poc/949/GIZ-1136-...
/github/pr/acmegizmos/gizmo-poc/948/GIZ-1132-...
/github/pr/acmegizmos/gizmo-poc/947/GIZ-1132-...
/github/pr/acmegizmos/gizmo-poc/946/GIZ-1132-...
/github/pr/acmegizmos/gizmo-poc/945/GIZ-1132-...
/github/pr/acmegizmos/gizmo-poc/943/GIZ-1133-...
/github/pr/acmegizmos/gizmo-poc/942/GIZ-1133-...   <-- self, exclude
/github/pr/acmegizmos/gizmo-poc/941/GIZ-1132-...
```

Note the stack panel said "3 of 9 (1 hidden)" — the scrape is inherently best-effort and may
miss collapsed entries. That is acceptable: stack PRs only affect rank-2 candidate labelling.

## Environment facts

- Next.js App Router + MobX. **No `__NEXT_DATA__`**; state is in RSC flight payloads (`__next_f`).
  Do not depend on it.
- Only four `data-testid` values exist on the page: `graphite-app-wrapper`, `gds-avatar`,
  `code-diff-window`, `first-draft-toggle`.
- `graphite.dev` now redirects to `graphite.com`. Match **both** hosts.
- URL shape: `/github/pr/{owner}/{repo}/{number}/{slug}` — the sole source of PR identity.
- Client-side routing between PRs does not reload the page.
