import assert from "node:assert/strict";
import test from "node:test";

import { accessibleName, chipWord, PLAIN, rowTone, workspaceState } from "../extension/src/shared/button-state.ts";

// Fictional data only: example/app, alice, quiet-heron, dev-box.
const row = (id, patch = {}) => ({
  workspaceId: `wks_${id}`, agentId: `agt_${id}`, title: id, agentStatus: "idle", group: "waiting", state: "Waiting on others · Review requested",
  deepLink: `paseo://h/srv_1/agent/agt_${id}`, webUrl: `https://app.paseo.sh/h/srv_1/agent/agt_${id}`, ...patch,
});
const slice = (followUp, extra = {}, label = "dev-box") => ({
  hostId: label, bridgeHostId: label, hostLabel: label, bridgeAuthority: "127.0.0.1:7788",
  resolved: { ...(followUp === undefined ? {} : { followUp }), ...extra }, error: null,
});
const ok = (hosts, candidates = []) => ({ ok: true, data: { hosts, candidates, defaultCandidateIndex: candidates.length ? 0 : -1 } });
const owners = (...rows) => ok([slice({ workspaces: rows, more: 0 })]);
const fail = (code) => ({ ok: false, error: { code, message: "x" } });
/** The button's whole visible + spoken output, for one table. */
const view = (s) => [s.mark, s.tone, s.chip, accessibleName(s)];

// design.md section 2: every state the button can show, in Follow-up's own words.
const TABLE = [
  ["nothing landed yet", null, ["none", null, null, "Send to Paseo"]],
  ["no workspace yet", owners(), ["none", null, null, "Send to Paseo"]],
  ["agent working", owners(row("quiet-heron", { group: "running", agentStatus: "running", state: "Running", tone: "accent" })), ["working", "accent", null, "Send to Paseo, Agent working"]],
  ["asks you", owners(row("quiet-heron", { group: "needs", state: "Needs you · Asks you", tone: "attention" })), ["needs", "attention", "Asks you", "Send to Paseo, Asks you"]],
  ["two need you", owners(row("quiet-heron", { group: "needs", state: "Needs you · Asks you", tone: "attention" }), row("bold-otter", { group: "needs", state: "Needs you · Conflict", tone: "danger" })), ["needs", "attention", "2 need you", "Send to Paseo, 2 need you"]],
  ["follow-up fixing", owners(row("quiet-heron", { group: "sending", state: "Sending · 2 failing checks", tone: "accent" })), ["working", "accent", null, "Send to Paseo, Agent working"]],
  ["conflict", owners(row("quiet-heron", { group: "needs", state: "Needs you · Conflict", tone: "danger" })), ["needs", "danger", "Conflict", "Send to Paseo, Conflict"]],
  ["merge ready", owners(row("quiet-heron", { group: "needs", state: "Needs you · Merge ready", tone: "success" })), ["needs", "success", "Merge ready", "Send to Paseo, Merge ready"]],
  ["waiting on review", owners(row("quiet-heron", { tone: "muted" })), ["none", null, null, "Send to Paseo"]],
  ["merged, done", owners(row("quiet-heron", { group: "quiet", state: "Done · ready to archive", tone: "success" })), ["none", null, null, "Send to Paseo"]],
  ["agent closed", owners(row("quiet-heron", { group: "needs", agentStatus: "closed", state: "Needs you · Agent closed", tone: "attention" })), ["needs", "attention", "Agent closed", "Send to Paseo, Agent closed"]],
  ["paseo unreachable", fail("bridge_unreachable"), ["cross", "muted", null, "Send to Paseo, Couldn't reach Paseo"]],
  ["not set up", fail("not_configured"), ["cross", "muted", null, "Send to Paseo, Not set up"]],
  ["token rejected", fail("unauthorized"), ["cross", "muted", null, "Send to Paseo, Not set up"]],
];

for (const [name, result, want] of TABLE) {
  test(`state map: ${name}`, () => assert.deepEqual(view(workspaceState(result)), want));
}

