# Send to Paseo — plan

Ship a "Send to Paseo" button on Graphite PR pages. Click it, type an instruction
("Fix merge conflicts"), and a **new** Paseo agent starts in the workspace that belongs to
that PR's branch — creating a worktree workspace for the PR if none exists.

Two deliverables:

- **A. Paseo plugin `send-to-paseo`** — a local HTTP bridge on the daemon machine plus a
  settings/status surface inside Paseo.
- **B. Chrome extension (MV3)** — the button, the composer popover, and pairing.

The extension never talks to the Paseo daemon directly. It talks only to the plugin's bridge.

---

## 1. What I verified

Everything below was checked against the live machine and the live Graphite app, not assumed.

### Paseo can already do the hard part

`paseo run` and `paseo workspace create` natively support checking out a PR into a managed
worktree:

```
--new-workspace worktree --worktree-mode checkout-pr --pr-number 942 --forge github
```

The same shape exists in the SDK (`CreatePaseoWorktreeInput` picks `checkoutSource`,
`githubPrNumber`, `action`, `refName`). So "make me a workspace for PR #942" is one call, not a
git script. Confirmed in `paseo workspace create --help` and
`@getpaseo/client/dist/daemon-client.d.ts:171`.

### The mapping from Graphite to Paseo is a string match

| Graphite | Paseo |
| --- | --- |
| URL `…/github/pr/acmegizmos/gizmo-poc/942/…` | project `remote:github.com/acmegizmos/gizmo-poc` |
| PR head branch `giz-1133-widget-backed-inventory-audit-rule` | workspace whose `git rev-parse --abbrev-ref HEAD` equals it |

Verified: `paseo project ls --json` returns `remote:github.com/acmegizmos/gizmo-poc`, and the
managed worktrees under `~/.paseo/worktrees/pj4k2wxb/` do carry real branches
(`giz-1011-data-migrations-framework-hardening`, etc.). Workspace→branch is a `git -C <cwd>`
call away; `paseo workspace ls --json` gives us every `cwd`.

`gh pr view 942 --repo acmegizmos/gizmo-poc --json headRefName` resolves PR→branch correctly.
**Caveat:** `gh` may be a shell *function* rather than a binary (on this machine a zsh function
swaps tokens for some owners). The plugin must `execFile` the real binary, never go through a
shell, so any such function is bypassed — which is fine, because for `acmegizmos/*` the function
falls through to plain `gh` anyway.

### The extension cannot talk to the daemon directly — this is the load-bearing finding

The daemon's whole API is a private WebSocket protocol at `ws://127.0.0.1:6767/ws`. Its HTTP
surface is only `/api/health` and `/api/status`; there is no REST API for agents or workspaces
(I probed 14 candidate paths, all 404). And the WebSocket enforces an Origin allowlist:

```
$ curl -H "Origin: https://app.graphite.com" …/ws
HTTP/1.1 403 Forbidden
Origin not allowed
```

`daemon.cors.allowedOrigins` in `~/.paseo/config.json` is currently `["https://app.paseo.sh"]`.

So the two no-plugin options are both bad: edit your daemon config *and* reimplement an
undocumented, unversioned wire protocol inside a Chrome extension. **A plugin bridge is the
right call** — plugin backend code is full Node, so it can run its own HTTP server with its own
tiny versioned API, and reach Paseo through the supported SDK.

`pluginsEnabled` is already `true`, so no config changes and no permission gate are needed.

### Graphite's DOM is hostile to scraping — so we barely scrape it

Graphite is Next.js App Router + MobX with **CSS-module hashed class names**
(`BranchPair_gds-branch-name__ZuvL7`). Those hashes rotate on every Graphite deploy. There are
only four `data-testid` values on the whole page and none are useful. There is no
`__NEXT_DATA__`; state lives in RSC flight payloads (`__next_f`) — an internal format I won't
depend on.

Two things save us:

1. **All the data we need is in the URL**: `/github/pr/{owner}/{repo}/{number}/{slug}`. No
   scraping for identity at all.
