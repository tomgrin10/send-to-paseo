# Follow Up integration

Automatic browser connection requires Send to Paseo plugin/extension 2.2+ and Follow Up 0.3.4+. PR routing remains compatible with 2.1+/0.3+. All components also work
independently. Neither plugin installs or enables the other. The installation id of Follow Up
remains `follow-through`.

## PR destination

Follow Up records the agent on each explicit `follow.register-pr`. Re-registering updates that
agent. Existing records without that metadata retain their original workspace main agent. History
references alone never establish ownership. `follow.pr-owner` returns only `{ owner: { workspaceId,
agentId } | null }` for an exact repository and PR number. Inactive, archived, duplicate, missing
and moved-agent claims do not resolve. Repository comparison is case insensitive.

Send queries this narrow read-only RPC on the destination daemon. The optional `followUpAgent`
preview keeps the existing `mainAgent` root heuristic intact. The updated extension prefers the
registered workspace across machine routes and labels its agent explicitly. Choosing a new agent
still creates one. `followUpAgentId` opts a send into the registration; the plugin validates it
again against the current project, workspace and live agent and steers that exact agent. A stale
preview fails without sending to someone else. A fresh `capabilities.followUpRouting` ping at each
hop prevents a downgraded bridge from stripping the optional binding and dispatching elsewhere. Older or unavailable companions leave standalone
matching usable; a send already bound to a registration fails until refreshed.

## Open workspace from the popover

With Follow Up browser access on, each resolve asks its machine's Follow-up for
`follow.pr-workspaces`: the tracked workspaces that registered this PR, each with its title, main
agent id and status, and Follow-up's one-line state from the same model as Home. The bridge adds
the machine's `paseo://` agent link and the matching `app.paseo.sh` link; the popover lists up to
three owners above the composer with an **Open** link each. The desktop app is the default; the
footer switches every link to the web app and the choice is stored in the extension. Paseo 0.15.2
registers only agent deep links, and both the desktop app and the web app resolve an agent link to
its workspace, so Open lands in the workspace with its main agent selected.

The RPC returns nothing for repositories outside Follow-up's advertised scope, and the extension
does not ask while browser access is off. No messages, paths, branches, PR content or credentials
cross it.

## Browser authority

Follow Up uses the existing Send to Paseo pairing, Primary and Additional machine routes, token,
and Chrome origin permission. No separate machine finder, repository form or pairing is needed.
The extension discovers companions automatically on opening settings or Graphite. Each companion
advertises at most 100 repository identities from its active tracked PRs; the extension echoes
those exact scopes on later polls. Pairing now permits reading Merge when ready for those tracked
repositories while Graphite is open and signed in. **Use Graphite with Follow Up** turns browser
access off without removing Send pairing or changing either plugin's tracking settings.

Toggle changes still require explicit confirmation in the extension. That confirmation optionally
remembers permission for future changes for the exact machine, daemon identity and repository.
**Require confirmation** revokes that remembered permission. Existing explicit repository grants
are preserved. Automatic discovery and reading never grant direct toggle authority. A trusted
machine with a remembered direct grant can issue toggle commands for that repository; a
compromised machine has the same granted authority.

Grants bind the stored browser connection, its origin and pairing-token fingerprint, the exact
route, daemon server id and repository. Re-pairing the browser, changing its bridge, changing the server id,
disabling a host, or revoking a grant prevents subsequent execution. A changed machine identity
must be rediscovered before granting it. Proxying through a Primary retains the Additional
machine's route, server id, repository scopes and receipts; it does not grant transitive access.

The existing authenticated, bounded HTTP bridge exposes a separate `POST /follow-up/v1/exchange`
addon. It retains the loopback bind, Host/Origin guards, token checks, rate limit, body cap and
no-redirect transport. The extension advertises repository scopes independently per route. Only
one route receives a lease slot per poll, fairly rotated; `?local=1` prevents recursive proxying.
A missing companion returns an unavailable route, without affecting Send endpoints.

The worker accepts companion ports only from this extension's top-level HTTPS Graphite content
script. Only the extension's own options page can grant, revoke or confirm browser actions.
Chrome storage excludes content scripts. Bearer tokens stay in trusted extension contexts, and
Graphite cookies remain in Chrome. Commands contain no executable code, arbitrary URL, header,
credential, merge request or general HTTP operation. Session requests stay in the isolated content
script and use fixed first-party Graphite paths.

## State and failures

The addon supports `read`, `enable_mwr` and `disable_mwr` only. Commands have bounded PR lists,
nonces, deadlines and one client-bound lease. Successful results must cover the exact requested
PRs, heads and toggle values. Missing toggle state fails; it is never interpreted as disabled.
An already matching boolean avoids a write. Expiry, unknown state, stale revisions and closed PRs
block writes. Lost confirmation after a write remains uncertain; no write is automatically retried.

Graphite's observed web mutation accepts a PR identity without an atomic expected-head condition.
A preflight head check and a postflight read cannot prevent a concurrent push. Browser permission
and confirmation therefore explicitly authorize a **PR setting across later pushes**, rather than
claiming a commit lock. A push during the write remains uncertain in Follow Up. This is Graphite's
Merge when ready setting, separate from GitHub auto-merge and from a merge submission.

Verification uses synthetic Graphite responses and separate Paseo homes. Never issue a real PR
mutation to test this integration. Follow Up's `scripts/check-browser-controls.mjs` exercises real
Chrome, the installed bridge and native controls. `test/follow-up-install.mjs` verifies installed
PR routing against its synthetic preview. Tokens, fixture homes and captured logs are not shipped.