test("the most urgent row leads the tooltip with Follow-up's full line, the workspace and the machine", () => {
  const s = workspaceState(owners(row("quiet-heron", { group: "needs", state: "Needs you · Asks you", tone: "attention" })));
  assert.deepEqual(s.tip, ["Needs you · Asks you", "quiet-heron on dev-box"]);
  const two = workspaceState(owners(row("a", { group: "needs", state: "Needs you · Asks you" }), row("b", { group: "needs", state: "Needs you · Conflict" })));
  assert.deepEqual(two.tip, ["Needs you · Asks you", "a on dev-box", "Also b on dev-box: Conflict"]);
  // A quiet state has no mark but still says where it stands on hover.
  assert.deepEqual(workspaceState(owners(row("quiet-heron"))).tip, ["Waiting on others · Review requested", "quiet-heron on dev-box"]);
});

test("the × tooltips say how to fix it", () => {
  assert.match(workspaceState(fail("bridge_unreachable")).tip.join(" "), /Couldn't reach Paseo.*running/);
  assert.match(workspaceState(fail("not_configured")).tip.join(" "), /Not set up.*pair/);
  assert.match(workspaceState(fail("permission_required")).tip.join(" "), /Allow the connection/);
});

test("a failure that is not about reaching Paseo says nothing about the workspace", () => {
  for (const code of ["project_not_found", "contract_mismatch", "internal"]) assert.deepEqual(workspaceState(fail(code)), PLAIN, code);
});

test("an older Follow-up without tone falls back to the group, never to the English", () => {
  assert.equal(rowTone({ group: "needs" }), "attention");
  assert.equal(rowTone({ group: "sending" }), "accent");
  assert.equal(rowTone({ group: "fixing" }), "accent");
  assert.equal(rowTone({ group: "waiting" }), "muted");
  assert.equal(rowTone({ group: "needs", tone: "danger" }), "danger");
  assert.equal(rowTone({ group: "needs", tone: "chartreuse" }), "attention", "an unknown tone is ignored");
  const old = workspaceState(owners(row("quiet-heron", { group: "needs", state: "Needs you · Merge ready" })));
  assert.deepEqual(view(old), ["needs", "attention", "Merge ready", "Send to Paseo, Merge ready"]);
});

test("the chip word is the part after 'Needs you · '", () => {
  assert.equal(chipWord("Needs you · Merge ready"), "Merge ready");
  assert.equal(chipWord("Needs you · "), "Needs you");
  assert.equal(chipWord("Something else"), "Needs you");
});

test("couldn't reach Follow-up is never a claim: plain, not 'nothing owns it'", () => {
  const s = workspaceState(ok([slice(undefined, { followUpUnreachable: true })]));
  assert.deepEqual(view(s), ["none", null, null, "Send to Paseo"]);
  // The registered owner the bridge still offered keeps the tooltip, with no colour claim.
  const reg = workspaceState(ok([slice({ workspaces: [row("quiet-heron", { group: "", state: "", agentStatus: "idle" })], more: 0 }, { followUpUnreachable: true })]));
  assert.equal(reg.mark, "none");
  const busy = workspaceState(ok([slice({ workspaces: [row("quiet-heron", { group: "", state: "", agentStatus: "running" })], more: 0 }, { followUpUnreachable: true })]));
  assert.equal(busy.mark, "working");
});

test("without Follow-up, an exact-match workspace whose main agent runs shows the working dot", () => {
  const candidate = (status, reason = "exact") => ({ kind: "existing", workspaceId: "w", label: "quiet-heron", rank: 1, reason, hostIndex: 0, mainAgent: { agentId: "a", title: "Main", status } });
  assert.equal(workspaceState(ok([slice(undefined)], [candidate("running")])).mark, "working");
  assert.equal(workspaceState(ok([slice(undefined)], [candidate("idle")])).mark, "none");
  assert.equal(workspaceState(ok([slice(undefined)], [candidate("running", "project")])).mark, "none", "only the PR's own workspace");
  // Follow-up tracks the repo and says no one owns it: trust that over the standalone guess.
  assert.equal(workspaceState(ok([slice({ workspaces: [], more: 0 })], [candidate("running")])).mark, "none");
});

test("owners from two machines merge: the needs row wins wherever it lives, and names its machine", () => {
  const s = workspaceState(ok([
    slice({ workspaces: [row("a", { group: "running", tone: "accent" })], more: 0 }, {}, "laptop"),
    slice({ workspaces: [row("b", { group: "needs", state: "Needs you · Merge ready", tone: "success" })], more: 0 }, {}, "dev-box"),
  ]));
  assert.deepEqual([s.chip, s.tip[1]], ["Merge ready", "b on dev-box"]);
});