2. **Stack sibling PRs are in link `href`s**, not class names — `a[href^="/github/pr/{owner}/{repo}/"]`.
   Structural selectors don't rotate. This is the one safe scrape.

For *placement* only, `[class*="PullRequestPageHeader_prPageHeader"]` matched exactly once and is
the row holding "Review Changes" / "Not Ready to Merge" / "Agent". Attribute-*contains* matching
survives hash rotation because the hash is a suffix.

Also confirmed: **`graphite.dev` is now `graphite.com`** — the extension must match both hosts.

### Free win: the Paseo desktop app registers the `paseo` URL scheme

`/Applications/Paseo.app/Contents/Info.plist` declares `CFBundleURLSchemes: [paseo]`
("Paseo agent link"). After a successful send we can hand back a deep link that jumps straight
into the new agent in the desktop app.

---

## 2. Decisions locked in

- **No workspace match → show a picker and confirm.** The popover states the resolved target
  and lets you pick something else before sending. Never silently creates a worktree.
- **Always start a new agent.** Every send is a fresh agent with clean context.
- **Provider/model: default in plugin settings, per-send override in the popover.**

---

## 3. Component A — the Paseo plugin

Following the file-suffix convention already established in an earlier Paseo plugin of ours
(`*.client.tsx` / `*.server.ts` / `*.shared.ts`), because Paseo bundles those runtimes
differently.

```
send-to-paseo-plugin/
  paseo-plugin.json          { "id": "send-to-paseo" }
  index.ts                   contribution wiring only
  bridge.server.ts           the HTTP server
  resolve.server.ts          PR → project → workspace resolution
  send.server.ts             workspace ensure + agent create
  gh.server.ts               execFile wrapper around the gh binary
  git.server.ts              branch reads, cached
  settings.server.ts         token + config at $PASEO_HOME/plugin-data/send-to-paseo/
  contracts.shared.ts        Zod contracts (RPC + HTTP payloads share them)
  lifecycle.shared.ts        teardown handoff (see the bundling trap below)
  settings.client.tsx        the Paseo surface: status, token, defaults, recent sends
```

### The HTTP bridge

Bound to `127.0.0.1` only, default port `7788` (configurable). Endpoints, all versioned:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/ping` | health + version + daemon reachability. Used by the options page's "Test connection". |
| `POST /v1/resolve` | `{forge, owner, repo, number, stackPrNumbers[]}` → PR metadata + ranked workspace candidates + provider list + defaults. Drives the popover before you type. |
| `POST /v1/send` | `{…prRef, prompt, target, provider?}` → creates the workspace if asked, creates the agent, returns `{agentId, workspaceId, deepLink, workspaceCreated}`. |

`/v1/resolve` existing as a separate call is what makes the confirm-picker UX feel instant: the
popover fetches candidates the moment it opens, while you're still typing.

### The resolution ladder (`resolve.server.ts`)

1. `owner/repo` → `remote:github.com/{owner}/{repo}`. Verify against `paseo.projects.list()`;
   fall back to matching a project whose `origin` remote URL parses to the same `owner/repo`
   (covers SSH remotes and renamed repos).
2. PR number → head branch, via `gh pr view --json headRefName,title,state,baseRefName`.
   Fallback to the GitHub REST API using `gh auth token` if the CLI is missing.
3. Resolve `stackPrNumbers` → their branches, batched, best-effort (a slow or failed lookup
   degrades rank 2 to nothing; it never blocks a send).
4. List that project's workspaces, read each branch with `git -C <cwd> rev-parse --abbrev-ref HEAD`.
   Cache keyed on `cwd` + mtime of `.git/HEAD` so repeated opens are free.
5. Rank candidates:
   - **rank 1** — branch equals the PR head branch → "the" workspace for this PR
   - **rank 2** — branch is another branch in the same Graphite stack → labelled `stack: #948`
   - **rank 3** — any other workspace in the project
   - **synthetic** — `Create worktree for PR #942` (`checkout-pr` mode)
6. The default selection is rank 1 if present, otherwise the synthetic create option. The
   popover shows that default and every alternative.

### Sending (`send.server.ts`)

