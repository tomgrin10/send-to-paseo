import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
async function tools(stubs = {}, read) {
  const bundle = await build({ entryPoints: ["server/native-tools.ts"], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "fixture-services", setup(build) { build.onResolve({ filter: /^\./ }, args => Object.hasOwn(stubs, args.path) ? { path: "fixture:" + args.path, external: true } : undefined); } }] });
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(id => id.startsWith("fixture:") ? stubs[id.slice(8)] : require(id), module, module.exports);
  let open;
  module.exports.contributeAgentTools({ before(name, handler) { assert.equal(name, "agent.session_open"); open = handler; return () => {}; } }, read);
  const request = { purpose: "interactive", provider: "claude", labels: {}, workspaceId: "w1", tools: [] };
  return { definitions: open({ request }).tools, module: module.exports };
}
const context = () => ({ agent: { id: "caller", workspaceId: "w1", provider: "claude", cwd: "/fixture", title: "Fixture" }, paseo: {}, signal: new AbortController().signal });
async function call(tool, input, ctx = context()) { return tool.execute(tool.input.parse(input), ctx); }
test("bridge diagnostics omit tokens, daemon credentials and prompt history", async () => {
  const secret = "fixture-secret-must-not-leak";
  const { definitions } = await tools({ "./bridge": { getBridgeStatus: async () => ({ state: "running", port: 7788, paired: true, dryRun: false, defaultProvider: "claude", agentDispatch: "main", token: secret, tokenPreview: secret, daemon: { password: secret }, recentSends: [{ prompt: secret }] }) }, "./deps": { dependencySnapshot: async () => ({ dependencies: [{ name: "git", state: "ok", detail: secret, path: secret }] }) } });
  const result = await call(definitions[0], {});
  assert.ok(!JSON.stringify(result).includes(secret)); assert.equal(result.structuredContent.state, "running"); assert.deepEqual(result.structuredContent.dependencies, [{ name: "git", state: "ok" }]);
});
