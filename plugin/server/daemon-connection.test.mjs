// one-held-daemon-connection (AGENTS.md): every bridge request and every optional Follow Up call
// shares one held daemon connection, reopened only after a real drop. Before this each request
// opened its own: about 20 hellos a minute for each of two client names with a browser open.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
const realRequire = createRequire(import.meta.url);

const counts = { built: 0, closed: 0, disposed: 0 };
class FakeClient {
  constructor() { counts.built++; this.state = { status: "idle" }; this.listeners = new Set(); }
  async connect() { this.set("connected"); }
  async close() { counts.closed++; this.set("disposed"); }
  set(status) { this.state = { status }; for (const l of this.listeners) l(this.state); }
  getConnectionState() { return this.state; }
  subscribeConnectionStatus(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
  async invokePluginRpc() { return { owner: null }; }
}
const api = () => ({ workspaces: { list: async () => ({ entries: [] }) }, dispose: async () => { counts.disposed++; } });
const fakeModules = {
  "@getpaseo/client": {
    createPaseoApi: () => api(),
    // What the per-request code used; counted the same way so the old shape fails here too.
    createPaseoClient: () => { const c = new FakeClient(); return { ...api(), connect: () => c.connect(), close: () => c.close() }; },
  },
  "@getpaseo/client/internal/daemon-client": { DaemonClient: FakeClient },
};

async function load(path, stubs) {
  const b = await build({ entryPoints: [path], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "fixture", setup(b) { b.onResolve({ filter: /^\./ }, args => Object.hasOwn(stubs, args.path) ? { path: "fixture:" + args.path, external: true } : undefined); } }] });
  const module = { exports: {} };
  const req = id => id.startsWith("fixture:") ? stubs[id.slice(8)] : Object.hasOwn(fakeModules, id) ? fakeModules[id] : realRequire(id);
  new Function("require", "module", "exports", b.outputFiles[0].text)(req, module, module.exports);
  return module.exports;
}

test("N bridge requests and Follow Up calls open one daemon connection, closed by closeDaemon", async () => {
  process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:1/ws";
  const m = await load("server/daemon.ts", {
    "./settings": { settings: { read: async () => ({}) } },
    "./daemon-password": { resolveDaemonPassword: async () => undefined },
  });
  for (let i = 0; i < 5; i++) {
    await m.withPaseo(paseo => paseo.workspaces.list());
    await m.callFollowUp("follow.pr-owner", { repo: "example/app", number: 1 });
  }
  await Promise.all(Array.from({ length: 5 }, () => [m.withPaseo(p => p.workspaces.list()), m.callFollowUp("follow.browser-exchange", {})]).flat());
  assert.equal(counts.built, 1, "20 requests should share one connection");
  assert.equal(counts.closed, 0, "the connection is held between requests");
  assert.equal(counts.disposed, 10, "each bridge request's scoped API is released");
  assert.equal(typeof m.closeDaemon, "function");
  await m.closeDaemon();
  assert.equal(counts.closed, 1);
  await assert.rejects(m.withPaseo(p => p.workspaces.list()), /stopping/);
  assert.equal(counts.built, 1, "nothing opens after teardown");
});

test("shared connection: drops, dead sockets, backoff and max age", async () => {
  const { sharedDaemon } = await load("server/shared-daemon.ts", {});
  let t = 0;
  const made = [];
  let up = true;
  let attempts = 0;
  const open = async () => { attempts++; if (!up) throw new Error("daemon down"); const c = new FakeClient(); await c.connect(); made.push(c); return c; };
  const d = sharedDaemon(open, { now: () => t, maxMs: 10_000, backoffMs: 1_000, backoffMaxMs: 4_000 });

  await Promise.all([d.run(async () => 1), d.run(async () => 1)]);
  assert.equal(made.length, 1, "concurrent first calls join one open");

  made[0].set("disconnected");
  await d.run(async () => 1);
  assert.equal(made.length, 2, "a real drop reopens once");

  await assert.rejects(d.run(async () => { throw new Error("bad request"); }));
  await d.run(async () => 1);
  assert.equal(made.length, 2, "an error on a live socket keeps it");
  await assert.rejects(d.run(async () => { made[1].state = { status: "disconnected" }; throw new Error("gone"); }));
  up = false;
  await assert.rejects(d.run(async () => 1), /daemon down/);
  await assert.rejects(d.run(async () => 1), /daemon down/);
  assert.equal(attempts, 3, "inside the backoff no new open");
  up = true;
  t = 1_000;
  await d.run(async () => 1);
  assert.equal(made.length, 3);

  t = 11_000;
  await d.run(async () => 1);
  assert.equal(made.length, 4, "older than maxMs is replaced");
  await new Promise(r => setImmediate(r));
  assert.equal(made[2].state.status, "disposed");
  await d.close();
  assert.equal(made[3].state.status, "disposed");
});