Ensure the workspace (existing, or create via `checkout-pr`), then
`paseo.agents.create({ cwd, prompt, title, config: { provider }, labels })` with:

- `title`: `PR #942 · Fix merge conflicts` — scannable in Paseo's agent list
- `labels`: `{ "send-to-paseo/pr": "github:acmegizmos/gizmo-poc#942", "send-to-paseo/origin": "graphite" }`

Labels cost nothing now and are surfaced on `PluginAgentSnapshot.labels`, so a future "show me
every agent for this PR" or an opt-in reuse mode needs no migration.

The prompt sent to the agent is your text plus a short header giving the agent the PR URL, number,
branch and title — so "Fix merge conflicts" is actionable without the agent having to guess what
it's working on.

### The Paseo surface (`settings.client.tsx`)

A sidebar item, so all configuration lives in Paseo rather than a JSON file you have to find:

- Bridge status: running/failed, port, last request time
- The pairing token: reveal, copy, regenerate
- Default provider/model picker, populated from `paseo.providers`
- Recent sends: PR, workspace, agent, outcome — with tap-through to the agent

---

## 4. Component B — the Chrome extension (MV3)

```
extension/
  manifest.json
  src/content/index.ts        injection + SPA lifecycle
  src/content/popover.ts      shadow-DOM composer
  src/content/adapters/
    types.ts                  SiteAdapter interface
    graphite.ts               Graphite adapter
    github.ts                 (phase 5)
  src/background/index.ts     service worker; owns the token, does all fetches
  src/options/                bridge URL, token, default provider, test connection
```

`host_permissions: ["http://127.0.0.1:7788/*"]`; content script matches
`https://app.graphite.com/github/pr/*` and `https://app.graphite.dev/github/pr/*`.

### The `SiteAdapter` seam — how GitHub comes for cheap later

Everything site-specific hides behind one interface:

```ts
interface SiteAdapter {
  matches(url: URL): boolean;
  parse(url: URL): PrRef | null;          // owner, repo, number, forge — from the URL
  findStackPrNumbers(): number[];         // structural href scrape; [] is fine
  findAnchor(): { el: Element; mode: "append" | "before" } | null;
  styleHint(): "graphite" | "github";
}
```

The injection loop, popover, messaging and error handling are all shared. The GitHub PR page
becomes a new `parse()` (`/{owner}/{repo}/pull/{n}`) and a new `findAnchor()` — GitHub actually
*has* stable `data-testid`s, so it'll be the easier of the two. Building this seam now is the
difference between "add GitHub in an afternoon" and "rewrite the content script".

### Surviving Graphite's SPA and its rotating class names

- **Anchor ladder**, tried in order: `[class*="PullRequestPageHeader_prPageHeader"]` action row →
  `[class*="MetadataSection_prInfoGroup"]` → a fixed-position fallback button. The button always
  appears, even if Graphite restructures its header.
- **Re-injection** on client-side navigation: patch `history.pushState`/`replaceState`, listen to
  `popstate`, and keep a debounced `MutationObserver` on `[data-testid="graphite-app-wrapper"]`
  (the one genuinely stable test ID). Injection is idempotent — guarded on a marker attribute —
  so a noisy observer is harmless.
- **Style isolation** via **Shadow DOM** for the button and popover. Graphite's CSS can't leak in;
  ours can't leak out. Non-negotiable on a page whose class names we don't control.

### The popover

Opens on click, anchored to the button:

- one-line target summary from `/v1/resolve` — *"→ workspace `brawny-dodo` (giz-1133-…)"* or
  *"→ will create worktree for PR #942"*, with a dropdown to pick any other candidate
- the instruction textarea, autofocused; ⌘↵ sends, Esc closes
- provider dropdown, pre-set to your default
- on send: inline spinner, then a success state with an "Open in Paseo" `paseo://` deep link

Errors surface in the popover with the actual reason (bridge unreachable, not paired, `gh` not
authenticated, project not registered in Paseo) and a concrete next step — never a bare "failed".

### Why the token lives in the service worker, not the content script

