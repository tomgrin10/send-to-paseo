import assert from "node:assert/strict";
import test from "node:test";

import { agentStatusText, isDesktopLink, isWebLink, openHref, ownerSection } from "../extension/src/shared/open-workspace.ts";

const row = (id, patch = {}) => ({
  workspaceId: `wks_${id}`, agentId: `agt_${id}`, title: id, agentStatus: "idle", group: "waiting", state: "Waiting on others",
  deepLink: `paseo://h/srv_1/agent/agt_${id}`, webUrl: `https://app.paseo.sh/h/srv_1/agent/agt_${id}`, ...patch,
});
const slice = (followUp) => ({ hostId: "h", bridgeHostId: "h", hostLabel: "h", bridgeAuthority: "127.0.0.1:7788", resolved: followUp === undefined ? {} : { followUp }, error: null });

test("no host sent a view: no section (Follow-up absent, untracked repo, or browser access off)", () => {
  assert.equal(ownerSection([slice(undefined)]), null);
  assert.equal(ownerSection([{ ...slice(undefined), resolved: null, error: { code: "bridge_unreachable", message: "x" } }]), null);
});

test("a tracked repository with no owner is an empty section, not a missing one", () => {
  assert.deepEqual(ownerSection([slice({ workspaces: [], more: 0 })]), { rows: [], more: 0 });
});

test("owners merge across hosts, most urgent first, three at most, the rest counted", () => {
  const out = ownerSection([
    slice({ workspaces: [row("a"), row("b", { group: "running" })], more: 1 }),
    slice({ workspaces: [row("c", { group: "needs" }), row("d", { group: "quiet" })], more: 0 }),
  ]);
  assert.deepEqual(out.rows.map((r) => [r.title, r.hostIndex]), [["c", 1], ["b", 0], ["a", 0]]);
  assert.equal(out.more, 2, "one from the bridge, one past the limit here");
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
  assert.equal(agentStatusText("running", "Follow-up is fixing · 3 threads"), "agent running");
  assert.equal(agentStatusText("running", "Running"), "", "not repeated under a Running state");
  assert.equal(agentStatusText("permission", "Needs you · Permission"), "");
  assert.equal(agentStatusText(""), "");
});
