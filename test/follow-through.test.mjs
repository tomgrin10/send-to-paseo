import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { build } = createRequire(new URL("../extension/package.json", import.meta.url))("esbuild");
const bundled = await build({ entryPoints: [new URL("../extension/src/content/graphite-companion.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm" });
const { executeGraphiteCommand, graphiteRecord } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const command = (op = "enable_mwr", prs = [{ number: 1, head: "head", trunk: "main" }]) => ({ id: "command-identity", nonce: "command-nonce-value", expiresAt: new Date(Date.now() + 20_000).toISOString(), repo: "example/app", op, prs });
const record = (number = 1, mergeWhenReady = false, head = "head") => ({ root: { repo: { owner: "example", name: "app", forgeSource: "github" }, number, headSHA: head, state: "OPEN", mergeWhenReady } });
function fixture({ failReadAfterWrite = false, stale = false, denied = false } = {}) {
  const writes = []; const enabled = new Set();
  const fetch = async (path, options) => {
    assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
    assert.ok(path.startsWith("/api/v1/graphite/"));
    if (options.method === "POST") {
      const body = JSON.parse(options.body); writes.push({ path, body });
      if (denied) return new Response("refused", { status: 403 });
      if (path.endsWith("enable-mwr")) enabled.add(body.number); else enabled.delete(body.number);
      return Response.json({ optimisticCreates: [] });
    }
    if (failReadAfterWrite && writes.length) return new Response("refused", { status: 403 });
    const number = Number(path.split("/").at(-1));
    return Response.json(record(number, enabled.has(number), stale ? "new-head" : "head"));
  };
  return { fetch, writes, enabled };
}
test("browser companion verifies the exact toggle and sends only the scoped Graphite body", async () => {
  const f = fixture(); const c = command();
  const result = await executeGraphiteCommand(c, f.fetch);
  assert.equal(result.outcome, "completed"); assert.deepEqual(result.applied, [1]);
  assert.deepEqual(f.writes, [{ path: "/api/v1/graphite/mutation/enable-mwr", body: { forgeSource: "github", owner: "example", name: "app", number: 1, trunkBranchName: "main" } }]);
  await executeGraphiteCommand(c, f.fetch); assert.equal(f.writes.length, 1);
  await executeGraphiteCommand(command("disable_mwr"), f.fetch);
  assert.deepEqual(f.writes[1].body, { forgeSource: "github", owner: "example", name: "app", number: 1 });
});
test("stale heads, expired commands and unexpected PR payloads never write", async () => {
  const f = fixture({ stale: true });
  assert.equal((await executeGraphiteCommand(command(), f.fetch)).outcome, "failed"); assert.equal(f.writes.length, 0);
  assert.equal((await executeGraphiteCommand({ ...command(), expiresAt: new Date(Date.now() - 1).toISOString() }, f.fetch)).outcome, "failed");
  assert.equal(f.writes.length, 0); assert.throws(() => graphiteRecord(record(2), "example/app", 1), /requested PR/);
});
test("a refused confirmation read after a successful write remains uncertain", async () => {
  const f = fixture({ failReadAfterWrite: true });
  assert.equal((await executeGraphiteCommand(command(), f.fetch)).outcome, "uncertain"); assert.equal(f.writes.length, 1);
  const denied = fixture({ denied: true });
  assert.equal((await executeGraphiteCommand(command(), denied.fetch)).outcome, "failed");
});
test("scheduling does not masquerade as the Graphite toggle", () => {
  const payload = record(); delete payload.root.mergeWhenReady; payload.root.stackJobState = { state: "QUEUED" };
  const parsed = graphiteRecord(payload, "example/app", 1);
  assert.equal(parsed.mergeWhenReady, false); assert.equal(parsed.merging, true);
});