// warm-daemon-connection + optional-lookup-never-silent (AGENTS.md). 2.4.1 live: a fresh connection per
// Follow-up call took 0.85-2.5 s against a 2 s budget; the timeout read as "not tracked" and the popover's
// "Workspace for this PR" section silently vanished.
async function loadEntry(contents, stubs) {
  const b = await build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "fixture", setup(b) { b.onResolve({ filter: /^\./ }, args => Object.hasOwn(stubs, args.path) ? { path: "fixture:" + args.path, external: true } : undefined); } }] });
  const module = { exports: {} };
  const req = id => id.startsWith("fixture:") ? stubs[id.slice(8)] : Object.hasOwn(slowModules, id) ? slowModules[id] : realRequire(id);
  new Function("require", "module", "exports", b.outputFiles[0].text)(req, module, module.exports);
  return module.exports;
}
const slow = { built: 0, connectMs: 2_300 };
class SlowClient extends FakeClient {
  constructor() { super(); slow.built++; }
  async connect() { await new Promise(r => setTimeout(r, slow.connectMs)); this.set("connected"); }
  async invokePluginRpc(plugin, method) {
    if (plugin !== "follow-up") throw new Error(`Plugin is not available: ${plugin}`);
    assert.equal(method, "follow.pr-workspaces");
    return { tracked: true, more: 0, workspaces: [{ workspaceId: "wks_1", agentId: "agt_1", title: "quiet-heron", agentStatus: "idle", group: "needs", state: "Needs you" }] };
  }
}
const slowModules = { ...fakeModules, "@getpaseo/client/internal/daemon-client": { DaemonClient: SlowClient } };

test("a Follow-up behind a connect slower than its budget: cold says unknown at once, warm answers in time, never none", async () => {
  process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:1/ws";
  const m = await loadEntry(`export { lookupPrWorkspaces } from "./server/follow-up"; export * from "./server/daemon";`, {
    "./settings": { settings: { read: async () => ({}) } },
    "./daemon-password": { resolveDaemonPassword: async () => undefined },
  });
  let t = Date.now();
  assert.equal(await m.lookupPrWorkspaces("example", "app", 7), "unknown", "not connected yet: couldn't check, which is not 'not tracked'");
  assert.ok(Date.now() - t < 500, `the click path must not wait on a connect (took ${Date.now() - t} ms)`);

  m.warmDaemon(); // what plugin start does; joins the open the cold call already started
  await new Promise(r => setTimeout(r, slow.connectMs + 200));
  t = Date.now();
  const warm = await m.lookupPrWorkspaces("example", "app", 7);
  assert.deepEqual(warm?.workspaces?.map(w => w.workspaceId), ["wks_1"], "warm shared client: the owner arrives");
  assert.ok(Date.now() - t < 500, `a warm lookup pays no connect (took ${Date.now() - t} ms)`);
  assert.equal(slow.built, 1, "one held connection: no extra hellos per request");
  await m.closeDaemon();
});

test("kept warm: opens at start, reconnects in the background after a drop or failed open, rotates without a gap", async () => {
  const { sharedDaemon } = await load("server/shared-daemon.ts", {});
  const made = [];
  let up = true;
  let t = 0;
  const open = async () => { if (!up) throw new Error("daemon down"); const c = new FakeClient(); await c.connect(); made.push(c); return c; };
  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
  const d = sharedDaemon(open, { keepWarm: true, now: () => t, maxMs: 10_000, backoffMs: 0, backoffMaxMs: 0 });

  await assert.rejects(d.run(async () => 1, { ifConnected: true }), e => e.code === "not_connected", "nothing connected yet: fail at once");
  await tick();
  assert.equal(made.length, 1, "...and that started the connect in the background");
  d.warm();
  await tick();
  assert.equal(made.length, 1, "warm() joins what is open");
  assert.equal(await d.run(async c => c === made[0], { ifConnected: true }), true);

  made[0].set("disconnected");
  await tick(5);
  assert.equal(made.length, 2, "a drop reconnects in the background, before any request");
  assert.equal(await d.run(async c => c === made[1], { ifConnected: true }), true, "and the next request finds it connected");

  up = false;
  made[1].set("disconnected");
  await tick(5);
  up = true;
  await tick(5);
  assert.equal(made.length, 3, "a failed background open retries on the backoff");

  t = 11_000;
  assert.equal(await d.run(async c => c === made[2], { ifConnected: true }), true, "an aged connection keeps serving while its replacement opens");
  await tick(5);
  assert.equal(made.length, 4, "the replacement opened");
  assert.equal(await d.run(async c => c === made[3], { ifConnected: true }), true, "and took over");
  await tick();
  assert.equal(made[2].state.status, "disposed", "the aged one closed once idle");

  await d.close();
  made[3].set("disconnected");
  await tick(5);
  assert.equal(made.length, 4, "nothing reopens after teardown");
});
