import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../extension/package.json", import.meta.url));
const { build } = require("esbuild");
async function load(path) {
  const bundle = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}
const { executeGraphiteCommand, graphiteRecord } = await load("../extension/src/content/graphite-companion.ts");
const { permits, bridgeBinding } = await load("../extension/src/background/browser-access.ts");
const command = (op = "enable_mwr") => ({ id: "command", nonce: "nonce", expiresAt: new Date(Date.now() + 20_000).toISOString(), repo: "example/app", op, prs: [{ number: 1, head: "head", trunk: "main" }] });
const record = (enabled = false, head = "head") => ({ root: { repo: { owner: "example", name: "app", forgeSource: "github" }, number: 1, headSHA: head, state: "OPEN", mergeWhenReady: enabled } });
function fixture({ missing = false, stale = false, failConfirmation = false, pushDuringWrite = false, denied = false } = {}) {
  const writes = []; let enabled = false;
  return { writes, fetch: async (path, options) => {
    assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
    assert.ok(path.startsWith("/api/v1/graphite/"));
    if (options.method === "POST") {
      writes.push({ path, body: JSON.parse(options.body) });
      if (denied) return new Response("denied", { status: 403 });
      enabled = path.endsWith("enable-mwr"); return Response.json({ optimisticCreates: [] });
    }
    if (failConfirmation && writes.length) return new Response("no confirmation", { status: 403 });
    const payload = record(enabled, stale || pushDuringWrite && writes.length ? "pushed-head" : "head");
    if (missing) delete payload.root.mergeWhenReady;
    return Response.json(payload);
  } };
}
test("a machine command cannot change Graphite without browser confirmation", async () => {
  const f = fixture();
  assert.equal((await executeGraphiteCommand(command(), f.fetch)).outcome, "failed");
  assert.deepEqual(f.writes, []);
});
test("confirmed toggle only writes the requested PR and verifies the actual boolean", async () => {
  const f = fixture();
  const result = await executeGraphiteCommand(command(), f.fetch, true);
  assert.equal(result.outcome, "completed"); assert.deepEqual(result.applied, [1]);
  assert.deepEqual(f.writes, [{ path: "/api/v1/graphite/mutation/enable-mwr", body: { forgeSource: "github", owner: "example", name: "app", number: 1, trunkBranchName: "main" } }]);
  await executeGraphiteCommand(command(), f.fetch, true); assert.equal(f.writes.length, 1);
});
test("unknown toggle state never becomes false or an already-completed disable", async () => {
  const payload = record(); delete payload.root.mergeWhenReady;
  assert.throws(() => graphiteRecord(payload, "example/app", 1), /toggle format/);
  for (const op of ["enable_mwr", "disable_mwr", "read"]) {
    const f = fixture({ missing: true });
    assert.equal((await executeGraphiteCommand(command(op), f.fetch, true)).outcome, "failed"); assert.deepEqual(f.writes, []);
  }
});
test("stale heads and expired commands refuse writes; lost confirmation and pushes remain uncertain", async () => {
  const stale = fixture({ stale: true });
  assert.equal((await executeGraphiteCommand(command(), stale.fetch, true)).outcome, "failed"); assert.deepEqual(stale.writes, []);
  const expired = fixture(); assert.equal((await executeGraphiteCommand({ ...command(), expiresAt: new Date(0).toISOString() }, expired.fetch, true)).outcome, "failed"); assert.deepEqual(expired.writes, []);
  for (const patch of [{ failConfirmation: true }, { pushDuringWrite: true }]) {
    const f = fixture(patch); assert.equal((await executeGraphiteCommand(command(), f.fetch, true)).outcome, "uncertain"); assert.equal(f.writes.length, 1);
  }
  const denied = fixture({ denied: true }); assert.equal((await executeGraphiteCommand(command(), denied.fetch, true)).outcome, "failed");
});
test("browser consent binds exact machine, route, pairing credentials and repository", async () => {
  const host = { id: "primary", bridgeUrl: "http://127.0.0.1:7788", token: "pairing-a" };
  const route = { hostId: host.id, routeId: "vm", serverId: "daemon-a", binding: await bridgeBinding(host), available: true };
  const grants = [{ ...route, repo: "example/app" }];
  assert.equal(permits([], route, command()), false); assert.equal(permits(grants, route, command()), true);
  for (const patch of [{ hostId: "another" }, { routeId: "local" }, { serverId: "daemon-b" }, { binding: await bridgeBinding({ ...host, token: "pairing-b" }) }, { available: false }]) assert.equal(permits(grants, { ...route, ...patch }, command()), false);
  assert.equal(permits(grants, route, { ...command(), repo: "other/repo" }), false);
  assert.equal(permits(grants, { ...route, binding: await bridgeBinding({ ...host, bridgeUrl: "https://different.example" }) }, command()), false);
});

test("read permission requires separate explicit permission for direct toggle changes", async () => {
  const { allowsToggleChanges } = await load("../extension/src/background/browser-access.ts");
  const route = { hostId: "primary", routeId: "vm", serverId: "daemon", binding: "binding", available: true };
  const grant = { ...route, repo: "example/app" };
  assert.equal(permits([grant], route, command()), true);
  assert.equal(allowsToggleChanges([grant], route, command()), false);
  assert.equal(allowsToggleChanges([{ ...grant, enable_toggle_changes: true }], route, command()), true);
  assert.equal(allowsToggleChanges([{ ...grant, enable_toggle_changes: true }], { ...route, routeId: "other" }, command()), false);
});


test("concurrent host edits preserve additions and removals; stale pings cannot label a new bridge", async () => {
  const settings = await load("../extension/src/background/settings.ts");
  let stored = { version: 2, hosts: [settings.makeHost({ id: "first", token: "old" })], connectionMode: "advanced", defaultProvider: "" };
  const oldChrome = globalThis.chrome;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let tail = Promise.resolve();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: (_key, task) => {
    const next = tail.then(task); tail = next.catch(() => {}); return next;
  } } } });
  globalThis.chrome = { storage: { local: {
    get: async () => { const copy = structuredClone(stored); await new Promise(r => setTimeout(r, 1)); return { settings: copy }; },
    set: async ({ settings: next }) => { await new Promise(r => setTimeout(r, 1)); stored = structuredClone(next); },
  } } };
  try {
    const original = structuredClone(stored.hosts[0]);
    await Promise.all([settings.writeHost("first", { label: "Chosen" }), settings.addHost({ id: "second" }), settings.writeSettings({ defaultProvider: "provider" })]);
    assert.equal(stored.hosts.length, 2); assert.equal(stored.hosts[0].label, "Chosen"); assert.equal(stored.defaultProvider, "provider");
    await Promise.all([settings.removeHost("second"), settings.writeHost("first", { token: "replacement" })]);
    assert.deepEqual(stored.hosts.map(h => h.id), ["first"]);
    await settings.writeHost("first", { machineName: "stale" }, original);
    assert.equal(stored.hosts[0].machineName, ""); assert.equal(stored.hosts[0].token, "replacement");
    await settings.writeHost("missing", { label: "Do not resurrect" });
    assert.equal(stored.hosts.length, 1);
  } finally {
    globalThis.chrome = oldChrome;
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else delete globalThis.navigator;
  }
});