Content scripts share the page's world closely enough that I don't want a daemon-controlling
credential anywhere near Graphite's JS. So: the content script posts an intent via
`chrome.runtime.sendMessage`, and the **service worker** holds the token in `chrome.storage` and
performs every `fetch`. The page never sees the token, and the bridge only ever accepts requests
from an extension origin.

---

## 5. Security model

The bridge can start agents that run code on your machine, so it gets treated as a real
privilege boundary, not a convenience:

1. **Bind `127.0.0.1` only.** Never `0.0.0.0`.
2. **Bearer token required** on every endpoint except `/v1/ping`. Generated on first run
   (32 random bytes), stored `0600` under `$PASEO_HOME/plugin-data/send-to-paseo/`, rotatable
   from the Paseo surface.
3. **Reject web-page origins outright.** If an `Origin` header is present and is not
   `chrome-extension://…`, reject at preflight *and* on the real request. This matters: CORS only
   stops a page *reading* a response, not the request firing. Requiring an `Authorization` header
   forces a preflight, and failing that preflight means a malicious page's request never executes
   the side effect. Optionally pin specific extension IDs in settings.
4. **Check the `Host` header** is `127.0.0.1:<port>` or `localhost:<port>`, which closes off
   DNS-rebinding from a hostile page.
5. Body size cap, per-origin rate limit, no secrets in logs (following the same convention as
   that earlier plugin), `Vary: Origin` on every response.

---

## 6. Failure modes I already know about

- **Plugin reload hangs.** Notes from that earlier plugin record exactly this: a long-lived socket kept
  the subprocess event loop alive and wedged Paseo's "Stopping plugin" step. A listening HTTP
  server does the same, harder. Cleanup must `server.close()` **and**
  `server.closeAllConnections()` (keep-alive sockets will otherwise hold it open), then await
  the close.
- **The client-bundle import trap.** Paseo strips `*.server.ts` imports from the client bundle but
  keeps the surrounding code — so naming a server identifier inside the cleanup returned from
  `index.ts` breaks *every* contribution. The earlier plugin solves this with a `lifecycle.shared.ts`
  handoff object; I'll use the same pattern rather than rediscovering it.
- **Port already in use.** Fail loudly into the surface's status line and `paseo plugin logs`,
  not silently.
- **Graphite deploy rotates class hashes.** Anchor ladder + floating fallback; no data ever comes
  from a class-selected node.
- **Graphite renames a route.** URL parsing is one regex in one adapter.
- **`gh` unauthenticated / private repo.** Detected in `/v1/resolve` and reported as a specific,
  fixable error before you've typed a prompt.
- **Repo not registered as a Paseo project.** Same — reported by `/v1/resolve` with the repo name.

---

## 7. Phasing

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 1 | Plugin skeleton + bridge + `/v1/ping` | `paseo plugin ls` shows `running`; reload doesn't hang |
| 2 | `/v1/resolve` + `/v1/send` | `curl` starts a real agent on PR #942 and on a PR with no workspace |
| 3 | Extension: manifest, service worker, options, pairing | "Test connection" green |
| 4 | Button injection + popover, end to end | Click → type → agent appears in Paseo; survives SPA nav between PRs |
| 5 | Plugin surface polish: defaults, token rotation, recent sends | Configurable entirely from Paseo |
| 6 | *(later)* GitHub adapter | Same flow on `github.com/{owner}/{repo}/pull/{n}` |

Each phase is verified with `npm run typecheck`, `paseo plugin reload send-to-paseo`,
`paseo plugin ls` (must be `running`), and `paseo plugin logs`. UI work gets checked in a wide
window and a compact one, in both light and dark themes, with all text coming from
`theme.colors`.

---

## 8. Open questions — none blocking

1. **Bridge port.** Defaulting to `7788`. Say so if you'd rather it were something else.
2. **Stack-wide sends.** Today a send targets one PR's branch. "Rebase the whole stack" would
   want a stack-level target. The rank-2 candidates already expose the stack, so this is an
   additive change to the picker later.
3. **Publishing.** Plan assumes an unpacked dev extension (stable ID per directory on your
   machine). If you later want it on the Chrome Web Store, we'd pin the extension ID via a
   manifest `key` so pairing survives.
