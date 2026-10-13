# Optional Follow-through browser connection

Send to Paseo remains a PR-to-agent tool. Version 1.5.0 adds transport for Follow-through's human-clicked Graphite Merge when ready switch. Follow-through owns the controls, inventory, stack confirmations, action audit and uncertain results. This addon adds no Send popover controls, does not enroll workspaces, enables no Auto settings, and never sends an agent task.

Graphite's CLI token supports mergeability reads and merge submission but is rejected by its web toggle routes. The companion runs in an isolated content script on a first-party Graphite app tab; cookie-bound requests stay there. It never reads or exports cookies. Paseo pairing tokens remain in the extension worker. Keeping any signed-in Graphite tab open establishes the connection; the tab can be in the background.

## Addon protocol

`POST /follow-through/v1/exchange` is separate from frozen Send `CONTRACT.md` v1. It uses the existing bridge Host, Origin, bearer, rate and body-limit checks. Old extensions retain all Send functionality; an old bridge simply has no addon route. An installed bridge without Follow-through returns no jobs.

The exchange sends `{clientId, ready, acceptJobs, results}`. Each result has a routeId and the Follow-through command ID/nonce. The response has `routes`, each with `{routeId,jobs,accepted}`. Paired Additional machines are proxied through their fixed HTTPS addon route. A round-robin slot permits only one route to lease work per exchange; other routes still receive heartbeat/results. The worker shares available first-party tab capacity across hosts.

Commands accept only `read`, `enable_mwr`, `disable_mwr`, a validated owner/repository, positive PR numbers, expected head revisions, trunk names, IDs/nonces and an expiry. No caller-provided URL, JavaScript, Graphite token, arbitrary HTTP request or merge command crosses the addon. Follow-through's broker leases a job once to a specific client. Result scope and nonce are checked before acceptance.

The companion checks the selected revision and OPEN state before each toggle. Reads use `/api/v1/graphite/github-pr/{owner}/{repo}/{number}`. Toggles use `/api/v1/graphite/mutation/enable-mwr` or `disable-mwr` with the Graphite web application's structured body. An already-matching setting avoids another write. A mutation receipt and fresh matching state are required for success. Scheduling/queue state is recorded separately from the actual `mergeWhenReady` boolean.

No write is retried. A network error or unverifiable read after a write returns uncertain; transport may resend only the same result receipt. Partial results identify confirmed PRs. The user checks state in Follow-through before another action. Cookies, raw Graphite payloads and response bodies are never returned to the daemon or logged.

These Graphite web routes are private interfaces and can change. Unexpected structures fail visibly; do not substitute GitHub auto-merge or inferred queue status for the switch. Merge submission itself belongs to Follow-through's separate daemon-side CLI integration.

## Verification

`npm --prefix plugin run verify` covers the existing Send bridge. `npm --prefix extension run verify` runs typechecking, seven unit cases, the shipping build and 66 original extension browser cases. The new unit cases verify scoped request bodies, matching head checks, idempotency, exact toggle versus scheduling, and uncertain confirmation reads. Both shipping and test bundles use the existing build isolation: localhost Graphite fixtures are allowed only in `dist-test`.

The cross-plugin browser path requires an isolated Paseo daemon with both plugins and a synthetic Graphite server. Never use a real merge or real toggle as a test. Record the separate integration evidence in Follow-through's `docs/ui-verification.md`.
