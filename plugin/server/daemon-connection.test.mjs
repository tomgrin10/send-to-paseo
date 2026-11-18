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
