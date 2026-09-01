# Verification log — `send-to-paseo` plugin

Every command below was run on the daemon machine on 2026-09-01 against the live
Paseo daemon (`0.7.0`, `serverId: srv_Ab3xY9pQ2mNt`) and the live
`acmegizmos/gizmo-poc` repository. Output is pasted verbatim, with three
redactions: the pairing token is never printed; prompt bodies are only shown
where the point of the test *is* the composed prompt; and the run was against a
private repository, so owner/repo names, branch names, ticket ids, PR titles,
commit SHAs, Paseo workspace/agent/server ids and home-directory paths have been
consistently replaced with fictional equivalents. Every number, timing, exit
code and error string is untouched.

Contents:

1. [Typecheck](#1-typecheck)
2. [Install](#2-install)
3. [Reload-hang check](#3-reload-hang-check-critical)
4. [Logs and secret audit](#4-logs-and-secret-audit)
5. [HTTP contract via curl](#5-http-contract-via-curl)
6. [Dry run](#6-dry-run)
7. [Real send to an existing workspace](#7-real-send-to-an-existing-workspace)
8. [Real create-workspace send (`checkout-pr`)](#8-real-create-workspace-send-checkout-pr)
9. [Deep link round trip](#9-deep-link-round-trip)
10. [Surface RPC handlers](#10-surface-rpc-handlers)
11. [Cleanup audit](#11-cleanup-audit)
12. [What was not verified](#12-what-was-not-verified)
13. [Contract amendment: ping token validation, providers and `dryRun`](#13-contract-amendment-ping-token-validation-providers-and-dryrun)
14. [Contract amendment: rate limit raised to 60 requests / 10 s](#14-contract-amendment-rate-limit-raised-to-60-requests--10-s)
15. [Stack resolution: one workspace per stack](#15-stack-resolution-one-workspace-per-stack-2026-09-01)
16. [Dependency audit and graceful degradation](#16-dependency-audit-and-graceful-degradation-2026-09-01)
17. [Permission modes and agent profiles](#17-permission-modes-and-agent-profiles-2026-09-01)
18. [`paseo plugin add` from Git: the no-`node_modules` build](#18-paseo-plugin-add-from-git-the-no-node_modules-build-2026-09-01)

---

## 1. Typecheck

```
$ npm run typecheck

> send-to-paseo@0.1.0 typecheck
> tsc --noEmit
```

Clean, no output.

---

## 2. Install

```
$ paseo plugin install ~/Projects/send-to-paseo/plugin
PLUGIN                STATUS      ENABLED   DIRECTORY                                  ERROR
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin

$ paseo plugin ls
PLUGIN                STATUS      ENABLED   DIRECTORY                                     ERROR
other-plugin          running     yes       ~/Projects/other-plugin
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
```

`running`, `ERROR` column empty. `~/.paseo/config.json` was **not** edited by
hand and the daemon was **not** restarted at any point.

Data directory permissions, checked immediately after first run:

```
$ ls -ld ~/.paseo/plugin-data/send-to-paseo
drwx------@ 3 jdoe  staff  96 Sep  1 11:23 ~/.paseo/plugin-data/send-to-paseo

$ ls -la ~/.paseo/plugin-data/send-to-paseo/
-rw-------@ 1 jdoe  staff  188 Sep  1 11:23 settings.json
```

`0700` directory, `0600` file, as CONTRACT.md requires.

---

## 3. Reload-hang check (critical)

This is the trap that a listening HTTP server sets: the socket keeps the plugin
subprocess event loop alive and Paseo's "Stopping plugin" step never returns.

Three consecutive reloads:

```
$ time paseo plugin reload send-to-paseo
PLUGIN                STATUS      ENABLED   DIRECTORY                                  ERROR
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
paseo plugin reload send-to-paseo 2>&1  0.64s user 0.06s system 89% cpu 0.785 total

$ time paseo plugin reload send-to-paseo
...
paseo plugin reload send-to-paseo 2>&1  0.69s user 0.07s system 93% cpu 0.812 total

$ time paseo plugin reload send-to-paseo
...
paseo plugin reload send-to-paseo 2>&1  0.62s user 0.07s system 89% cpu 0.768 total

$ paseo plugin ls | grep send-to-paseo
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
```

Two more after the final source change:

```
paseo plugin reload send-to-paseo 2>&1  0.72s user 0.08s system 87% cpu 0.923 total
paseo plugin reload send-to-paseo 2>&1  0.70s user 0.07s system 91% cpu 0.844 total
```

Under one second every time, still `running`. The paired log lines show teardown
actually completing rather than being killed:

```
[paseo] Stopping plugin
[send-to-paseo] bridge stopped
[paseo] Plugin stopped
[paseo] Loading plugin
[paseo] Plugin ready
[send-to-paseo] bridge listening on http://127.0.0.1:7788
```

Independent confirmation from the harness in §10: after the cleanup function
returned by `contribute()` runs, the Node process **exits on its own** in 0.316 s
total. Nothing is left holding the event loop.

---

## 4. Logs and secret audit

```
$ paseo plugin logs send-to-paseo
2026-09-01T08:23:02.131Z  stdout  [send-to-paseo] generated a new pairing token
2026-09-01T08:23:02.135Z  stdout  [send-to-paseo] bridge listening on http://127.0.0.1:7788
2026-09-01T08:23:16.080Z  stdout  [paseo] Stopping plugin
2026-09-01T08:23:16.081Z  stdout  [send-to-paseo] bridge stopped
2026-09-01T08:23:16.090Z  stdout  [paseo] Plugin stopped
...
2026-09-01T08:24:26.597Z  stderr  [send-to-paseo] refused a request from a non-extension origin
2026-09-01T08:24:26.606Z  stderr  [send-to-paseo] refused a request from a non-extension origin
2026-09-01T08:24:26.614Z  stderr  [send-to-paseo] refused a request from a non-extension origin
2026-09-01T08:29:06.866Z  stdout  [send-to-paseo] sent PR #948 to goofy-falcon (agent 5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8, provider claude/claude-haiku-4-5)
2026-09-01T08:29:44.684Z  stdout  [send-to-paseo] created worktree workspace wks_2f6d0e4b9c7a1358 for PR #942 on giz-1133-widget-backed-inventory-audit-rule-1
2026-09-01T08:29:44.857Z  stdout  [send-to-paseo] sent PR #942 to giz-1133-widget-backed-inventory-audit-rule (agent 1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37, provider claude/claude-haiku-4-5)
```

No errors, no stack traces. Explicit grep for the two things that must never
appear:

```
$ paseo plugin logs send-to-paseo | grep -c "$TOKEN"
0
$ paseo plugin logs send-to-paseo | grep -ci "ACK and stop"     # the prompt body
0
```

Note that the refused-origin line deliberately does not echo the origin, so a
hostile page cannot write attacker-controlled text into the user's log.

---

## 5. HTTP contract via curl

### `GET /v1/ping` — no `Origin`, no auth

> Superseded by [§13](#13-contract-amendment-ping-token-validation-providers-and-dryrun),
> which re-verifies `/v1/ping` against the amended contract (token validation and
> a `providers` list). The run below predates that amendment and is kept only
> because the header block is still current.

```
$ curl -s -i http://127.0.0.1:7788/v1/ping
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 156
Cache-Control: no-store
X-Content-Type-Options: nosniff
Vary: Origin

{"ok":true,"name":"send-to-paseo","version":"0.1.0","contract":1,"daemon":{"reachable":true,"version":"0.7.0","serverId":"srv_Ab3xY9pQ2mNt"},"paired":false}
```


### `POST /v1/resolve` — PR #942 with the real stack siblings

```
$ curl -s -X POST http://127.0.0.1:7788/v1/resolve \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,
         "stackPrNumbers":[949,948,947,946,945,943,941]}'
HTTP 200
```

```
pr: {
 "number": 942,
 "title": "GIZ-1133: Legacy tally engine retirement #3 - Make the inventory-audit rule widget-backed",
 "headBranch": "giz-1133-widget-backed-inventory-audit-rule",
 "baseBranch": "main",
 "state": "OPEN",
 "url": "https://github.com/acmegizmos/gizmo-poc/pull/942"
}
project: {"projectId": "remote:github.com/acmegizmos/gizmo-poc",
          "name": "acmegizmos/gizmo-poc", "path": "~/Projects/gizmo-poc"}
defaultCandidateIndex: 37
providers count: 44 default: [{'id': 'claude/claude-opus-5', 'label': 'Opus 5', 'isDefault': True}]
candidates: 38
   2 stack   goofy-falcon | giz-1132-retire-legacy-cache-flag | 948 | agents= 1
   3 project afraid-ostrich | explore-bulk-import-adapters | None | agents= 1
   3 project afraid-walrus | giz-1084-add-sandbox-demo-login | None | agents= 1
   3 project amazing-kiwi | giz-1104-restore-catalogdetails-enrichment-... | None | agents= 1
   3 project bad-toad | giz-1071-session-recovery-notes | None | agents= 3
   3 project Bot smoke-test runner | main | None | agents= 1
   3 project brawny-dodo | giz-1114-document-the-graphite-and-mcp-setup-... | None | agents= 1
   ...
 ...last: {'kind': 'create', 'label': 'Create worktree for PR #942',
           'branch': 'giz-1133-widget-backed-inventory-audit-rule',
           'rank': 4, 'reason': 'create'}

sorted ascending by rank: True
create present: True
ASSERT headBranch == "giz-1133-widget-backed-inventory-audit-rule": True
```

Assertions met:

- `pr.headBranch` is exactly `giz-1133-widget-backed-inventory-audit-rule`
- project resolved to `remote:github.com/acmegizmos/gizmo-poc`
- candidates sorted ascending by rank
- a `create` candidate is present (it is the last entry)
- rank 2 works: PR #948's branch `giz-1132-retire-legacy-cache-flag` is checked out
  in the `goofy-falcon` worktree, and it is labelled with `stackPrNumber: 948`

**`baseBranch` is `main`, not `graphite-base/942` as in CONTRACT.md's example.**
That is live data — Graphite has restacked #942 since the contract was written.
The plugin reports whatever `gh` returns.

### `POST /v1/resolve` — PR whose branch has no workspace

PR #942 *is* that case: no worktree on this machine has
`giz-1133-widget-backed-inventory-audit-rule` checked out. The response above
returns `200` with `defaultCandidateIndex: 37`, which is the `create` candidate
(38 candidates, indices 0..37). Confirmed programmatically:

```
$ python3 -c "... d['candidates'][d['defaultCandidateIndex']]"
{'kind': 'create', 'label': 'Create worktree for PR #942', 'rank': 4, 'reason': 'create'}
```

### `POST /v1/resolve` — PR that *does* have an exact workspace

```
$ curl -s -X POST http://127.0.0.1:7788/v1/resolve -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":948,"stackPrNumbers":[942,947]}'
HTTP 200

pr.headBranch: giz-1132-retire-legacy-cache-flag
defaultCandidateIndex: 0
candidates[0]: {
 "kind": "existing",
 "workspaceId": "wks_e1f4a70c6b93d825",
 "label": "goofy-falcon",
 "branch": "giz-1132-retire-legacy-cache-flag",
 "cwd": "~/.paseo/worktrees/pj4k2wxb/goofy-falcon",
 "isolation": "worktree",
 "agentCount": 1,
 "rank": 1,
 "reason": "exact"
}
ASSERT default is rank 1: True
```

### Error cases

```
$ # bogus repo
$ curl ... -d '{"forge":"github","owner":"acmegizmos","repo":"no-such-repo-xyz","number":1}'
{"error":{"code":"project_not_found","message":"acmegizmos/no-such-repo-xyz is not a project in Paseo.","hint":"Add it in Paseo, or run: paseo project add /path/to/no-such-repo-xyz"}}
HTTP 404

$ # bogus PR number
$ curl ... -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":999999}'
{"error":{"code":"pr_not_found","message":"Pull request acmegizmos/gizmo-poc#999999 was not found on GitHub."}}
HTTP 404

$ # no token
{"error":{"code":"unauthorized","message":"This request needs the Send to Paseo pairing token.","hint":"Copy the token from Paseo -> Send to Paseo into the extension options page."}}
HTTP 401

$ # wrong token
{"error":{"code":"unauthorized","message":"That pairing token is not valid for this Paseo bridge.","hint":"Copy the current token from Paseo -> Send to Paseo."}}
HTTP 401
```

### `Origin: https://app.graphite.com` — refused on preflight *and* real request

```
$ curl -s -i -X OPTIONS http://127.0.0.1:7788/v1/resolve \
    -H 'Origin: https://app.graphite.com' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: authorization,content-type'
HTTP/1.1 403 Forbidden
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
X-Content-Type-Options: nosniff
Vary: Origin

{"error":{"code":"forbidden_origin","message":"This bridge only accepts requests from the Send to Paseo browser extension."}}
```

```
$ curl -s -i -X POST http://127.0.0.1:7788/v1/resolve \
    -H 'Origin: https://app.graphite.com' -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{...942...}'
HTTP/1.1 403 Forbidden
...
{"error":{"code":"forbidden_origin","message":"This bridge only accepts requests from the Send to Paseo browser extension."}}
```

Also refused on the otherwise-unauthenticated `GET /v1/ping`, so there is no
origin-check bypass through the health endpoint:

```
$ curl -s http://127.0.0.1:7788/v1/ping -H 'Origin: https://app.graphite.com'
{"error":{"code":"forbidden_origin","message":"..."}}
HTTP 403
```

No `Access-Control-Allow-Origin` is echoed on any of these.

### `Origin: chrome-extension://fakeid` + valid token — allowed, CORS echoed

Preflight:

```
$ curl -s -i -X OPTIONS http://127.0.0.1:7788/v1/resolve -H 'Origin: chrome-extension://fakeid' ...
HTTP/1.1 204 No Content
Vary: Origin
Cache-Control: no-store
Access-Control-Allow-Origin: chrome-extension://fakeid
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 600
```

Real request:

```
$ curl -s -D - -X POST http://127.0.0.1:7788/v1/resolve -H 'Origin: chrome-extension://fakeid' \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{...948...}'
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 13804
Cache-Control: no-store
X-Content-Type-Options: nosniff
Vary: Origin
Access-Control-Allow-Origin: chrome-extension://fakeid
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 600

body pr.headBranch: giz-1132-retire-legacy-cache-flag

$ grep -ci "allow-credentials" headers
0
```

`Vary: Origin` present, origin echoed exactly, and no
`Access-Control-Allow-Credentials`, per CONTRACT.md.

### Bad `Host` header

```
$ curl -s http://127.0.0.1:7788/v1/ping -H 'Host: evil.example.com:7788'
{"error":{"code":"forbidden_host","message":"This bridge only answers on 127.0.0.1 or localhost."}}
HTTP 403

$ curl -s http://127.0.0.1:7788/v1/ping -H 'Host: 127.0.0.1:9999'   # right host, wrong port
{"error":{"code":"forbidden_host","message":"This bridge only answers on 127.0.0.1 or localhost."}}
HTTP 403

$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:7788/v1/ping -H 'Host: localhost:7788'
HTTP 200
```

The check tracks the *bound* port, not the default. Verified against a second
instance of the same code listening on 7861:

```
$ curl -s http://127.0.0.1:7861/v1/ping -H 'Host: 127.0.0.1:7788'
{"error":{"code":"forbidden_host","message":"This bridge only answers on 127.0.0.1 or localhost."}}
HTTP 403
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:7861/v1/ping -H 'Host: localhost:7861'
HTTP 200
```

### Body > 64 KiB

```
$ ls -la /tmp/big.json
-rw-r--r--@ 1 jdoe  wheel  70124 Sep  1 11:24 /tmp/big.json

$ curl -s -X POST http://127.0.0.1:7788/v1/send -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data-binary @/tmp/big.json
{"error":{"code":"payload_too_large","message":"The request body is larger than the 64 KiB limit."}}
HTTP 413
```

### Empty prompt

```
$ curl ... -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":948,
                "prompt":"   ","target":{"kind":"existing","workspaceId":"wks_e1f4a70c6b93d825"}}'
{"error":{"code":"bad_request","message":"A message is required."}}
HTTP 400
```

Whitespace-only, so this also proves the 1..16000 bound is applied *after* trim.

### Rate limit — historical run at the original 30 requests / 10 s per origin (now 60; see §14)

> Superseded by [§14](#14-contract-amendment-rate-limit-raised-to-60-requests--10-s):
> the limit was later raised to 60. The run below is the original 30 threshold and
> is kept only to show the boundary behaviour was exact at that value too.

35 sequential requests on a fresh origin bucket:

```
$ for i in $(seq 1 35); do ... done
1:200 2:200 3:200 4:200 5:200 6:200 7:200 8:200 9:200 10:200 11:200 12:200
13:200 14:200 15:200 16:200 17:200 18:200 19:200 20:200 21:200 22:200 23:200
24:200 25:200 26:200 27:200 28:200 29:200 30:200 31:429 32:429 33:429 34:429 35:429
```

Exactly 30 allowed, then `429`:

```
HTTP/1.1 429 Too Many Requests
Vary: Origin
Access-Control-Allow-Origin: chrome-extension://ratelimitprobe
Retry-After: 10

{"error":{"code":"rate_limited","message":"Too many requests; slow down."}}
```

---

## 6. Dry run

`SEND_TO_PASEO_DRY_RUN` is read from the plugin subprocess environment. Paseo
spawns that subprocess with `fork(...)` and no `env` option
(`@getpaseo/server/dist/server/server/plugins/runtime.js:97`), so the child
inherits the *daemon's* environment — and setting an environment variable for the
running daemon would mean restarting it, which is forbidden here because it
would kill running agents.

So dry run was verified by running **the same source files** in a standalone
process with the flag set. The harness bundles the real `bridge.server.ts` with
esbuild using the same options the daemon's own plugin compiler uses
(`format: "cjs"`, `platform: "node"`; see
`@getpaseo/server/dist/server/server/plugins/compiler.js:259`), stubs only
`defineRpc` from the host-provided `@getpaseo/plugin/server`, and points
`PASEO_HOME` at a temp directory so it cannot touch the installed plugin's token
or port.

```
$ SEND_TO_PASEO_DRY_RUN=1 PASEO_HOME=/tmp/stp-dry/home node bundle.cjs
[send-to-paseo] bridge listening on http://127.0.0.1:7861 (dry run)

$ lsof -nP -iTCP:7861 -sTCP:LISTEN
node    59134 jdoe   12u  IPv4 0x749bfb3ca75b452d  0t0  TCP 127.0.0.1:7861 (LISTEN)
```

Agent count before: **85**. Worktree count before: **39**.

```
$ curl -s -X POST http://127.0.0.1:7861/v1/send -H "Authorization: Bearer $HARNESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":948,
         "prompt":"Fix merge conflicts","target":{"kind":"existing","workspaceId":"wks_e1f4a70c6b93d825"}}'
{
    "ok": true,
    "agentId": "agt_dryrun_2b6c40f9ad13",
    "workspaceId": "wks_e1f4a70c6b93d825",
    "workspaceCreated": false,
    "workspaceLabel": "goofy-falcon",
    "branch": "giz-1132-retire-legacy-cache-flag",
    "deepLink": "paseo://h/srv_Ab3xY9pQ2mNt/agent/agt_dryrun_2b6c40f9ad13",
    "title": "PR #948 · Fix merge conflicts",
    "dryRun": true
}

$ curl -s -X POST http://127.0.0.1:7861/v1/send ... '{"...number":942,"prompt":"Rebase onto main","target":{"kind":"create"}}'
{
    "ok": true,
    "agentId": "agt_dryrun_8e51c7b06d94",
    "workspaceId": "wks_dryrun_3c9f1e2b8a04",
    "workspaceCreated": true,
    "workspaceLabel": "Create worktree for PR #942",
    "branch": "giz-1133-widget-backed-inventory-audit-rule",
    "deepLink": "paseo://h/srv_Ab3xY9pQ2mNt/agent/agt_dryrun_8e51c7b06d94",
    "title": "PR #942 · Rebase onto main",
    "dryRun": true
}
```

Both `200`, both `"dryRun": true`, both same response shape as a real send.
Nothing was created:

```
$ paseo ls --json | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"
85
$ ls ~/.paseo/worktrees/pj4k2wxb/ | wc -l
      39
$ paseo ls --json | grep -c dryrun
0
```

Harness log — full resolution ran, including the default-provider fallback,
before nothing was created:

```
[send-to-paseo] dry-run sent PR #948 to goofy-falcon (agent agt_dryrun_..., provider claude/claude-opus-5)
[send-to-paseo] dry-run sent PR #942 to Create worktree for PR #942 (agent agt_dryrun_..., provider claude/claude-opus-5)
```

> An earlier run of this test used port 7799 and one of its four responses came
> back with a message string (`"Unexpected Host header."`) that is not in this
> plugin's source. It came from `test/mock-bridge.mjs`, which another agent had
> started on the same port. The test was re-run from scratch on port 7861; only
> those results are recorded above. **Port 7799 is in use by the test harness —
> do not use it for the bridge.**

---

## 7. Real send to an existing workspace

Dry run off, targeting the *existing* `goofy-falcon` worktree (no worktree
created for this test), against PR #948 whose head branch is checked out there.

```
$ curl -s -X POST http://127.0.0.1:7788/v1/send -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":948,
         "prompt":"Say only the word ACK and stop.",
         "target":{"kind":"existing","workspaceId":"wks_e1f4a70c6b93d825"},
         "provider":"claude/claude-haiku-4-5"}'
HTTP 200
{
    "ok": true,
    "agentId": "5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8",
    "workspaceId": "wks_e1f4a70c6b93d825",
    "workspaceCreated": false,
    "workspaceLabel": "goofy-falcon",
    "branch": "giz-1132-retire-legacy-cache-flag",
    "deepLink": "paseo://h/srv_Ab3xY9pQ2mNt/agent/5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8",
    "title": "PR #948 · Say only the word ACK and stop."
}
```

The agent exists, with the right title, placement and labels:

```
$ paseo inspect 5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8 --json
{
    "Id": "5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8",
    "Name": "PR #948 · Say only the word ACK and stop.",
    "Provider": "claude",
    "Model": "claude-haiku-4-5",
    "Status": "idle",
    "Archived": false,
    "Cwd": "~/.paseo/worktrees/pj4k2wxb/goofy-falcon",
    "CreatedAt": "2026-09-01T08:29:06.866Z",
    ...
}
```

`paseo inspect` does not print labels, so those were read from the daemon
directly (`agents.list()` → `PluginAgentSnapshot.labels`):

```
=== AGENT SNAPSHOT ===
id         : 5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8
title      : "PR #948 · Say only the word ACK and stop."
workspaceId: wks_e1f4a70c6b93d825
cwd        : ~/.paseo/worktrees/pj4k2wxb/goofy-falcon
labels     : {"send-to-paseo/pr":"github:acmegizmos/gizmo-poc#948","send-to-paseo/origin":"graphite"}
```

Both labels present with the CONTRACT.md values, and `workspaceId` matches the
requested target exactly.

The composed prompt header, as the agent actually received it:

```
$ paseo logs 5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8
[User] [Sent from Graphite — github/acmegizmos/gizmo-poc PR #948]
Title: GIZ-1132: Legacy tally engine retirement #8 - Retire the legacy cache flag and gate the catalog seed
Branch: giz-1132-retire-legacy-cache-flag -> giz-1132-retire-legacy-era-levers
PR: https://github.com/acmegizmos/gizmo-poc/pull/948

Say only the word ACK and stop.
ACK
```

Byte-for-byte the CONTRACT.md "Prompt composition" block, including the em dash,
the `->` arrow and the blank line before the user's verbatim text. The agent
replied `ACK`.

`deepLink` is `paseo://h/srv_Ab3xY9pQ2mNt/agent/8ae7fc63-...` — see §9.

Cleaned up:

```
$ paseo delete 5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8
DELETED
1
```

---

## 8. Real create-workspace send (`checkout-pr`)

PR #942's head branch is checked out in no workspace, so `target: {kind:"create"}`
genuinely exercises Paseo's `checkout-pr` path. `pageUrl` was included here to
exercise that field too.

```
$ ls ~/.paseo/worktrees/pj4k2wxb/ | wc -l
      39

$ time curl -s -X POST http://127.0.0.1:7788/v1/send -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942,
         "prompt":"Say only the word ACK and stop.","target":{"kind":"create"},
         "provider":"claude/claude-haiku-4-5",
         "pageUrl":"https://app.graphite.com/github/pr/acmegizmos/gizmo-poc/942/GIZ-1133"}'
HTTP 200
... 4.017 total
{
    "ok": true,
    "agentId": "1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37",
    "workspaceId": "wks_2f6d0e4b9c7a1358",
    "workspaceCreated": true,
    "workspaceLabel": "giz-1133-widget-backed-inventory-audit-rule",
    "branch": "giz-1133-widget-backed-inventory-audit-rule-1",
    "deepLink": "paseo://h/srv_Ab3xY9pQ2mNt/agent/1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37",
    "title": "PR #942 · Say only the word ACK and stop."
}
```

**`checkout-pr` worked**, in about 4 seconds, through the SDK — no CLI fallback
was needed. The workspace exists:

```
$ paseo workspace ls --json | ... wks_2f6d0e4b9c7a1358
{
  "workspaceId": "wks_2f6d0e4b9c7a1358",
  "project": "acmegizmos/gizmo-poc",
  "name": "PR #942: GIZ-1133: Legacy tally engine retirement #3 - Make the inventory-audit rule widget-backed",
  "isolation": "worktree",
  "cwd": "~/.paseo/worktrees/pj4k2wxb/giz-1133-widget-backed-inventory-audit-rule"
}
```

Its git state is the PR:

```
$ git -C ~/.paseo/worktrees/pj4k2wxb/giz-1133-widget-backed-inventory-audit-rule rev-parse --abbrev-ref HEAD
giz-1133-widget-backed-inventory-audit-rule-1

$ git -C ... log --oneline -3
4c1e9a07b GIZ-1133: Legacy tally engine retirement #3 - Make the inventory-audit rule widget-backed
e73b0d5c1 GIZ-1132: Legacy tally engine retirement #2 - Add a lever to delete unbacked widget status rows (#941)
a19f6482d GIZ-1138: Sample every page load in the frontend tracer (#952)

$ git -C ... rev-parse --symbolic-full-name '@{upstream}'
refs/remotes/origin/giz-1133-widget-backed-inventory-audit-rule

$ git -C ~/Projects/gizmo-poc rev-parse giz-1133-widget-backed-inventory-audit-rule-1
4c1e9a07b2d3f58610cbe74d29af03516b8d7e2c
$ git -C ~/Projects/gizmo-poc rev-parse origin/giz-1133-widget-backed-inventory-audit-rule
4c1e9a07b2d3f58610cbe74d29af03516b8d7e2c
```

### Finding: the local branch name can carry a `-N` suffix

The checked-out branch is `giz-1133-widget-backed-inventory-audit-rule-1`, not the
PR head branch verbatim. Cause:

```
$ git -C ~/Projects/gizmo-poc branch --list 'giz-1133-widget-backed*'
  giz-1133-widget-backed-inventory-audit-rule       <- already existed before the test
+ giz-1133-widget-backed-inventory-audit-rule-1     <- Paseo's checkout-pr
```

A local branch of that name already existed in the repo, so Paseo's `checkout-pr`
created a uniquely-named local branch tracking `origin/<PR head branch>`. The
**commit and upstream are exactly the PR's**, so the workspace does contain the
PR — only the local branch label differs.

`/v1/send` reports the branch actually checked out, which is the truthful answer
for anything the extension might display. If no same-named local branch exists,
the branch equals the PR head branch verbatim (which is what `/v1/resolve` shows
for the `create` candidate).

### Prompt with `pageUrl`

```
$ paseo logs 1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37
[User] [Sent from Graphite — github/acmegizmos/gizmo-poc PR #942]
Title: GIZ-1133: Legacy tally engine retirement #3 - Make the inventory-audit rule widget-backed
Branch: giz-1133-widget-backed-inventory-audit-rule -> main
PR: https://github.com/acmegizmos/gizmo-poc/pull/942
Page: https://app.graphite.com/github/pr/acmegizmos/gizmo-poc/942/GIZ-1133

Say only the word ACK and stop.
ACK
```

The `Page:` line is the one interpretive choice in this implementation — see the
note in README.md and in the hand-off report.

Labels and placement on the created workspace:

```
id         : 1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37
title      : "PR #942 · Say only the word ACK and stop."
workspaceId: wks_2f6d0e4b9c7a1358
cwd        : ~/.paseo/worktrees/pj4k2wxb/giz-1133-widget-backed-inventory-audit-rule
labels     : {"send-to-paseo/pr":"github:acmegizmos/gizmo-poc#942","send-to-paseo/origin":"graphite"}
```

Cleaned up:

```
$ paseo delete 1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37
DELETED
1
$ paseo workspace archive wks_2f6d0e4b9c7a1358
WORKSPACE ID          STATUS      ARCHIVED AT
wks_2f6d0e4b9c7a1358  archived    2026-09-01T08:30:25.361Z
$ git -C ~/Projects/gizmo-poc branch -D giz-1133-widget-backed-inventory-audit-rule-1
Deleted branch giz-1133-widget-backed-inventory-audit-rule-1 (was 4c1e9a07b).
```

---

## 9. Deep link round trip

CONTRACT.md requires `deepLink` to be built with `buildAgentDeepLink` from
`@getpaseo/protocol/agent-deep-link` and to round-trip through
`parseAgentDeepLink`. Asserted against the real send from §7:

> **Superseded in part by [§18](#18-paseo-plugin-add-from-git-the-no-node_modules-build-2026-09-01).**
> `@getpaseo/protocol` is not resolvable when the daemon compiles a Git-installed
> plugin, so `buildAgentDeepLink` is now a local copy in `contracts.shared.ts`,
> proved byte-identical to the upstream function in §18.5. The wire value below
> is unchanged, so everything in this section still holds. CONTRACT.md's
> "Sending" section still spells the requirement as *import from
> `@getpaseo/protocol/agent-deep-link`*; that wording wants amending to *produce
> the format that function produces*, which is a change to the root CONTRACT.md,
> not to this plugin.


```
=== DEEP LINK ROUND TRIP ===
returned deepLink       : paseo://h/srv_Ab3xY9pQ2mNt/agent/5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8
parseAgentDeepLink      : {"serverId":"srv_Ab3xY9pQ2mNt","agentId":"5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8"}
agentId round-trips     : true
serverId round-trips    : true
naive paseo://agent/<id>: null
```

And against the create send from §8:

```
returned deepLink       : paseo://h/srv_Ab3xY9pQ2mNt/agent/1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37
parseAgentDeepLink      : {"serverId":"srv_Ab3xY9pQ2mNt","agentId":"1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37"}
agentId round-trips     : true
serverId round-trips    : true
naive paseo://agent/<id>: null
```

The returned link parses back to exactly `{serverId, agentId}`, and the
plausible-looking `paseo://agent/<agentId>` parses to `null`, confirming the
corrected format was necessary. `serverId` is resolved at runtime from the
daemon's `GET /api/status`, never hardcoded:

```
$ curl -s http://127.0.0.1:6767/api/status
{"status":"server_info","serverId":"srv_Ab3xY9pQ2mNt","hostname":"dev-macbook.local","version":"0.7.0","listen":"127.0.0.1:6767"}
```

---

## 10. Surface RPC handlers

The Paseo surface is React Native and cannot be driven from a shell, so its data
path was verified by loading `index.ts` with a recording `PluginContext` and
calling every handler the surface calls, against a real daemon connection.

```
$ PASEO_HOME=/tmp/stp-dry/home node rpc-bundle.cjs

=== CONTRIBUTIONS ===
  surface:settings
  sidebar:send-to-paseo icon=Send -> surface:settings
  command:send-to-paseo-settings
=== RPC HANDLERS ===
  send-to-paseo.status
  send-to-paseo.token.reveal
  send-to-paseo.token.regenerate
  send-to-paseo.config.update
  send-to-paseo.recent.clear
[send-to-paseo] bridge listening on http://127.0.0.1:7863
=== send-to-paseo.status ===
{
  "state": "running",
  "port": 7863,
  "configuredPort": 7863,
  "error": null,
  "startedAt": "2026-09-01T08:35:02.362Z",
  "lastRequestAt": null,
  "requestCount": 0,
  "paired": true,
  "dryRun": false,
  "tokenPreview": "harn…only",
  "defaultProvider": null,
  "daemon": {
    "reachable": true,
    "version": "0.7.0",
    "serverId": "srv_Ab3xY9pQ2mNt"
  }
}
providers: 44 providersError: null
recentSends: 4
sample providers: [{"id":"claude/claude-opus-5","label":"Opus 5","isDefault":true},
                   {"id":"claude/claude-fable-5","label":"Fable 5","isDefault":false},
                   {"id":"claude/claude-opus-4-8[1m]","label":"Opus 4.8 1M","isDefault":false}]
=== token.reveal === length: 43 (value redacted)
[send-to-paseo] pairing token regenerated
=== token.regenerate === length: 43 changed: true
=== config.update defaultProvider === claude/claude-sonnet-5 error: null
[send-to-paseo] bridge stopped
[send-to-paseo] bridge listening on http://127.0.0.1:7862
=== config.update port === 7862 running error: null
=== recent.clear === removed: 4
=== running cleanup() returned by contribute() ===
[send-to-paseo] bridge stopped
cleanup completed; the process should now exit on its own

PASEO_HOME=/tmp/stp-dry/home node rpc-bundle.cjs  0.30s user 0.05s system 109% cpu 0.316 total
```

Everything the surface needs works: the sidebar item points at a registered
surface, the status payload is fully populated, the token reveals (43 chars =
32 random bytes base64url) and rotates, saving a default provider persists,
changing the port genuinely rebinds the listener (7863 stopped, 7862 listening),
and the recent-sends list clears.

The last two lines are the important ones for the reload trap: the cleanup
returned by `contribute()` completed and **the process exited by itself**, total
wall clock 0.316 s. Nothing was left keeping the event loop alive.

Styling audit of `settings.client.tsx` — every `Text` resolves its color from
`theme.colors`, and there are no color literals:

```
$ grep -nE "#[0-9a-fA-F]{3,8}|rgba?\(|'(black|white|red|gray|grey)'" settings.client.tsx
none

$ grep -n "color:" settings.client.tsx
110:  color: theme.colors.foreground,          (title)
115:  color: theme.colors.foreground,          (heading)
119:  color: theme.colors.foreground,          (body)
120:  color: theme.colors.foregroundMuted,     (muted)
122:  color: theme.colors.foreground,          (mono)
129:  color: theme.colors.foreground,          (input)
147:  color: theme.colors.foreground,          (buttonText)
156:  color: theme.colors.accentForeground,    (primaryText)
157:  color: theme.colors.statusDanger,        (danger)
425:  color: stateTone(status, theme)          (status line: statusSuccess/Warning/Danger)
```

The root view uses `theme.colors.surface0` and all padding/gaps come from
`layout.compact`.

---

## 11. Cleanup audit

Nothing stray was left behind.

```
$ paseo ls --json | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"
85                              # identical to the count before any test

$ for probe in 8ae7fc63-... 2e9c3d7b-... 994c32b2-...; do ... done
5d2b91e7-4c68-4a3f-8b70-6e19fa25c4d8 GONE
1a4f8c02-7b3d-4e61-9c5a-2f80d6b41e37 GONE
7f30c85a-9d12-4b7e-a604-3c58e1907b6f GONE

$ ls -d ~/.paseo/worktrees/pj4k2wxb/giz-1133-widget-backed-inventory-audit-rule
ls: ...: No such file or directory

$ paseo workspace ls --json | grep -c wks_2f6d0e4b9c7a1358
0

$ ls ~/.paseo/worktrees/pj4k2wxb/ | wc -l
      39                        # identical to the count before any test

$ git -C ~/Projects/gizmo-poc branch --list 'giz-1133-widget-backed*'
  giz-1133-widget-backed-inventory-audit-rule       # pre-existing, untouched

$ lsof -nP -iTCP:7861 -sTCP:LISTEN ; ps aux | grep -c "[b]undle.cjs"
(nothing)                       # harness stopped
```

`994c32b2-...` was a first real send made before the agent-placement fix in
`send.server.ts`; it was deleted and the send was redone, and it is listed here
only so the count reconciles.

The installed plugin still holds its original token and is still paired:

```
$ paseo plugin ls | grep send-to-paseo
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
$ curl -s http://127.0.0.1:7788/v1/ping
{"ok":true,...,"paired":true}
$ curl -s -o /dev/null -w "resolve HTTP %{http_code}\n" -X POST http://127.0.0.1:7788/v1/resolve ...
resolve HTTP 200
```

---

## 12. What was not verified

Stated plainly rather than papered over.

1. **Visual check of the surface in the Paseo app.** The sidebar item, surface
   registration and every RPC behind it are verified in §10, and the styling
   audit shows all text colors come from `theme.colors`. But nobody has *looked*
   at it in a wide window and a compact one, in a light theme and a dark one.
   That check still needs a human or a driven desktop client.

2. **`SEND_TO_PASEO_DRY_RUN=1` on the installed plugin.** Verified on identical
   source in a standalone process (§6), because injecting an environment variable
   into the running daemon's subprocess would require a daemon restart. Once the
   daemon is next restarted with the variable exported, the installed plugin will
   pick it up with no code change.

3. **`forge_unauthenticated`.** Not triggered on purpose — doing so would mean
   breaking the user's `gh` authentication. The mapping is implemented and
   reviewed in `gh.server.ts` (`gh` exit code 4, `ENOENT` for a missing binary,
   and the usual stderr phrases), but no real 502 was observed.

4. **`workspace_create_failed` / `agent_create_failed` / `daemon_unreachable`.**
   Same reasoning: reproducing them means breaking the daemon or the repository.
   Implemented and reviewed, not observed.

5. **A `chrome-extension://` origin from a real Chrome extension.** Tested with a
   synthetic `chrome-extension://fakeid` origin. The extension-ID pinning path
   (`allowedExtensionIds`) is implemented but has no test yet because it is empty
   by default.

---

## 15. Stack resolution: one workspace per stack (2026-09-01)

**Reported:** "I usually have one paseo workspace for a PR stack, so sometimes I want to
Send to Paseo PR #4, but the workspace is at another PR in the stack. Currently it says to
create a new workspace."

Three defects, not one.

### 15.1 The default never considered a stack match

`buildCandidates` computed rank-2 `stack` candidates correctly and then ignored them:
`defaultCandidateIndex` was `exact` if present, otherwise `create`. A found stack workspace
was sorted into the list but never selected. Fixed: exact -> nearest stack -> create. Rank 3
stays ineligible, because an unrelated workspace in the project is a worse guess than a fresh
worktree.

### 15.2 Stack membership depended on scraping Graphite's DOM

`stackPrNumbers` came from the page. Graphite's stack panel collapses long stacks — the
captured fixture's own panel reads **"3 of 9 (1 hidden)"** — so a sibling could be missing
from the scrape entirely, and the workspace sitting on it would never be recognised.

Replaced with a lookup against the forge. **A Graphite stack is a real `base` -> `head` chain
on GitHub**, verified directly:

```
$ gh pr list --repo acmegizmos/gizmo-poc --state open --limit 200 \
    --json number,headRefName,baseRefName
   PR  head                                         base
  942  giz-1133-widget-backed-inventory-audit-rule  main
  943  giz-1133-drop-widget-status-metrics          giz-1133-widget-backed-inventory-audit-rule
  945  giz-1132-seed-widget-status-from-catalog     giz-1133-drop-widget-status-metrics
  ...
  949  giz-1136-purge-empty-order-status-records    giz-1132-retire-legacy-cache-flag
```

So one request rebuilds the graph and a breadth-first walk gives the stack. `viewStackGraph`
run against live GitHub:

```
PR #942 — the user's stack   6 members in 598ms
   #943  hops=1  giz-1133-drop-widget-status-metrics
   #945  hops=2  giz-1132-seed-widget-status-from-catalog
   #946  hops=3  giz-1132-delete-legacy-tally-calculator
   #947  hops=4  giz-1132-retire-legacy-era-levers
   #948  hops=5  giz-1132-retire-legacy-cache-flag
   #949  hops=6  giz-1136-purge-empty-order-status-records

PR #948 — same stack, from the middle   6 members in 0ms   <- cache hit
   #947  hops=1   #949  hops=1   #946  hops=2   #945  hops=3   #943  hops=4   #942  hops=5

PR #924 — a different stack   2 members     <- no leakage
PR #904 — long stack, bottom  8 members
no such branch                0 members     <- empty, not an error
```

Two things this proves beyond the happy path:

- **Walking from the middle goes both ways.** From #948, #947 (downstack) and #949 (upstack)
  are both one hop.
- **Branch prefixes do not identify a stack.** #942's stack spans `giz-1133`, `giz-1132` *and*
  `giz-1136`. Any grouping by ticket prefix would have been wrong.

Trunk cannot create a false edge: an edge needs one PR's base to be another PR's *head*, and
`main` is never a head. Confirmed against the live bridge — #924, #932 and #956 all sit on
`main`, and none resolves into another's stack.

**Why not `gt`.** The Graphite CLI answers "what is *my current* stack" from local,
per-worktree metadata, relative to whatever branch is checked out where it runs. `/v1/resolve`
runs while the user is typing in a browser and must not depend on, or disturb, the state of any
worktree — least of all the candidate workspaces, each of which is on its own branch. `gt` also
needs a second credential and its stack commands mutate repo-wide state. `gh` is read-only,
already required here, and sufficient. The one thing `gt` would add is stack branches with no PR
yet, which `gh` cannot see; that is a stated limitation, not an oversight.

### 15.3 The agent was told it was on the PR's branch when it was not

Sending to a stack workspace starts an agent in a worktree checked out to a *sibling* branch,
while `composePrompt` unconditionally wrote `Branch: <PR head> -> <PR base>`. An agent would
have committed to the wrong branch. `composePrompt` now takes the workspace's actual branch.
Executed directly, all three cases:

```
A. exact match          -> header unchanged (no extra lines)
B. stack sibling        -> Workspace branch: giz-1132-retire-legacy-cache-flag (NOT this PR's branch)
                           Note: this worktree is on a different branch of the same stack. If your
                           change belongs to PR #942, check out giz-1133-widget-backed-inventory-audit-rule first.
C. branch unknown       -> header unchanged (nothing invented)
```

### 15.4 Live bridge, before and after

Same request both times, with `stackPrNumbers` sent **empty** to prove the graph alone does the
work:

```
$ curl -s -X POST http://127.0.0.1:7788/v1/resolve -H "Authorization: Bearer $TOK" \
    -H "Origin: chrome-extension://…" -H "Content-Type: application/json" \
    -d '{"contract":1,"forge":"github","owner":"acmegizmos","repo":"gizmo-poc",
         "number":942,"stackPrNumbers":[]}'
```

| | before | after |
| --- | --- | --- |
| default candidate | `Create worktree for PR #942` | `goofy-falcon` |
| its branch | — | `giz-1132-retire-legacy-cache-flag` |
| rank / reason | 4 / `create` | 2 / `stack`, `stackPrNumber: 948` |

Cross-checks on the same live bridge:

| PR | expected | result |
| --- | --- | --- |
| #948 | exact match must still outrank stack | rank 1 `exact` -> `goofy-falcon` |
| #951 | exact match | rank 1 `exact` -> `radical-wolf` |
| #924, #932, #956 | different stacks, no workspace | rank 4 `create`, zero rank-2 |

### 15.5 Regression coverage

- `test/mock-bridge.mjs` now mirrors the ranking rule (exact -> stack -> create), keeping it a
  faithful reference.
- **Test 20** drives the reported case end to end: SPA-navigate to PR #947, which has no
  workspace on its own branch, and assert the resolved target is the stack workspace, that the
  summary is not "will create worktree", that the sibling-branch note is rendered, that
  `Create worktree` is still offered but unselected, and that the resulting `/v1/send` carries
  `target.kind: "existing"` with the stack workspace's id.
- **Test 8** previously asserted the old behaviour ("PR 948 has no exact workspace, so the
  default must be create"). It now asserts the stack workspace, and keeps its real job of
  proving SPA re-targeting.

Suite: **31 passed, 0 failed, 0 skipped.**

### 15.6 Limitation

Stack discovery sees **open** PRs. A workspace parked on a branch whose PR is closed or merged
is only matched if the extension still scrapes that number from the page. Branches with no PR
at all are invisible to `gh` and will not match — that is the case `gt` would cover, and the
reason to revisit this if it ever bites.

## Appendix: paths outside CONTRACT.md's table

Both stay inside the contract's documented error-code set rather than inventing
a new code, and the caller-supplied path is deliberately not echoed back.

```
$ curl -s http://127.0.0.1:7788/v1/nope -H "Authorization: Bearer $TOKEN"
{"error":{"code":"bad_request","message":"No such endpoint on this bridge.","hint":"Valid paths are /v1/ping, /v1/resolve and /v1/send."}}
HTTP 400

$ curl -s -X POST http://127.0.0.1:7788/v1/ping -H "Authorization: Bearer $TOKEN"
{"error":{"code":"bad_request","message":"That method is not allowed on this endpoint."}}
HTTP 400
```

Final state after the last source change:

```
$ time paseo plugin reload send-to-paseo
PLUGIN                STATUS      ENABLED   DIRECTORY                                  ERROR
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
paseo plugin reload send-to-paseo 2>&1  0.68s user 0.07s system 88% cpu 0.858 total

$ curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:7788/v1/resolve \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":948}'
HTTP 200

$ paseo plugin ls | grep send-to-paseo
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
```

---

## 13. Contract amendment: ping token validation, providers and `dryRun`

Re-verified after implementing the amended `GET /v1/ping`, the always-present
`dryRun`, and the Clarifications section. Run on 2026-09-01 against the installed
plugin on port 7788.

### 13.1 `GET /v1/ping` — the three auth states

**No `Authorization` → 200, `paired: false`, `providers: []`**

```
$ curl -s http://127.0.0.1:7788/v1/ping
HTTP 200
{"ok": true, "name": "send-to-paseo", "version": "0.1.0", "contract": 1,
 "daemon": {"reachable": true, "version": "0.7.0", "serverId": "srv_Ab3xY9pQ2mNt"},
 "paired": false, "providers": []}

paired: False | providers: list len= 0
```

**Valid `Authorization` → 200, `paired: true`, full `providers`**

```
$ curl -s http://127.0.0.1:7788/v1/ping -H "Authorization: Bearer $TOKEN"
HTTP 200

paired: True | providers len: 44
default provider: [{'id': 'claude/claude-opus-5', 'label': 'Opus 5', 'isDefault': True}]
first 3: [{"id": "claude/claude-opus-5", "label": "Opus 5", "isDefault": true},
          {"id": "claude/claude-fable-5", "label": "Fable 5", "isDefault": false},
          {"id": "claude/claude-opus-4-8[1m]", "label": "Opus 4.8 1M", "isDefault": false}]
shape keys of a provider: ['id', 'isDefault', 'label']
daemon: {"reachable": true, "version": "0.7.0", "serverId": "srv_Ab3xY9pQ2mNt"}
name/version/contract: send-to-paseo 0.1.0 1
```

**Invalid `Authorization` → 401 `unauthorized`**

```
$ curl -s http://127.0.0.1:7788/v1/ping -H "Authorization: Bearer totally-wrong-token"
{"error":{"code":"unauthorized","message":"That pairing token is not valid for this Paseo bridge.","hint":"Copy the current token from Paseo -> Send to Paseo."}}
HTTP 401
```

Two adjacent cases, so a malformed header cannot sneak through as "absent":

```
$ curl -s http://127.0.0.1:7788/v1/ping -H "Authorization: Basic abc123"
{"error":{"code":"unauthorized","message":"This request needs the Send to Paseo pairing token.","hint":"Copy the token from Paseo -> Send to Paseo into the extension options page."}}
HTTP 401

$ curl -s http://127.0.0.1:7788/v1/ping -H "Authorization: Bearer "
{"error":{"code":"unauthorized","message":"This request needs the Send to Paseo pairing token.","hint":"Copy the token from Paseo -> Send to Paseo into the extension options page."}}
HTTP 401
```

`paired` now reflects **this request's** auth state rather than a stored flag, so
a garbage token can no longer read as paired.

### 13.2 `providers` on ping is byte-identical to `/v1/resolve`

```
$ # /v1/ping with a valid token vs POST /v1/resolve for PR #948
ping len: 44 | resolve len: 44
IDENTICAL PAYLOAD: True
```

Asserted by comparing the parsed JSON arrays, not just their lengths.

### 13.3 Origin rules still apply to `/v1/ping`

```
$ curl -s http://127.0.0.1:7788/v1/ping -H 'Origin: https://app.graphite.com'
{"error":{"code":"forbidden_origin","message":"This bridge only accepts requests from the Send to Paseo browser extension."}}
HTTP 403

$ curl -s http://127.0.0.1:7788/v1/ping -H 'Origin: https://app.graphite.com' -H "Authorization: Bearer $TOKEN"
{"error":{"code":"forbidden_origin","message":"This bridge only accepts requests from the Send to Paseo browser extension."}}
HTTP 403
```

A valid token does not buy a page origin any access. From an extension origin:

```
$ curl -s -D - http://127.0.0.1:7788/v1/ping -H 'Origin: chrome-extension://fakeid' -H "Authorization: Bearer $TOKEN"
HTTP/1.1 200 OK
Vary: Origin
Access-Control-Allow-Origin: chrome-extension://fakeid

paired: True providers: 44
```

### 13.4 `POST /v1/send` always includes `dryRun: boolean`

Real send, dry run **off**, into the existing `goofy-falcon` workspace:

```
$ curl -s -X POST http://127.0.0.1:7788/v1/send -H 'Origin: chrome-extension://fakeid' \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":948,
         "prompt":"Say only the word ACK and stop.",
         "target":{"kind":"existing","workspaceId":"wks_e1f4a70c6b93d825"},
         "provider":"claude/claude-haiku-4-5"}'
HTTP 200
{
  "ok": true,
  "agentId": "b6c194d0-8e57-4f23-91a8-0d47b3562fce",
  "workspaceId": "wks_e1f4a70c6b93d825",
  "workspaceCreated": false,
  "workspaceLabel": "goofy-falcon",
  "branch": "giz-1132-retire-legacy-cache-flag",
  "deepLink": "paseo://h/srv_Ab3xY9pQ2mNt/agent/b6c194d0-8e57-4f23-91a8-0d47b3562fce",
  "title": "PR #948 · Say only the word ACK and stop.",
  "dryRun": false
}

ASSERT dryRun key present : True
ASSERT dryRun is boolean  : True
ASSERT dryRun is False    : True
```

Regression check that the rest of the send path is unchanged by the amendment:

```
$ paseo logs b6c194d0-8e57-4f23-91a8-0d47b3562fce
[User] [Sent from Graphite — github/acmegizmos/gizmo-poc PR #948]
Title: GIZ-1132: Legacy tally engine retirement #8 - Retire the legacy cache flag and gate the catalog seed
Branch: giz-1132-retire-legacy-cache-flag -> giz-1132-retire-legacy-era-levers
PR: https://github.com/acmegizmos/gizmo-poc/pull/948

Say only the word ACK and stop.
ACK

$ paseo inspect b6c194d0-8e57-4f23-91a8-0d47b3562fce --json
{
  "Id": "b6c194d0-8e57-4f23-91a8-0d47b3562fce",
  "Name": "PR #948 · Say only the word ACK and stop.",
  "Provider": "claude",
  "Model": "claude-haiku-4-5",
  "Status": "idle",
  "Cwd": "~/.paseo/worktrees/pj4k2wxb/goofy-falcon"
}

$ # labels, read from the daemon (paseo inspect does not print them)
labels     : {"send-to-paseo/pr":"github:acmegizmos/gizmo-poc#948","send-to-paseo/origin":"graphite"}
workspaceId: wks_e1f4a70c6b93d825
```

Header still byte-for-byte the contract's example (no `pageUrl` was sent), both
labels intact, correct workspace placement. Cleaned up:

```
$ paseo delete b6c194d0-8e57-4f23-91a8-0d47b3562fce
DELETED
1
$ paseo ls --json | grep -c e0537a35
0
```

`dryRun: true` on the dry-run path is unchanged and still verified in §6.

### 13.5 Clarifications — `prompt` length in Unicode code points

Three cases, chosen so that a naive UTF-16 `.length` and a byte-only cap each
give the wrong answer.

```
[case A] code points in prompt : 16001
[case A] UTF-16 code units     : 32002 (what a naive .length reports)
[case A] body bytes            : 64127 (under the 65536 cap, so the byte cap must NOT fire)
[case B] code points in prompt : 14000 (well inside the 16000 limit)
[case B] body bytes            : 84123 (over the 65536 cap)
[case C] code points in prompt : 16000 | body bytes: 64162
```

Case A — 16001 astral code points (U+1F600), body under the byte cap:

```
{"error":{"code":"bad_request","message":"A message may be at most 16000 characters; this one is 16001."}}
HTTP 400
```

The message says **16001**, not 32002, so the count is code points. And
`bad_request`, not `payload_too_large`, so the byte cap correctly did not fire.

Case B — 14000 code points (inside the limit) whose JSON body is 84123 bytes:

```
{"error":{"code":"payload_too_large","message":"The request body is larger than the 64 KiB limit."}}
HTTP 413
```

`payload_too_large`, not `bad_request`: the two limits are independent and the
byte cap wins, exactly as the Clarifications section requires.

Case C — exactly 16000 astral code points, aimed at a deliberately bogus
workspace so nothing is created:

```
{"error":{"code":"bad_request","message":"Workspace wks_does_not_exist is no longer available in acmegizmos/gizmo-poc.","hint":"Reopen the popover to refresh the workspace list."}}
HTTP 400
```

It got past the length rule and failed on the workspace instead, so the 16000
boundary is inclusive and measured in code points.

### 13.6 Clarifications — `error.message` is plain prose, commands in `hint`

Mechanical audit of every string literal in the server modules:

```
$ grep -nE '"[^"]*[`*][^"]*"' *.server.ts
no backticks or asterisks in any string literal
```

Every `hint` that carries a command carries it bare:

```
"Install it with: brew install gh"
"Run: gh auth login"
"Add it in Paseo, or run: paseo project add /path/to/<repo>"
"Check Settings -> Providers in Paseo."
"Copy the token from Paseo -> Send to Paseo into the extension options page."
"Valid paths are /v1/ping, /v1/resolve and /v1/send."
"Reopen the popover to refresh the workspace list."
```

### 13.7 Clarifications — rate limit keyed on `Origin`, else remote address

Exhaust the no-`Origin` bucket (keyed on the remote address), then show that an
extension origin has its own independent budget:

```
$ for i in $(seq 1 33); do curl -s -o /dev/null -w "%{http_code} " http://127.0.0.1:7788/v1/ping; done
200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200
200 200 200 200 200 200 200 200 200 200 429 429 429

$ for i in 1 2 3; do curl -s -o /dev/null -w "%{http_code} " http://127.0.0.1:7788/v1/ping -H 'Origin: chrome-extension://separatebucket'; done
200 200 200

$ curl -s http://127.0.0.1:7788/v1/ping        # no-Origin bucket still exhausted
{"error":{"code":"rate_limited","message":"Too many requests; slow down."}}
HTTP 429
```

30 then 429 on the address-keyed bucket, while the origin-keyed bucket is
untouched. A CLI flood cannot consume the extension's budget. (Run at the
original threshold of 30; [§14](#14-contract-amendment-rate-limit-raised-to-60-requests--10-s)
re-verifies the same keying at 60.)

### 13.8 Clarifications — `defaultCandidateIndex` always in range

```
$ # PR #948 (has an exact match)
defaultCandidateIndex 0 in range 0.. 37 : True
```

`candidates` always ends with the synthetic `create` entry, so the fallback index
`candidates.length - 1` is always valid; the code additionally clamps. §5 shows
the other branch: PR #942 has no exact match and returns index 37 of 38, which is
the `create` candidate.

### 13.9 Reload-hang check, re-run after the change

```
$ time paseo plugin reload send-to-paseo
PLUGIN                STATUS      ENABLED   DIRECTORY                                  ERROR
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
paseo plugin reload send-to-paseo 2>&1  0.67s user 0.07s system 88% cpu 0.834 total

$ time paseo plugin reload send-to-paseo
PLUGIN                STATUS      ENABLED   DIRECTORY                                  ERROR
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
paseo plugin reload send-to-paseo 2>&1  0.71s user 0.07s system 91% cpu 0.848 total

$ paseo plugin ls | grep send-to-paseo
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
```

Still under a second, twice in a row, still `running`.

### 13.10 Cleanup

The one agent created for §13.4 was deleted (shown above). Agent totals moved
85 → 86 between §11 and §13 from activity outside this task; the §13.4 send and
delete were net zero, confirmed by the `grep -c` above returning 0.

### 13.11 Final regression sweep

Every endpoint state in one pass, after all changes. Left column is the expected
status, right column is the observed one.

```
ping no auth                          -> 200   200
ping valid token                      -> 200   200
ping bad token                        -> 401   401
ping page origin                      -> 403   403
ping bad Host                         -> 403   403
OPTIONS preflight ext origin          -> 204   204
OPTIONS preflight page origin         -> 403   403
resolve valid                         -> 200   200
resolve no token                      -> 401   401
resolve bogus repo                    -> 404   404
resolve bogus PR                      -> 404   404
send empty prompt                     -> 400   400
send oversized body                   -> 413   413
unknown endpoint                      -> 400   400
wrong method on ping                  -> 400   400
```

15 of 15. Run with an `Origin: chrome-extension://finalsweep` header, because
§13.7 had deliberately exhausted the address-keyed rate-limit bucket.

---

## 14. Contract amendment: rate limit raised to 60 requests / 10 s

`RATE_LIMIT_MAX` 30 → 60, per the amended item 6 under "Origin and Host rules".
`GET /v1/ping` stays **counted** rather than exempt. Re-verified on 2026-09-01
against the installed plugin on port 7788.

### 14.1 Boundary: 60 through, the 61st is the first 429

62 requests on a fresh origin bucket:

```
1:200 2:200 3:200 4:200 5:200 6:200 7:200 8:200 9:200 10:200
11:200 12:200 13:200 14:200 15:200 16:200 17:200 18:200 19:200 20:200
21:200 22:200 23:200 24:200 25:200 26:200 27:200 28:200 29:200 30:200
31:200 32:200 33:200 34:200 35:200 36:200 37:200 38:200 39:200 40:200
41:200 42:200 43:200 44:200 45:200 46:200 47:200 48:200 49:200 50:200
51:200 52:200 53:200 54:200 55:200 56:200 57:200 58:200 59:200 60:200
61:429 62:429
```

Repeated on a second fresh bucket and tallied programmatically, so the boundary
is not eyeballed:

```
200 count      : 60
429 count      : 2
first 429 at #  : 61
ASSERT 60 through, 61st is the first 429: True
```

The old threshold of 30 no longer trips — requests 31..60 are `200`.

### 14.2 The 429 still carries `Retry-After` and the CORS echo

Headers of the 61st request inside the same window:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Content-Length: 75
Cache-Control: no-store
X-Content-Type-Options: nosniff
Vary: Origin
Access-Control-Allow-Origin: chrome-extension://rl60headers
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 600
Retry-After: 10
```

Body:

```
{"error":{"code":"rate_limited","message":"Too many requests; slow down."}}
```

### 14.3 The window still slides

```
immediately          : 429
after 11 s           : 200
```

The sliding window recovers on its own, without a timer in the subprocess.

### 14.4 Origin-vs-remote-address keying still holds at 60

Exhaust the **remote-address** bucket (62 requests with no `Origin`), then check
an extension origin:

```
no Origin after 62 (exhausted) : 429
fresh extension origin         : 200
```

And the reverse — with one origin bucket exhausted, other keys are unaffected:

```
same origin (exhausted)        : 429   (measured inside the window; see 14.2)
different extension origin     : 200
no Origin (remote-address key) : 200
```

A CLI flood still cannot consume the extension's budget, and one extension origin
cannot consume another's.

### 14.5 The traffic pattern the raise was for

The extension's `contract`-mismatch gate re-pings before every resolve and send,
uncached, so a completed send costs 4 requests. Simulated at 4 requests per cycle
inside a single 10 s window (the mutating `send` is stood in for by a second
`resolve`, because what is being measured is the request budget, not the side
effect — no agents were created):

```
  cycle 16: first non-200 -> 429
complete 4-request send cycles inside one 10 s window: 15
total 200s: 60 | total 429s: 4
ASSERT >= 15 send cycles fit (the reason for the raise): True
```

Exactly 15 complete sends per window, which is the figure the amendment targets.
At 30 it would have been 7.

### 14.6 Reload-hang check, re-run

```
$ time paseo plugin reload send-to-paseo
PLUGIN                STATUS      ENABLED   DIRECTORY                                  ERROR
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
paseo plugin reload send-to-paseo 2>&1  0.64s user 0.07s system 86% cpu 0.819 total

$ time paseo plugin reload send-to-paseo
PLUGIN                STATUS      ENABLED   DIRECTORY                                  ERROR
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
paseo plugin reload send-to-paseo 2>&1  0.73s user 0.08s system 91% cpu 0.875 total

$ paseo plugin ls | grep send-to-paseo
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
```

Still under a second, twice in a row, still `running`.

### 14.7 Typecheck and where the number lives

```
$ npm run typecheck

> send-to-paseo@0.1.0 typecheck
> tsc --noEmit
```

The threshold has exactly one definition, in `contracts.shared.ts`, so the bridge
and the docs cannot drift apart:

```
$ grep -rn "RATE_LIMIT_MAX" *.ts
contracts.shared.ts:26:export const RATE_LIMIT_MAX = 60;
bridge.server.ts:10:  RATE_LIMIT_MAX,
bridge.server.ts:89:  if (window.length >= RATE_LIMIT_MAX) {
```

### 14.8 Final regression sweep, post-change

```
ping no auth                    -> 200     200
ping valid token                -> 200     200
ping bad token                  -> 401     401
ping page origin                -> 403     403
ping bad Host                   -> 403     403
OPTIONS preflight ext origin    -> 204     204
OPTIONS preflight page origin   -> 403     403
resolve valid                   -> 200     200
resolve no token                -> 401     401
resolve bogus repo              -> 404     404
resolve bogus PR                -> 404     404
send empty prompt               -> 400     400
unknown endpoint                -> 400     400
wrong method on ping            -> 400     400
```

14 of 14 (the 413 case is covered in §13.5 case B and unaffected by this change).
Logs clean, zero token occurrences, no test agents left behind:

```
$ paseo plugin logs send-to-paseo | grep -c "$TOKEN"
0
$ paseo ls --json | grep -c "Say only the word ACK"
0
```

---

## 16. Dependency audit and graceful degradation (2026-09-01)

Motivating question: what does this plugin actually require, and what does a user
with no `gh` see? Answer before this change: an opaque `502` and an unusable
popover. Answer after: a working popover, a working send, and a named reason.

### 16.1 The complete external-dependency list

Found by grepping for every spawn and every absolute path in `plugin/`:

```
$ grep -n "execFile\|spawn\|exec(\|execSync\|child_process\|/usr/\|/opt/\|/bin/" *.ts *.tsx
```

| Dependency | How it is reached | Required? | Blast radius when absent |
| --- | --- | --- | --- |
| `git` | `execFile`, argv array, no shell (`git.server.ts`) | yes | `create` target fails with a message naming `git`; branch reads return null so ranking collapses to rank 3 + create |
| `gh` | `execFile`, argv array, no shell (`gh.server.ts`) | **no** | PR title, branch names and stack detection only |
| Paseo daemon WebSocket `ws://127.0.0.1:6767/ws` | `@getpaseo/client`, borrowed from the host at runtime | yes | `503 daemon_unreachable` |
| Paseo daemon HTTP `/api/status` | `fetch` | yes for `send` | no `serverId`, so no deep link → `503` |
| `@getpaseo/client` from the host | `require` assembled at runtime | yes | `503 daemon_unreachable` with an explicit "this host does not expose its client SDK" |
| `@getpaseo/protocol/agent-deep-link` | static import | yes | plugin fails to load |
| github.com, via `gh` | — | no | degrades exactly like a missing `gh` |

No other process is ever spawned. There is no `which`, no `sh -c`, no shell
anywhere, and no hard-coded absolute binary path outside the well-known-location
list in `deps.server.ts`.

**Timeouts — every spawn is bounded.** Checked exhaustively; none were missing.

```
$ grep -n "TIMEOUT_MS\|timeoutMs" *.ts | grep -v paseo-plugin.d.ts
deps.server.ts:  PROBE_TIMEOUT_MS 5_000      gh/git --version
deps.server.ts:  AUTH_TIMEOUT_MS  8_000      gh auth status
deps.server.ts:  EXEC_TIMEOUT_MS  5_000      runProcess default (all git reads)
gh.server.ts:    PR_TIMEOUT_MS    15_000     gh pr view
gh.server.ts:    STACK_TIMEOUT_MS 8_000      gh pr view for a sibling
gh.server.ts:    STACK_LIST_TIMEOUT_MS 12_000  gh pr list
daemon.server.ts: CONNECT_TIMEOUT_MS 10_000  SDK connect
daemon.server.ts: STATUS_TIMEOUT_MS  2_000   /api/status fetch
send.server.ts:  WORKSPACE_READY_TIMEOUT_MS 60_000  worktree readiness poll
```

### 16.2 The `PATH` question, measured

The concern was real in principle and **not currently manifesting** on this
machine, because Paseo `0.7.0` enriches the environment it gives plugin
subprocesses. Both values, measured rather than assumed:

```
$ echo $PATH                       # interactive zsh
~/.local/bin:~/Library/pnpm:/opt/homebrew/opt/postgresql@17/bin:...:/opt/homebrew/bin:/opt/homebrew/sbin:...:/usr/local/bin:...:/usr/bin:/bin:/usr/sbin:/sbin:...

$ paseo plugin logs send-to-paseo | tail -1
[send-to-paseo] plugin subprocess PATH=~/.local/bin:~/Library/pnpm:/opt/homebrew/opt/postgresql@17/bin:...:/opt/homebrew/bin:/opt/homebrew/sbin:...:/usr/local/bin:...:/usr/bin:/bin:/usr/sbin:/sbin:...
```

Identical (the interactive one additionally carries a Claude Code plugin path
that the shell itself appends). So the plugin subprocess *does* get the login
`PATH` today.

The latent bug is one process up. `/Applications/Paseo.app` is launched by
launchd (`ppid 1`) and its own environment has no Homebrew at all:

```
$ ps -Ao pid,ppid,command | grep -i paseo
 2809     1 /Applications/Paseo.app/Contents/MacOS/Paseo
 3073  2809 Paseo Supervisor
 3074  3073 Paseo Daemon
95890  3074 .../plugin-process.js

$ ps eww -p 2809 | tr ' ' '\n' | grep '^PATH='
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin
```

`/opt/homebrew/bin` is missing there. So the moment Paseo's `PATH` enrichment is
absent, fails, or is not implemented — an older or newer host, a Linux daemon
under systemd, a `launchctl`-managed daemon — an Apple-silicon Homebrew `gh`
becomes invisible while working perfectly in the user's terminal. That is the
exact scenario the well-known-location probe now covers, and it is verified
against precisely that launchd `PATH`:

```
2. launchd PATH (what /Applications/Paseo.app itself has: no /opt/homebrew/bin)
  gh  resolves to         /opt/homebrew/bin/gh
  git resolves to         /usr/bin/git
  ok   gh is still found without /opt/homebrew/bin on PATH
  ok   git is still found
```

### 16.3 Startup self-check

Three lines, once per plugin start, to `paseo plugin logs send-to-paseo`:

```
$ paseo plugin reload send-to-paseo && paseo plugin logs send-to-paseo | tail -4
[send-to-paseo] bridge listening on http://127.0.0.1:7788
[send-to-paseo] dependency git: ok — git version 2.51.2 at /opt/homebrew/bin/git
[send-to-paseo] dependency gh: ok — gh version 2.98.0 (2026-08-20) at /opt/homebrew/bin/gh
[send-to-paseo] plugin subprocess PATH=~/.local/bin:...
```

And with nothing installed (from §16.5's out-of-band instance):

```
[send-to-paseo] dependency git: missing (REQUIRED) — git was not found. Paseo cannot create a worktree for a pull request without it, and workspace branches cannot be read. Install git: xcode-select --install
[send-to-paseo] dependency gh: missing (optional) — The GitHub CLI (gh) was not found. Sending still works: Paseo checks the PR out itself. Only the PR title, branch names and stack detection are unavailable. Install the GitHub CLI: brew install gh
[send-to-paseo] plugin subprocess PATH=/nonexistent-x
```

Cost of the self-check: `bridge listening` at `10:52:42.390`, all three lines at
`10:52:42.977` — **587 ms**, off the request path, and not awaited by startup.

No credentials are logged. `gh auth status` output is discarded entirely (only
its exit status is used) precisely because it can echo a token:

```
$ paseo plugin logs send-to-paseo | grep -c "$TOKEN"
0
```

### 16.4 `check-deps.mjs` — simulated missing / broken `gh`

`plugin/check-deps.mjs` runs the real server modules against a doctored `PATH`
and against fake `gh` executables written to a temp directory that it removes.
**It never touches `~/.config/gh`, never runs `gh auth logout`, and never reads
the user's credential.**

```
$ cd plugin && node check-deps.mjs
...
45/45 checks passed
```

<details><summary>full output (45/45)</summary>

```
1. the PATH a Paseo plugin subprocess actually gets
  git resolves to         /opt/homebrew/bin/git
  gh  resolves to         /opt/homebrew/bin/gh

2. launchd PATH (what /Applications/Paseo.app itself has: no /opt/homebrew/bin)
  gh  resolves to         /opt/homebrew/bin/gh
  git resolves to         /usr/bin/git
  ok   gh is still found without /opt/homebrew/bin on PATH
  ok   git is still found

3. gh not installed at all (empty PATH, probe switched off)
  ok   findGh returns null
  report   {"name":"gh","required":false,"state":"missing","path":null,"version":null,"detail":"The GitHub CLI (gh) was not found. Sending still works: Paseo checks the PR out itself. Only the PR title, branch names and stack detection are unavailable.","hint":"Install the GitHub CLI: brew install gh"}
  ok   gh is reported optional
  ok   gh state is missing
  ok   detail says sending still works
  ok   hint is an install command
  outage   {"kind":"missing","message":"The GitHub CLI (gh) is not installed, so the pull request title, branches and stack could not be read. Sending still works.","hint":"Install the GitHub CLI: brew install gh","short":"gh not installed"}
  pr       {"number":942,"title":"PR #942","headBranch":"","baseBranch":"","state":"UNKNOWN","url":"https://github.com/acmegizmos/gizmo-poc/pull/942"}
  ok   lookupPr degrades instead of throwing
  ok   outage kind is missing
  ok   message names gh
  ok   short label is picker-sized
  ok   url is still correct
  ok   head branch is empty, not guessed
  --- composed prompt ---
[Sent from Graphite — github/acmegizmos/gizmo-poc PR #942]
PR: https://github.com/acmegizmos/gizmo-poc/pull/942
Workspace branch: giz-1132-retire-legacy-cache-flag
Note: the pull request title and branch names are missing from this header because gh not installed. Read them from the PR URL above if you need them.

Fix the merge conflicts
  -----------------------
  ok   prompt omits the Title: line
  ok   prompt omits the Branch: line
  ok   prompt keeps the PR: line
  ok   prompt explains the gap
  ok   prompt makes no claim about the PR's branch
  git      workspace_create_failed / git was not found on this machine, and Paseo needs it to check a pull request out into a worktree. / Install git: xcode-select --install
  ok   requireGit throws with git missing
  ok   code is a documented one
  ok   message names git
  ok   hint is an install command

4. gh installed but not signed in (fake gh, exit 4)
  report   {"name":"gh","required":false,"state":"degraded","path":"/var/folders/.../unauth/gh","version":"gh version 2.98.0 (2026-08-20)","detail":"gh is installed but not signed in to GitHub. Sending still works; PR titles, branch names and stack detection are unavailable until it is.","hint":"Run: gh auth login"}
  ok   gh is found
  ok   version is still read
  ok   state is degraded, not missing
  ok   detail says not signed in
  ok   hint is the exact fix
  outage   {"kind":"unauthenticated","message":"The GitHub CLI (gh) is installed but not signed in to GitHub, so acmegizmos/gizmo-poc#942 could not be read. Sending still works.","hint":"Run: gh auth login","short":"gh not signed in — run gh auth login"}
  ok   degrades rather than throwing
  ok   kind is unauthenticated
  ok   hint is the exact fix
  ok   message is distinct from not-installed

5. gh present, github.com unreachable (fake gh, DNS failure)
  outage   {"kind":"network","message":"The GitHub CLI (gh) could not reach github.com while reading acmegizmos/gizmo-poc#942.","hint":"Check your network connection, then try again.","short":"github.com unreachable"}
  ok   degrades rather than throwing
  ok   kind is network
  ok   does not read as not-installed

6. gh present, repository invisible to it (fake gh, GraphQL 404)
  outage   {"kind":"no_repo_access","message":"The GitHub account gh is signed in as cannot see acmegizmos/gizmo-poc, so acmegizmos/gizmo-poc#942 could not be read. Sending still works.","hint":"Check access with: gh auth status","short":"gh cannot see this repo"}
  ok   degrades rather than throwing
  ok   kind is no_repo_access
  ok   hint points at gh auth status

7. gh present, the PR number does not exist (the one hard error)
  thrown   pr_not_found / Pull request acmegizmos/gizmo-poc#942 does not exist on GitHub.
  ok   this one does NOT degrade
  ok   code is pr_not_found
  ok   message names the PR

8. every spawn is bounded (a hung gh must not hold the bridge)
  snapshot took 5004ms, gh state degraded
  ok   the hung probe was killed, not waited on
  ok   gh is reported unusable
  ok   detail says it did not run

9. the surface payload validates against its own RPC schema
  parsed   ok
  ok   dependencies match DependencyReportSchema
  ok   both dependencies are reported

45/45 checks passed
```

</details>

Two findings worth keeping:

**Emptying `PATH` is not enough to hide `gh`.** The first run of §3 failed with
`FAIL findGh returns null — /opt/homebrew/bin/gh`: the well-known-location probe
found it anyway. That is the feature working, and it is why
`SEND_TO_PASEO_BIN_DIRS` exists — the test needs a way to say "nowhere".

**`unref` does not defeat a spawn timeout, as long as something else holds the
event loop open.** The self-check unrefs its children so a probe in flight cannot
wedge plugin teardown. Measured directly:

```
# child unref'd, nothing else holding the loop
$ node t.mjs
Warning: Detected unsettled top-level await ...       # process exits, promise never settles

# child unref'd, a setInterval standing in for the bridge's listening socket
$ node t3.mjs
rejected after 3004 ms | code: null killed: true signal: SIGTERM
```

So in the running plugin the timeout always fires (§8 above: 5004 ms for a 5000
ms probe against a `/bin/sleep 60` fake), and during teardown the process is free
to exit. Both behaviours are the wanted ones.

### 16.5 Degraded resolve and send over a real bridge

`SEND_TO_PASEO_DRY_RUN` and `PATH` are inherited from the daemon and cannot be
changed for the installed plugin without a daemon restart, which is forbidden. So
this ran a **second instance** of the same `bridge.server.ts` out of band: port
`7799`, `PASEO_HOME` pointed at a temp directory (its own token, its own send
history — the real `settings.json` was never touched), talking to the same live
daemon, with `PATH=/nonexistent-x SEND_TO_PASEO_BIN_DIRS=/nonexistent-x`.

`POST /v1/resolve`, no `gh` and no `git`:

```
HTTP 200
pr         {"number":942,"title":"PR #942","headBranch":"","baseBranch":"","state":"UNKNOWN","url":"https://github.com/acmegizmos/gizmo-poc/pull/942"}
project    {"projectId":"remote:github.com/acmegizmos/gizmo-poc","name":"acmegizmos/gizmo-poc","path":"~/Projects/gizmo-poc"}
candidates 38 default 37
create     {"kind":"create","label":"Create worktree for PR #942 (gh not installed)","branch":"","rank":4,"reason":"create"}
default is {"kind":"create","label":"Create worktree for PR #942 (gh not installed)","branch":"","rank":4,"reason":"create"}
```

Note the candidates still carry real branch names even with `git` missing: the
branch normally comes from the daemon's workspace descriptor, and `git` is only
the fallback. `defaultCandidateIndex` correctly points at `create`, which is in
range, as CONTRACT.md requires.

`POST /v1/send` on the same instance with `SEND_TO_PASEO_DRY_RUN=1`, both target
kinds. **No agents were created anywhere** — dry run, separate instance, temp
`PASEO_HOME`:

```
--- send, target create (dry run, no gh) ---
[200,{"ok":true,"agentId":"agt_dryrun_5a09f3d2e816","workspaceId":"wks_dryrun_6d0b4a71fc82","workspaceCreated":true,"workspaceLabel":"Create worktree for PR #942","branch":null,"deepLink":"paseo://h/srv_Ab3xY9pQ2mNt/agent/agt_dryrun_5a09f3d2e816","title":"PR #942 · Fix merge conflicts","dryRun":true}]
--- send, target existing (dry run, no gh) ---
[200,{"ok":true,"agentId":"agt_dryrun_c74b1e58390a","workspaceId":"wks_4d1a8b7c2e0f9351","workspaceCreated":false,"workspaceLabel":"brawny-dodo","branch":"giz-1114-document-the-graphite-and-mcp-setup-for-us-all","deepLink":"paseo://h/srv_Ab3xY9pQ2mNt/agent/agt_dryrun_c74b1e58390a","title":"PR #942 · Fix merge conflicts","dryRun":true}]
```

The real `POST /v1/send` with `target: {kind:"create"}` and no `gh` was **not**
fired, because it would start an agent. Reasoned instead, and the reasoning is
mechanical: the only `gh`-derived value on that path is `pr.title`, used solely
for the workspace title (degraded to `PR #942`), and `pr.headBranch`, which the
`create` path never passes to Paseo — the checkout is
`checkoutSource: { kind: "change_request", forge, number }`, built from the PR
number alone. §8 of this document is the recorded evidence that that call works.

Temp directories and the out-of-band scripts were removed afterwards; no stub
file is left in `plugin/`.

### 16.6 Timings

| | cold | warm |
| --- | --- | --- |
| `POST /v1/resolve`, `gh` present | 0.890 s / 1.03 s | 0.0073 s, 0.0070 s |
| `POST /v1/resolve`, no `gh` at all | 199 ms | 12 ms, 11 ms |
| dependency self-check | 587 ms | cached 60 s |
| `paseo plugin reload send-to-paseo` | 0.927 s | 0.962 s (second consecutive run — no reload hang) |

Degraded resolve is *faster*, which is expected: it makes no GitHub round trips.

### 16.7 Regression sweep, post-change

```
ping no auth                     -> 200
ping valid token                 -> 200
ping bad token                   -> 401
ping page origin                 -> 403
ping bad Host                    -> 403
OPTIONS preflight ext origin     -> 204
OPTIONS preflight page origin    -> 403
resolve valid                    -> 200
resolve no token                 -> 401
resolve bogus repo               -> 404
resolve bogus PR                 -> 404
send empty prompt                -> 400
unknown endpoint                 -> 400
wrong method on ping             -> 400
```

14 of 14 unchanged. `pr_not_found` still carries a `hint` and a message naming
the PR, with the reworded text:

```
{"error":{"code":"pr_not_found","message":"Pull request acmegizmos/gizmo-poc#9999999 does not exist on GitHub.","hint":"Check the pull request number."}}
```

```
$ cd plugin && npm run typecheck
> tsc --noEmit
$ paseo plugin ls | grep send-to-paseo
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin
$ paseo plugin logs send-to-paseo | grep -c "$TOKEN"
0
```

### 16.8 No wire-shape change, and where the contract falls short

CONTRACT.md is untouched and `contract` stays at `1`. Everything above is
behaviour: existing error codes with better messages, different *values* in
existing fields, and prompt text (which CONTRACT.md itself calls behaviour, not
wire shape). No error code was added; `forge_unauthenticated` and `pr_not_found`
were reused, and `git`-missing reuses `workspace_create_failed`.

**The gap.** There is no field in `/v1/resolve` for a notice, and the popover
renders almost none of the `pr` object — not `pr.title`, not `pr.state`. The only
free-text string the bridge controls *and* the popover displays is a candidate's
`label`, so the degraded notice rides in the `create` candidate's label
(`Create worktree for PR #942 (gh not installed)`), plus the agent's prompt and
the plugin log. That works, but it is a workaround:

- the notice is only visible while the `create` candidate is *selected in the
  dropdown*, not when the user picks an existing workspace;
- ~~with `pr.headBranch` empty, the popover's "worktree is on another branch of
  this stack" hint fires for every existing candidate, because the extension has
  no way to tell "a different branch" from "branch unknown".~~ **Fixed
  2026-09-01** in the permission-mode pass: the popover now requires
  `resolved.pr.headBranch` to be non-empty before rendering that note — unknown
  is not "different". Regression test `20c` in `test/e2e.mjs`, with a
  non-degraded control half so it cannot pass vacuously. No contract change was
  needed; the extension already had the information, it just was not looking at
  it.

A first-class fix wants one additive field, e.g.
`notices?: { level: "warning"; message: string; hint?: string }[]` on the resolve
response — which CONTRACT.md's "Additive fields" clarification already permits
without bumping `contract`, but which the extension would have to learn to
render. **Not added here**, since that is a coordinated change across both halves
and this pass was scoped to `plugin/`.

---

## 17. Permission modes and agent profiles (2026-09-01)

### 17.1 The bug, measured before the change

The plugin sent `config: { provider }` and nothing else. Claude's provider then
does `this.currentMode = isPermissionMode(config.modeId) ? config.modeId : "default"`,
and `"default"` is the app's **"Always Ask"** — so every agent this plugin created
came up in the strictest mode, while `paseo provider ls --json` already reported
`"defaultMode": "auto"` for this user, and app-created agents in the same worktrees
carry `modeId: 'auto'`.

Captured against the **live daemon** through a second, out-of-band instance of
`bridge.server.ts` (§17.5) with `agents.create` intercepted, so **no agent was
created**:

```
### BEFORE
agents.create config: {"provider": "claude/claude-opus-5"}
```

And `POST /v1/resolve` on the installed bridge, before:

```
keys: ['candidates', 'defaultCandidateIndex', 'pr', 'project', 'providers']
modes: <ABSENT>
resolvedModeId: <ABSENT>
```

### 17.2 What the daemon actually advertises

Read from the live daemon via `providers.snapshot()`, not from documentation:

```
claude    defaultModeId "auto"
          plan              Plan Mode          colorTier planning
          default           Always Ask         colorTier safe
          acceptEdits       Accept File Edits  colorTier moderate
          auto              Auto mode          colorTier moderate
          bypassPermissions Bypass             colorTier dangerous
codex     defaultModeId "auto-review"
          auto              Default Permissions  moderate
          auto-review       Auto-review          moderate
          full-access       Full Access          dangerous
opencode  defaultModeId null
          build  Build  moderate      plan  Plan  planning
```

Two findings that shaped the implementation:

- **`AgentMode` on the snapshot has no `isUnattended`.** It carries `colorTier`;
  only the *static* provider manifest (`@getpaseo/protocol/provider-manifest`)
  carries `isUnattended`. Rather than import a second source of truth that can
  drift from the daemon, `isUnattended` is derived from
  `colorTier === "dangerous"`. Checked against the manifest's own
  `getUnattendedModeId()`, the two agree exactly for every ready provider:

  ```
  $ node -e "const m=require('@getpaseo/protocol/provider-manifest');
             console.log(m.getUnattendedModeId('claude'),
                         m.getUnattendedModeId('codex'),
                         m.getUnattendedModeId('opencode'))"
  bypassPermissions full-access undefined
  ```

- **`paseo provider ls --json` and the snapshot disagree for OpenCode**: the CLI
  prints `"defaultMode": "default"`, the snapshot returns `defaultModeId: null`.
  The chain uses the snapshot, and `null` correctly means "fall through to
  omitting the field".

The user's saved profiles, read live from `daemon.agentProfiles`:

```
Sonnet 5  claude/claude-sonnet-5
Fable 5   claude/claude-fable-5   modeId auto   thinkingOptionId low
Opus 5    claude/claude-opus-5
```

### 17.3 `POST /v1/resolve` after the change — live bridge on 7788

```
$ paseo plugin reload send-to-paseo && paseo plugin ls
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin

$ curl -s -X POST http://127.0.0.1:7788/v1/resolve -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"forge":"github","owner":"acmegizmos","repo":"gizmo-poc","number":942}'
keys: ['candidates', 'defaultCandidateIndex', 'modes', 'pr', 'project', 'providers', 'resolvedModeId']
resolvedModeId: "auto"
modes:
   {"provider": "claude", "id": "plan", "label": "Plan Mode", "isDefault": false, "colorTier": "planning"}
   {"provider": "claude", "id": "default", "label": "Always Ask", "isDefault": false, "colorTier": "safe"}
   {"provider": "claude", "id": "acceptEdits", "label": "Accept File Edits", "isDefault": false, "colorTier": "moderate"}
   {"provider": "claude", "id": "auto", "label": "Auto mode", "isDefault": true, "colorTier": "moderate"}
   {"provider": "claude", "id": "bypassPermissions", "label": "Bypass", "isDefault": false, "isUnattended": true, "colorTier": "dangerous"}
   {"provider": "codex", "id": "auto", "label": "Default Permissions", "isDefault": false, "colorTier": "moderate"}
   {"provider": "codex", "id": "auto-review", "label": "Auto-review", "isDefault": true, "colorTier": "moderate"}
   {"provider": "codex", "id": "full-access", "label": "Full Access", "isDefault": false, "isUnattended": true, "colorTier": "dangerous"}
   {"provider": "opencode", "id": "build", "label": "Build", "isDefault": false, "colorTier": "moderate"}
   {"provider": "opencode", "id": "plan", "label": "Plan", "isDefault": false, "colorTier": "planning"}
default provider: ['claude/claude-opus-5']
```

**`resolvedModeId` is now `auto`, where it was previously absent and the effective
mode was `default` ("Always Ask").**

The installed plugin's `settings.json` was **not** rewritten by the upgrade —
`defaultProfileId` and `defaultModeId` parse with a schema default of `null`, so
the file still validates and the pairing token survived:

```
{ "version": 1, "token": "<elided>", "port": 7788,
  "defaultProvider": "claude/claude-opus-5",
  "paired": true, "recentSends": "<11 rows>", "allowedExtensionIds": [] }
```

That default is load-bearing: a failed parse regenerates the file, and the file
holds the token, so a required field here would have silently unpaired the
extension on upgrade.

### 17.4 Logs after reload

```
$ paseo plugin logs send-to-paseo | tail
[paseo] Stopping plugin
[send-to-paseo] bridge stopped
[paseo] Plugin stopped
[paseo] Loading plugin
[paseo] Plugin ready
[send-to-paseo] bridge listening on http://127.0.0.1:7788
[send-to-paseo] dependency git: ok — git version 2.51.2 at /opt/homebrew/bin/git
[send-to-paseo] dependency gh: ok — gh version 2.98.0 (2026-08-20) at /opt/homebrew/bin/gh
```

No error, no reload hang, `paseo plugin ls` → `running`. The daemon was never
restarted.

### 17.5 `agents.create` payloads, measured — and no agent created

`SEND_TO_PASEO_DRY_RUN` is inherited from the daemon and cannot be changed for the
installed plugin without a daemon restart, which is forbidden; and dry run would
skip `agents.create` entirely, which is precisely the call under test. So this used
the technique from §16.5: a **second, out-of-band instance of the same
`bridge.server.ts`**, on its own port, with its own `PASEO_HOME` in a temp
directory (its own token and send history — the real `settings.json` was never
touched), talking to the same live daemon — plus one addition: a module-resolution
hook points `@getpaseo/client` at a shim that wraps `createPaseoClient` so that
`workspaces.ref(...).agents.create(...)` **records its argument and returns a
synthetic id instead of reaching the daemon**, and `workspaces.create` throws.

Every row below is the real `config` object the plugin handed to `agents.create`,
against the live daemon, with `target: {kind:"existing", workspaceId:
"wks_4d1a8b7c2e0f9351"}`:

| # | Configuration | `config` sent to `agents.create` |
| --- | --- | --- |
| — | **BEFORE the change** | `{"provider": "claude/claude-opus-5"}` |
| A | no profile, no mode setting | `{"provider": "claude/claude-opus-5", "modeId": "auto"}` |
| B | follow the `Fable 5` profile | `{"provider": "claude/claude-fable-5", "modeId": "auto", "thinkingOptionId": "low"}` |
| C | B + request `modeId: "bypassPermissions"` | `{"provider": "claude/claude-fable-5", "modeId": "bypassPermissions", "thinkingOptionId": "low"}` |
| D | stored `defaultModeId: "not-a-real-mode"` | `{"provider": "claude/claude-opus-5", "modeId": "auto"}` |
| E | `defaultProfileId` that no longer exists | `{"provider": "claude/claude-opus-5", "modeId": "auto"}` |
| F | B + request `provider: "codex/gpt-5.1-codex"` | `{"provider": "codex/gpt-5.1-codex", "modeId": "auto"}` |
| G | stored `defaultModeId: "bypassPermissions"` + request `provider: "codex/gpt-5.1-codex"` | `{"provider": "codex/gpt-5.1-codex", "modeId": "auto-review"}` |
| H | request `modeId: "full-access"` (a Codex id) against Claude | `{"provider": "claude/claude-opus-5", "modeId": "auto"}` |

Every one returned `HTTP 200`. The log lines for the fall-through cases:

```
D: [send-to-paseo] mode "not-a-real-mode" from the plugin's default mode setting is not offered by claude; trying the next option
   [send-to-paseo] sent PR #942 to brawny-dodo (agent …, provider claude/claude-opus-5, mode auto)
E: [send-to-paseo] agent profile legacy_favorite:deleted:gone no longer exists in Paseo; ignoring it
   [send-to-paseo] sent PR #942 to brawny-dodo (agent …, provider claude/claude-opus-5, mode auto)
G: [send-to-paseo] mode "bypassPermissions" from the plugin's default mode setting is not offered by codex; trying the next option
   [send-to-paseo] sent PR #942 to brawny-dodo (agent …, provider codex/gpt-5.1-codex, mode auto-review)
H: [send-to-paseo] mode "full-access" from the request is not offered by claude; trying the next option
   [send-to-paseo] sent PR #942 to brawny-dodo (agent …, provider claude/claude-opus-5, mode auto)
```

What each row proves:

- **A** — the whole point: the mode is now sent, and it is the user's `auto`, not
  `default`.
- **B** — a followed profile supplies provider, model, mode *and* thinking option,
  read live from `daemon.agentProfiles`.
- **C** — the request's explicit `modeId` beats the profile's, and an unattended
  mode really can be chosen.
- **D**, **G** — a stored mode the provider does not advertise falls through with a
  log line. It never becomes `agent_create_failed`.
- **E** — a deleted profile falls through the same way.
- **H** — even the *request's* own `modeId` is validated. A popover left open across
  a provider change, or an extension a version behind, cannot poison every send.
- **F** — the popover's explicit provider beats the profile's provider, and the
  profile's `thinkingOptionId` is correctly **dropped**, because the send no longer
  landed on that profile's model.

**No agent was created at any point.** Confirmed afterwards:

```
$ paseo agent ls --json | (count agents whose title matches the probe)
total agents: 89
agents matching the probe title: 0
```

The out-of-band instance was stopped and no stray listener remains:

```
$ lsof -nP -iTCP -sTCP:LISTEN | grep ':78..'
Paseo  28596 jdoe  17u  IPv4  TCP 127.0.0.1:7788 (LISTEN)
```

### 17.6 Surface payload shapes, validated against their own schemas

Run against the live daemon through the same out-of-band harness, because the
Paseo app itself was not driven in this pass:

```
modes     ok (10)
profiles  ok (3) ["Sonnet 5","Fable 5","Opus 5"]
providers ok (44) default=claude/claude-opus-5
defaultModeOf [["claude","auto"],["codex","auto-review"]]
legacy history row ok, modeId defaulted to null
```

`modes` parsed by `ModeOptionSchema.array()`, `profiles` by
`AgentProfileOptionSchema.array()`, `providers` by `ProviderOptionSchema.array()`
— the same schemas the `send-to-paseo.status` RPC declares as its output. Note
`defaultModeOf` has no `opencode` entry: its `defaultModeId` is `null`, so step 4
of the chain correctly contributes nothing for it.

The last line is the compatibility check that matters most: a `recentSends` row
written **before** `modeId` existed still parses, and `modeId` defaults to `null`
rather than failing validation and taking the pairing token with it.

### 17.7 Note on per-provider mode ids

Row **F** is worth reading twice. The `Fable 5` profile carries `modeId: "auto"`,
the request chose Codex, and `auto` **is** a valid Codex mode id — but it is Codex's
"Default Permissions", not Claude's "Auto mode". Validation passes because the
provider genuinely advertises the id; the plugin has no basis to decide that a
string valid for the target provider is "the wrong one". This is inherent to mode
ids being per-provider namespaces that happen to share strings, and it is why the
popover re-picks the mode from scratch on a provider change rather than carrying
the old selection over.

### 17.8 Regression sweep

```
$ cd plugin && npm run typecheck
> tsc --noEmit                                   # clean

$ cd extension && npm run typecheck
> tsc -p tsconfig.json                           # clean

$ node plugin/check-deps.mjs | tail -1
45/45 checks passed

$ cd extension && npm run build && npm run build:test && node ../test/e2e.mjs | tail -1
=== 44 passed, 0 failed, 0 skipped (of 44) ===
```

`contract` stays at **1**. Everything added is additive — `modes` and
`resolvedModeId` on responses, `modeId` on the `/v1/send` request — and
CONTRACT.md's "Additive fields" clause was amended in the same change to say so
explicitly for **requests** as well as responses, with the mechanism spelled out:
`SendRequestSchema` extends a non-strict `z.object`, so an older plugin strips an
unknown request field instead of returning `400`. The failure mode is "silently
ignored", not "hard break".

### 17.9 What was not verified

- **No real agent was started with a non-default mode.** Everything above stops at
  the `agents.create` payload. That the daemon honours `config.modeId` is Paseo's
  own behaviour, evidenced by app-created agents persisting `modeId: 'auto'`; it is
  not re-proved here, because proving it means creating an agent.
- **The surface's new Profile and Default-permission-mode cards were typechecked
  and follow the existing `ProviderPicker` structure and theming rules, but were
  not screenshotted in the Paseo app** — the app was not driven in this pass.
- **OpenCode and the disabled providers** (`copilot`, `pi`, `omp`) were not
  exercised end to end; OpenCode's `defaultModeId: null` path is covered only by
  reading the snapshot, not by a send.

---

## 18. `paseo plugin add` from Git: the no-`node_modules` build (2026-09-01)

### 18.1 The failure, reproduced

Installing the plugin the way a new user installs it — from the public
repository, with no clone and no `npm install` — did not work at all:

```
$ paseo plugin add tomgrin10/send-to-paseo --path plugin --id stp-relverify
Error: Request failed: Build failed with 1 error:
  ~/.paseo/plugins/stp-relverify/<rev>/checkout/plugin/send.server.ts:8:35:
    ERROR: Could not resolve "@getpaseo/protocol/agent-deep-link"
```

Nothing was wrong with the code as *code*. `npm run typecheck` was clean,
`node check-deps.mjs` was 45/45, and `paseo plugin reload send-to-paseo` from the
checkout was green — because the checkout has a `plugin/node_modules/` from an
earlier `npm install`, and that is what the daemon's bundler was resolving
`@getpaseo/protocol` out of. The Git path has no `node_modules`, so the same
source failed for every user while passing every local check.

### 18.2 What the host actually provides

From the Paseo source, `packages/server/src/server/plugins/plugin-sdk-specifiers.ts`
(Paseo `0.7.0`):

```ts
export const PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS = [
  "@getpaseo/plugin/react-native",
  "@paseo/plugin/react-native",
] as const;

export const PLUGIN_SDK_SPECIFIERS = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@paseo/plugin",
  "@paseo/plugin/server",
  ...PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
] as const;
```

and `packages/server/src/server/plugins/compiler.ts`, which compiles two bundles
per plugin and marks exactly this much external:

```ts
external:
  target === "client"
    ? [...PLUGIN_SDK_SPECIFIERS, "@tanstack/react-query", "react",
       "react/jsx-runtime", "react-native", "zod"]
    : [...PLUGIN_SDK_SPECIFIERS, "zod"],
```

The server bundle does not list `react`/`react-native`/`@tanstack/react-query`
because a separate esbuild plugin (`createUnusedPlatformModulePlugin`) replaces
them with `module.exports = {}` there, and does the same for `node:*` in the
client bundle. Anything not named above must resolve from disk — and on the Git
path there is no disk to resolve it from.

Two consequences worth recording, because both contradict a reasonable guess:

- **`@getpaseo/plugin/react-native` *is* host-provided.** It is in
  `PLUGIN_SDK_SPECIFIERS` (via the client-only list) and external for both
  targets, so `settings.client.tsx`'s `import { useToast } from
  "@getpaseo/plugin/react-native"` is legitimate and was left alone. It is absent
  from the shortlist in the public plugin docs; the source is authoritative.
- **`@getpaseo/client` and `@getpaseo/protocol` are *not* host-provided to the
  bundler**, even though the daemon obviously has them. They are reachable only
  at runtime, from inside the plugin subprocess.

### 18.3 The import audit, and what changed

Every non-host specifier in `plugin/*.ts` / `*.tsx`:

| Specifier | Where | Kind | Action |
| --- | --- | --- | --- |
| `@getpaseo/protocol/agent-deep-link` | `send.server.ts:8` | **value** (`buildAgentDeepLink`) | **Reimplemented locally** in `contracts.shared.ts`; the import is gone. |
| `@getpaseo/client` | `daemon.server.ts:5` | `import type { PaseoApi }` | Already erased — no change. |
| `@getpaseo/client` | `daemon.server.ts` (`type ClientModule = typeof import(...)`) | type position | Already erased — no change. |
| `@getpaseo/client` | `send.server.ts:2` | `import type { PaseoAgentConfig, PaseoApi, PaseoWorkspace, PaseoWorkspaceHandle }` | Already erased — no change. |
| `@getpaseo/client` | `resolve.server.ts:1` | `import type { PaseoApi, PaseoWorkspace }` | Already erased — no change. |
| `@getpaseo/client` | `daemon.server.ts` `loadClientModule()` | **deliberate runtime borrow** | Unchanged. `["@getpaseo","client"].join("/")` then `require`, so esbuild cannot see a literal specifier. This is load-bearing, not a style choice. |
| `@getpaseo/client`, `@getpaseo/protocol/agent-types` | `paseo-plugin.d.ts:2,97,98` | `import type` in an ambient `.d.ts` | Not in the bundle graph at all (esbuild never reads `.d.ts`) — no change. |
| `@getpaseo/plugin/react-native` | `settings.client.tsx:2` | value (`useToast`) | **Host-provided** (§18.2) — no change. |
| `@getpaseo/plugin`, `@getpaseo/plugin/server`, `zod`, `react`, `react-native`, `@tanstack/react-query` | various | value | Host-provided — no change. |

`@getpaseo/protocol/agent-types` needed no work: its single use is a type-only
import inside `paseo-plugin.d.ts`, which is a declaration file the bundler never
opens. No enum, const or schema from it is used as a value anywhere.

So the audit found exactly one real defect. Confirming that the reported error
was not merely the *first* of several is §18.5: the pre-fix bundle reports
`1 error`, not `1 of N`.

### 18.4 The deep link, reimplemented

Transcribed from `packages/protocol/src/agent-deep-link.ts` in Paseo `0.7.0`, and
cross-checked against the published `@getpaseo/protocol@0.7.0`
`dist/agent-deep-link.js`, which is the same code:

```ts
export function buildAgentDeepLinkRoute(target) {
  const { serverId, agentId } = normalizeAgentDeepLinkTarget(target);
  return `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}
export function buildAgentDeepLink(target) {
  return `paseo:/${buildAgentDeepLinkRoute(target)}`;
}
```

The format is therefore

```
paseo://h/<encodeURIComponent(serverId)>/agent/<encodeURIComponent(agentId)>
```

with both segments `.trim()`-ed first and an empty result rejected with
`"Agent deep links require a server ID and agent ID."`. The local copy in
`contracts.shared.ts` carries that citation in its doc comment so it can be
re-checked when Paseo moves; getting it wrong produces a link that opens nothing
rather than an error, which is exactly the kind of bug that ships.

### 18.5 Proof: byte-identical deep links

The reimplementation was diffed against the real package, using the
`plugin/node_modules` copy for the reference value. Both functions were called
with the same inputs and the results compared as strings (thrown messages
compared too), plus a round trip through the upstream `parseAgentDeepLink`:

```
ok    ["srv_abc123","agt_def456"]
        ref  OK paseo://h/srv_abc123/agent/agt_def456
        mine OK paseo://h/srv_abc123/agent/agt_def456
ok    ["  srv_pad  "," agt_pad "]
        ref  OK paseo://h/srv_pad/agent/agt_pad
        mine OK paseo://h/srv_pad/agent/agt_pad
ok    ["srv/with slash","agt?with=query&x#h"]
        ref  OK paseo://h/srv%2Fwith%20slash/agent/agt%3Fwith%3Dquery%26x%23h
        mine OK paseo://h/srv%2Fwith%20slash/agent/agt%3Fwith%3Dquery%26x%23h
ok    ["srv:колонка","agt 空白/../x"]
        ref  OK paseo://h/srv%3A%D0%BA%D0%BE%D0%BB%D0%BE%D0%BD%D0%BA%D0%B0/agent/agt%20%E7%A9%BA%E7%99%BD%2F..%2Fx
        mine OK paseo://h/srv%3A%D0%BA%D0%BE%D0%BB%D0%BE%D0%BD%D0%BA%D0%B0/agent/agt%20%E7%A9%BA%E7%99%BD%2F..%2Fx
ok    ["a","b"]
        ref  OK paseo://h/a/agent/b
        mine OK paseo://h/a/agent/b
ok    ["srv-%20already","agt+plus"]
        ref  OK paseo://h/srv-%2520already/agent/agt%2Bplus
        mine OK paseo://h/srv-%2520already/agent/agt%2Bplus
ok    ["srv.dot~tilde_underscore-dash","AGT!*'()"]
        ref  OK paseo://h/srv.dot~tilde_underscore-dash/agent/AGT!*'()
        mine OK paseo://h/srv.dot~tilde_underscore-dash/agent/AGT!*'()
ok    ["","x"]
        ref  THROW Agent deep links require a server ID and agent ID.
        mine THROW Agent deep links require a server ID and agent ID.
ok    ["x",""]
        ref  THROW Agent deep links require a server ID and agent ID.
        mine THROW Agent deep links require a server ID and agent ID.
ok    ["   ","y"]
        ref  THROW Agent deep links require a server ID and agent ID.
        mine THROW Agent deep links require a server ID and agent ID.
ok    ["\t\n srv \r"," agt"]
        ref  OK paseo://h/srv/agent/agt
        mine OK paseo://h/srv/agent/agt
ok    ["01998e7f-6a1e-7b2c-9f31-2c4d5e6f7a8b","agent_01K6ZQ8V"]
        ref  OK paseo://h/01998e7f-6a1e-7b2c-9f31-2c4d5e6f7a8b/agent/agent_01K6ZQ8V
        mine OK paseo://h/01998e7f-6a1e-7b2c-9f31-2c4d5e6f7a8b/agent/agent_01K6ZQ8V
ok    parseAgentDeepLink round-trip ["srv_abc123","agt_def456"] -> {"serverId":"srv_abc123","agentId":"agt_def456"}
ok    parseAgentDeepLink round-trip ["srv:колонка","agt 空白/../x"] -> {"serverId":"srv:колонка","agentId":"agt 空白/../x"}

ALL EQUAL
```

14/14, including the awkward cases: pre-encoded input is double-encoded the same
way (`%20` → `%2520`), `encodeURIComponent`'s unreserved set is preserved
identically (`!*'()~.` pass through), and the trim happens before the emptiness
check so `"   "` throws. The `%2F` on a slash is what stops a crafted `serverId`
from inventing extra path segments, and it survives the reimplementation.

This replaces the *mechanism* behind §9, not §9's result: the link the bridge
returns is unchanged, so §9's round-trip assertion still holds byte-for-byte.

### 18.6 Proof: the bundle builds with no `node_modules`

`npm run typecheck` is not evidence here — it passed throughout the failure. The
test has to be a bundle with no packages available.

A copy of the plugin sources was made in `/tmp`, with no `node_modules` in it or
in any parent directory, and bundled with esbuild — the very binary the daemon
uses (`0.25.12`, from the Paseo app's `app.asar.unpacked`) — marking external
exactly the specifiers from §18.2, once per target. `/tmp/stp-nonm-old` holds the
pre-fix sources, `/tmp/stp-nonm` the fixed ones, so the negative control and the
result come from one command:

```sh
$ ESB=/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild
$ EXT=(--external:@getpaseo/plugin --external:@getpaseo/plugin/server --external:@getpaseo/plugin/react-native
       --external:@paseo/plugin --external:@paseo/plugin/server --external:@paseo/plugin/react-native
       --external:@tanstack/react-query --external:react --external:react/jsx-runtime
       --external:react-native --external:zod)
$ for D in /tmp/stp-nonm-old /tmp/stp-nonm; do
    $ESB "$D/index.ts" --bundle --platform=node    --target=node20 --format=cjs \
      --loader:.ts=tsx --loader:.tsx=tsx --outfile=/dev/null "${EXT[@]}"
    $ESB "$D/index.ts" --bundle --platform=neutral --target=es2020 --format=cjs \
      --loader:.ts=tsx --loader:.tsx=tsx --outfile=/dev/null "${EXT[@]}" '--external:node:*'
  done
```

Output:

```
### /tmp/stp-nonm-old — server target (platform=node, target=node20)
✘ [ERROR] Could not resolve "@getpaseo/protocol/agent-deep-link"

    /tmp/stp-nonm-old/send.server.ts:8:35:
      8 │ ...t { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
        ╵                                  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

1 error
exit=1
### /tmp/stp-nonm-old — client target (platform=neutral, target=es2020; node: builtins are host-stubbed)
✘ [ERROR] Could not resolve "@getpaseo/protocol/agent-deep-link"

    /tmp/stp-nonm-old/send.server.ts:8:35:
      8 │ ...t { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
        ╵                                  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

1 error
exit=1
### /tmp/stp-nonm — server target (platform=node, target=node20)

  /dev/null  108.8kb

⚡ Done in 4ms
exit=0
### /tmp/stp-nonm — client target (platform=neutral, target=es2020; node: builtins are host-stubbed)

  /dev/null  108.8kb

⚡ Done in 3ms
exit=0
```

Two things this establishes beyond "it builds". First, the negative control
reproduces the reported error character for character, so the test really is
measuring the thing that broke. Second, esbuild says **`1 error`**, not
`1 of N errors shown` — nothing was hidden behind it. After the fix, both targets
are `exit=0`.

The build is a superset of what the host does: the host filters the entrypoint
per target before bundling, so its client bundle never reaches
`send.server.ts` and its server bundle never reaches `settings.client.tsx`. Here
both targets bundle the whole graph, which is strictly stricter.

An easy way to fake a pass on this test is to run it somewhere that still has a
`node_modules` above it. That was checked explicitly:

```sh
$ d=/tmp/stp-nonm; while [ "$d" != "/" ]; do [ -e "$d/node_modules" ] && echo "FOUND $d/node_modules"; d=$(dirname "$d"); done
# no output
```

### 18.7 Proof: the real installer, no push required

The bundle test is a proxy. The definitive test is the daemon's own installer, so
both of its paths were run with a throwaway id.

**Directory path, against a sources-only copy with no `node_modules`:**

```sh
$ paseo plugin add /tmp/stp-nonm --id stp-relverify
PLUGIN                STATUS      ENABLED   DIRECTORY
stp-relverify         running     yes       /tmp/stp-nonm

$ paseo plugin logs stp-relverify
TIME                      STREAM    MESSAGE
2026-09-01T13:19:19.317Z  stdout    [paseo] Loading plugin
2026-09-01T13:19:19.551Z  stdout    [paseo] Plugin ready
2026-09-01T13:19:19.558Z  stderr    [send-to-paseo] Port 7788 is already in use, so the Send to Paseo bridge did not start. Pick another port in Paseo -> Send to Paseo.
```

**Git path**, which is the one that was broken. Because the fix was not yet
pushed, the commit was placed in a throwaway local repository and installed from
a `file://` URL — the same code path as `tomgrin10/send-to-paseo`: the daemon
clones the repo into its own directory, applies `--path plugin`, and compiles
what it finds there.

```sh
$ paseo plugin add "file:///tmp/stp-gitproof/src" --path plugin --id stp-relverify
PLUGIN                STATUS      ENABLED   DIRECTORY
stp-relverify         running     yes       ~/.paseo/plugins/stp-relverify/b4f7a3f81e92-<uuid>/checkout/plugin

$ find ~/.paseo/plugins/stp-relverify/b4f7a3f81e92-<uuid>/checkout -name node_modules
# no output — the daemon compiled it with nothing installed

$ paseo plugin logs stp-relverify
2026-09-01T13:19:58.803Z  stdout    [paseo] Loading plugin
2026-09-01T13:19:59.029Z  stdout    [paseo] Plugin ready
2026-09-01T13:19:59.035Z  stderr    [send-to-paseo] Port 7788 is already in use, so the Send to Paseo bridge did not start. Pick another port in Paseo -> Send to Paseo.
```

`Plugin ready` and `running` are the success criteria. The `EADDRINUSE` line is
expected and correct: the real `send-to-paseo` install already holds
`127.0.0.1:7788`, and a second instance refusing the port with a legible message
instead of crashing is the behaviour §"If the port is taken" documents.

### 18.8 Cleanup

The throwaway was removed immediately, both times, and it never wrote to the real
plugin's state — the settings file is keyed on the plugin *name*, not the runtime
id, so it is shared:

```sh
$ paseo plugin remove stp-relverify
$ paseo plugin ls
PLUGIN                STATUS      ENABLED   DIRECTORY
paseo-defer           running     yes       ~/Projects/other-plugin
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin

$ grep -l stp-relverify ~/.paseo/plugins/sources.json ~/.paseo/config.json
# no output

$ ls ~/.paseo/plugins/stp-relverify
ls: ~/.paseo/plugins/stp-relverify: No such file or directory

$ shasum -a 256 ~/.paseo/plugin-data/send-to-paseo/settings.json
4ff74e08cacf3b18f98cc13db4cf378bdaef3f5dbce18ed569cfdea47af49c2b   # unchanged, before and after
```

The daemon was never restarted.

### 18.9 Regression sweep

```sh
$ cd plugin && npm run typecheck
> tsc --noEmit                                   # clean

$ node check-deps.mjs | tail -1
45/45 checks passed

$ paseo plugin reload send-to-paseo
PLUGIN                STATUS      ENABLED   DIRECTORY                             ERROR
send-to-paseo         running     yes       ~/Projects/send-to-paseo/plugin

$ paseo plugin logs send-to-paseo | tail -5
[paseo] Stopping plugin
[send-to-paseo] bridge stopped
[paseo] Plugin stopped
[paseo] Loading plugin
[paseo] Plugin ready
[send-to-paseo] bridge listening on http://127.0.0.1:7788

$ node test/e2e.mjs | tail -1
=== 44 passed, 0 failed, 0 skipped (of 44) ===
```

No behaviour changed: `contract` stays at **1**, the wire shape is untouched, and
the only functional edit is where `buildAgentDeepLink` is defined.

### 18.10 Standing rule — nothing may enter `dependencies`

**`plugin/package.json` must never gain a `dependencies` block.** Every entry
stays in `devDependencies`; they exist only so `npm run typecheck` works for
contributors, and they are absent when a user installs.

This is not tidiness. `paseo plugin add` — the documented, primary install — is
the *only* path that compiles with no packages installed, and it is the one path
no local check exercises. A runtime import of anything outside §18.2 therefore:

- passes `npm run typecheck`,
- passes `node check-deps.mjs`,
- passes `paseo plugin reload send-to-paseo` from the checkout,
- passes the whole e2e suite,
- and fails for **every user**, at install time, with
  `Build failed: Could not resolve "<pkg>"`.

Adding a package to `dependencies` does not fix that, because nothing runs
`npm install` on the install path. The only remedies are: use a host-provided
specifier, make the import `import type` so it is erased, reimplement the value
locally (as §18.4 does), or borrow it from the host at runtime through an
assembled specifier the bundler cannot read (as `daemon.server.ts` does).

Before merging any change to an `import` line in `plugin/`, re-run §18.6. It
takes about ten milliseconds and it is the only check that would have caught
this.
