import assert from "node:assert/strict";
import test from "node:test";

import { agentStatusText, isDesktopLink, isWebLink, openHref, ownerSection } from "../extension/src/shared/open-workspace.ts";

const row = (id, patch = {}) => ({
  workspaceId: `wks_${id}`, agentId: `agt_${id}`, title: id, agentStatus: "idle", group: "waiting", state: "Waiting on others",
  deepLink: `paseo://h/srv_1/agent/agt_${id}`, webUrl: `https://app.paseo.sh/h/srv_1/agent/agt_${id}`, ...patch,
});
const slice = (followUp, extra = {}) => ({ hostId: "h", bridgeHostId: "h", hostLabel: "h", bridgeAuthority: "127.0.0.1:7788", resolved: { ...(followUp === undefined ? {} : { followUp }), ...extra }, error: null });

test("no host sent a view: no section (Follow-up absent, untracked repo, or browser access off)", () => {
  assert.equal(ownerSection([slice(undefined)]), null);
  assert.equal(ownerSection([{ ...slice(undefined), resolved: null, error: { code: "bridge_unreachable", message: "x" } }]), null);
});

test("a tracked repository with no owner is an empty section, not a missing one", () => {
  assert.deepEqual(ownerSection([slice({ workspaces: [], more: 0 })]), { rows: [], more: 0, unreachable: [] });
});

// optional-lookup-never-silent (AGENTS.md): "couldn't reach Follow-up" used to look exactly like "Follow-up absent".
test("a host whose Follow-up could not be reached keeps the section, says so, and keeps its registered owner", () => {
  assert.deepEqual(ownerSection([slice(undefined, { followUpUnreachable: true })]), { rows: [], more: 0, unreachable: ["h"] });
  const fallback = ownerSection([slice({ workspaces: [row("reg", { group: "", state: "" })], more: 0 }, { followUpUnreachable: true })]);
  assert.deepEqual([fallback.rows.map((r) => r.title), fallback.unreachable], [["reg"], ["h"]]);
  const mixed = ownerSection([{ ...slice({ workspaces: [], more: 0 }), hostLabel: "laptop" }, { ...slice(undefined, { followUpUnreachable: true }), hostLabel: "dev-box" }]);
  assert.deepEqual([mixed.rows, mixed.unreachable], [[], ["dev-box"]]);
});

test("owners merge across hosts, most urgent first, three at most, the rest counted", () => {
  const out = ownerSection([
    slice({ workspaces: [row("a"), row("b", { group: "running" })], more: 1 }),
    slice({ workspaces: [row("c", { group: "needs" }), row("d", { group: "quiet" })], more: 0 }),
  ]);
  assert.deepEqual(out.rows.map((r) => [r.title, r.hostIndex]), [["c", 1], ["b", 0], ["a", 0]]);
  assert.equal(out.more, 2, "one from the bridge, one past the limit here");
});

// Follow-up's group for "Follow-up is sending repairs" is "sending" (HOME_GROUPS); the extension knew only
// the pre-2.0 "fixing", so a Sending row sorted after Quiet and wore the popover's grey dot.
test("a Sending row ranks after Needs you and before Running, like Follow-up's Home", () => {
  const out = ownerSection([slice({ workspaces: [row("q", { group: "quiet" }), row("r", { group: "running" }), row("s", { group: "sending" }), row("n", { group: "needs" })], more: 0 })]);
  assert.deepEqual(out.rows.map((r) => r.title), ["n", "s", "r"]);
});

test("links that are not Paseo agent links are dropped, never rendered", () => {
  const bad = [
    { deepLink: "javascript:alert(1)" }, { deepLink: "https://evil.example/h/s/agent/a" }, { deepLink: "paseo://h/s/agent/a?message=hi" },
    { deepLink: "paseo://app/h/s/agent/a" }, { webUrl: "https://evil.example/h/s/agent/a" }, { webUrl: "http://app.paseo.sh/h/s/agent/a" },
    { webUrl: "https://app.paseo.sh.evil.example/h/s/agent/a" }, { webUrl: "https://app.paseo.sh/h/s/agent/a#x" },
  ];
  for (const patch of bad) assert.deepEqual(ownerSection([slice({ workspaces: [row("x", patch)], more: 0 })]).rows, [], JSON.stringify(patch));
  assert.equal(isDesktopLink("paseo://h/srv%2Fmain/agent/a%20b"), true);
  assert.equal(isWebLink("https://app.paseo.sh/h/srv%2Fmain/agent/a%20b"), true);
});

test("the open target picks the desktop or the web link", () => {
  assert.equal(openHref(row("a"), "app"), "paseo://h/srv_1/agent/agt_a");
  assert.equal(openHref(row("a"), "web"), "https://app.paseo.sh/h/srv_1/agent/agt_a");
});

test("main agent status reads as a phrase", () => {
  assert.equal(agentStatusText("permission", "Needs you · Merge ready"), "agent waiting for permission");
  assert.equal(agentStatusText("running", "Sending · 3 threads"), "agent running");
  assert.equal(agentStatusText("running", "Running"), "", "not repeated under a Running state");
  assert.equal(agentStatusText("permission", "Needs you · Permission"), "");
  assert.equal(agentStatusText(""), "");
});
