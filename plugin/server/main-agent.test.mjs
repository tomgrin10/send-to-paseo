import assert from "node:assert/strict";
import test from "node:test";

import { agentDisplayTitle, agentProvider, selectMainAgent } from "./main-agent.ts";

function agent(id, overrides = {}) {
  return {
    id,
    workspaceId: "wks_target",
    title: id,
    labels: {},
    status: "idle",
    archivedAt: null,
    lastUserMessageAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    createdAt: "2026-09-20T12:00:00.000Z",
    provider: "claude",
    model: "claude-opus-5-5",
    ...overrides,
  };
}

test("main-agent selection excludes archived, foreign-workspace, and delegated agents", () => {
  const picked = selectMainAgent(
    [
      agent("archived-main", { title: "Main", archivedAt: "2026-09-21T00:00:00.000Z" }),
      agent("foreign-main", { title: "Main", workspaceId: "wks_other" }),
      agent("delegated-main", {
        title: "Main",
        labels: { "paseo.parent-agent-id": "agt_parent" },
      }),
      agent("eligible-root"),
    ],
    "wks_target",
  );

  assert.equal(picked?.id, "eligible-root");
});

test("an explicitly named Main root agent is the strongest user signal", () => {
  const picked = selectMainAgent(
    [
      agent("new-running", {
        status: "running",
        lastUserMessageAt: "2026-09-23T12:00:00.000Z",
      }),
      agent("named-main", {
        title: "  MAIN AGENT  ",
        status: "closed",
        lastUserMessageAt: "2026-09-01T12:00:00.000Z",
      }),
    ],
    "wks_target",
  );

  assert.equal(picked?.id, "named-main");
});

test("an open Paseo tab wins when no agent is explicitly named Main", () => {
  const picked = selectMainAgent(
    [
      agent("running", { status: "running" }),
      agent("open-tab", {
        status: "idle",
        labels: { "paseo.open-agent-tab.window-1": "true" },
      }),
    ],
    "wks_target",
  );

  assert.equal(picked?.id, "open-tab");
});

test("runtime state, user activity, and id make the fallback deterministic", () => {
  assert.equal(
    selectMainAgent(
      [agent("idle-newer", { status: "idle" }), agent("running-older", { status: "running" })],
      "wks_target",
    )?.id,
    "running-older",
  );

  assert.equal(
    selectMainAgent(
      [
        agent("older-message", { lastUserMessageAt: "2026-09-20T12:00:00.000Z" }),
        agent("newer-message", { lastUserMessageAt: "2026-09-22T12:00:00.000Z" }),
      ],
      "wks_target",
    )?.id,
    "newer-message",
  );

  assert.equal(
    selectMainAgent([agent("agt_b"), agent("agt_a")], "wks_target")?.id,
    "agt_a",
  );
});

test("selection returns null when the workspace has no eligible root agent", () => {
  assert.equal(
    selectMainAgent(
      [agent("subagent", { labels: { "paseo.parent-agent-id": "agt_parent" } })],
      "wks_target",
    ),
    null,
  );
});

test("agent display helpers preserve useful title and model information", () => {
  assert.equal(agentDisplayTitle(agent("agt_123456789", { title: "  Main  " })), "Main");
  assert.equal(agentDisplayTitle(agent("agt_123456789", { title: " " })), "Agent agt_123");
  assert.equal(agentProvider(agent("with-model")), "claude/claude-opus-5-5");
  assert.equal(agentProvider(agent("provider-only", { model: "" })), "claude");
});
