import assert from "node:assert/strict";
import test from "node:test";
import { registerAgentTools } from "./server/agent-tools.ts";

function harness(workspaceOnly = false) {
  let callback, disposed = false;
  const tool = { name: "fixture_tool", description: "fixture", execute() {} };
  const remove = registerAgentTools({ before(name, handler) { assert.equal(name, "agent.session_open"); callback = handler; return () => { disposed = true; }; } }, [tool], workspaceOnly);
  const request = { agentId: "agent-a", workspaceId: "workspace-a", provider: "claude", cwd: "/fixture", title: "fixture", labels: {}, purpose: "interactive", reason: "create", tools: [{ name: "existing" }], env: { KEEP: "value" }, mcpServers: { existing: { type: "http", url: "https://example.invalid" } } };
  return { callback, request, tool, remove, disposed: () => disposed };
}

test("tools attach on every interactive session open and preserve other contributions", () => {
  const h = harness();
  for (const reason of ["create", "resume", "import", "refresh"]) for (const provider of ["claude", "codex"]) {
    const request = { ...h.request, reason, provider };
    const output = h.callback({ request });
    assert.deepEqual(output.tools, [...request.tools, h.tool]);
    assert.equal(request.tools.length, 1);
    assert.equal(output.env, request.env);
    assert.equal(output.mcpServers, request.mcpServers);
    assert.equal(output.agentId, "agent-a");
  }
  h.remove(); assert.equal(h.disposed(), true);
});
test("history opens, unsupported providers and explicit opt-out receive no tools", () => {
  const h = harness();
  for (const patch of [{ purpose: "history" }, { provider: "unsupported" }, { labels: { "plugin-tools/enabled": "false" } }]) assert.equal(h.callback({ request: { ...h.request, ...patch } }), undefined);
});
test("workspace tools do not attach to agents without a workspace", () => {
  const h = harness(true);
  assert.equal(h.callback({ request: { ...h.request, workspaceId: null } }), undefined);
  assert.ok(h.callback({ request: h.request }));
});
