import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
async function load(path, stubs) {
  const b = await build({ entryPoints: [path], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "fixture", setup(b) { b.onResolve({ filter: /^\./ }, args => Object.hasOwn(stubs, args.path) ? { path: "fixture:" + args.path, external: true } : undefined); } }] });
  const module = { exports: {} }; new Function("require", "module", "exports", b.outputFiles[0].text)(id => id.startsWith("fixture:") ? stubs[id.slice(8)] : require(id), module, module.exports); return module.exports;
}
const agent = (id, patch = {}) => ({ id, workspaceId: "owned-workspace", title: id, labels: {}, archivedAt: null, status: "idle", provider: "fixture", model: null, ...patch });
test("optional owner lookup fails closed for absent, old, broken or malformed companions", async () => {
  for (const reply of [null, {}, { owner: { workspaceId: "w" } }, new Error("Plugin not installed")]) {
    const m = await load("server/follow-up.ts", { "./daemon": { callFollowUp: async () => { if (reply instanceof Error) throw reply; return reply; } } });
    assert.equal(await m.lookupPrOwner("example", "app", 1), null);
  }
  const m = await load("server/follow-up.ts", { "./daemon": { callFollowUp: async (method, input) => { assert.equal(method, "follow.pr-owner"); assert.deepEqual(input, { repo: "example/app", number: 1 }); return { owner: { workspaceId: "owned-workspace", agentId: "owner" } }; } } });
  const owner = await m.lookupPrOwner("example", "app", 1);
  assert.equal(m.registeredAgent([agent("owner"), agent("newest")], owner, "owned-workspace").id, "owner");
  assert.equal(m.registeredAgent([agent("owner", { archivedAt: "yesterday" })], owner, "owned-workspace"), null);
  assert.equal(m.registeredAgent([agent("owner")], owner, "foreign"), null);
});
test("send steers the registering agent ahead of a newer main agent, and explicit new-agent sends still work", async () => {
  let owner = { workspaceId: "owned-workspace", agentId: "registered" };
  let agents = [agent("registered"), agent("newest-main", { title: "Main" })]; const sent = []; const created = [];
  const workspace = { id: "owned-workspace", name: "Owned", workspaceDirectory: "/fixture", gitRuntime: { currentBranch: "feature" } };
  const paseo = { agents: { ref: a => ({ send: async (prompt, options) => sent.push({ id: a.id, prompt, options }) }) }, workspaces: { list: async () => ({ entries: [workspace] }), ref: () => ({ agents: { create: async input => { created.push(input); return { id: "new-agent" }; } } }) } };
  const m = await load("server/send.ts", {
    "./daemon": { withPaseo: f => f(paseo), requireServerId: async () => "server" },
    "./follow-up": { lookupPrOwner: async () => owner, registeredAgent: (all, o, w) => all.find(a => o && a.id === o.agentId && o.workspaceId === w && a.workspaceId === w && a.archivedAt == null) ?? null },
    "./gh": { lookupPr: async () => ({ pr: { number: 1, title: "Fixture", headBranch: "feature", baseBranch: "main", state: "OPEN", url: "https://github.com/example/app/pull/1" }, outage: null }) },
    "./settings": { settings: { read: async () => ({ agentDispatch: "new" }), recordSend: async () => {} } },
    "./resolve": { resolveProject: async () => ({ projectId: "project", name: "app", path: "/fixture" }), listProjectWorkspaces: async () => [workspace], resolveSelectedProfile: async () => null, resolveDefaultProvider: async () => "fixture", resolveDefaultMode: async () => undefined, profileProviderId: () => null },
    "./main-agent": { listProjectAgents: async () => agents, selectMainAgent: all => all.find(a => a.title === "Main") ?? null, agentDisplayTitle: a => a.title, agentProvider: a => a.provider },
  });
  const request = { forge: "github", owner: "example", repo: "app", number: 1, prompt: "Fix conflicts", target: { kind: "existing", workspaceId: workspace.id } };
  const sentOwner = await m.handleSend({ ...request, agentDispatch: "main", followUpAgentId: "registered" }); assert.equal(sentOwner.agentId, "registered"); assert.equal(sent[0].options.activeTurnBehavior, "steer"); assert.equal(created.length, 0);
  assert.equal((await m.handleSend({ ...request, agentDispatch: "new" })).agentId, "new-agent"); assert.equal(created.length, 1);
  owner = null;
  await assert.rejects(m.handleSend({ ...request, agentDispatch: "main", followUpAgentId: "registered" }), /registration changed/); assert.equal(sent.length, 1);
  assert.equal((await m.handleSend(request)).agentId, "new-agent", "standalone default still creates a new agent");
  assert.equal((await m.handleSend({ ...request, agentDispatch: "main" })).agentId, "newest-main");
});

test("browser transport keeps repository grants and receipts on their exact route, with one fair lease slot", async () => {
  const calls = [];
  const m = await load("server/browser-bridge.ts", {
    "./daemon": { readDaemonStatus: async () => ({ serverId: "local-server" }), callFollowUp: async (_method, input) => { calls.push({ route: "local", input }); return { jobs: [], accepted: input.results.map(r => r.id), repositories: ["example/local"] }; } },
    "./settings": { settings: { read: async () => ({ additionalMachines: [{ id: "vm", label: "VM", enabled: true }, { id: "other", label: "Other", enabled: true }] }) } },
    "./peers": { exchangeBrowserOnMachine: async (machine, input) => { calls.push({ route: machine.id, input }); return { routes: [{ routeId: "local", serverId: machine.id + "-server", available: true, repositories: ["example/remote"], jobs: [], accepted: [] }] }; } },
  });
  const input = { clientId: "browser", ready: true, acceptJobs: true, routes: [{ routeId: "local", serverId: "local-server", repositories: ["example/local"] }, { routeId: "vm", serverId: "vm-server", repositories: ["example/remote"] }], results: [{ routeId: "vm", id: "receipt", nonce: "nonce", outcome: "failed", prs: [], applied: [], error: "cancelled" }] };
  const first = await m.exchangeBrowser(input, false);
  assert.deepEqual(first.routes.map(r => r.routeId), ["local", "vm", "other"]);
  assert.deepEqual(first.routes[0].repositories, ["example/local"]);
  assert.deepEqual(first.routes[1].repositories, ["example/remote"]);
  assert.equal(calls.filter(c => c.input.acceptJobs).length, 1); assert.equal(calls.find(c => c.input.acceptJobs).route, "local");
  assert.deepEqual(calls.find(c => c.route === "local").input.repositories, ["example/local"]);
  assert.equal(calls.find(c => c.route === "local").input.results.length, 0);
  const remote = calls.find(c => c.route === "vm").input;
  assert.deepEqual(remote.routes, [{ routeId: "local", serverId: "vm-server", repositories: ["example/remote"] }]);
  assert.equal(remote.results[0].routeId, "local");
  assert.deepEqual(calls.find(c => c.route === "other").input.routes, []);
  calls.length = 0; await m.exchangeBrowser(input, false);
  assert.equal(calls.filter(c => c.input.acceptJobs).length, 1); assert.equal(calls.find(c => c.input.acceptJobs).route, "vm");
  calls.length = 0; await m.exchangeBrowser(input, true);
  assert.deepEqual(calls.map(c => c.route), ["local"], "Additional daemons do not recurse");
});

test("the registered workspace may select a second clone of the same repository, while foreign projects stay excluded", async () => {
  const first = { projectId: "prj_first", projectKind: "git", projectDisplayName: "First", projectRootPath: "/first" };
  const owned = { projectId: "prj_owned", projectKind: "git", projectDisplayName: "Owned", projectRootPath: "/owned" };
  const foreign = { projectId: "prj_foreign", projectKind: "git", projectDisplayName: "Foreign", projectRootPath: "/foreign" };
  const m = await load("server/resolve.ts", { "./git": { readOriginOwnerRepo: async path => ({ owner: path === "/foreign" ? "foreign" : "example", repo: "app" }) }, "./daemon": {} });
  const paseo = { projects: { list: async () => ({ projects: [first, owned, foreign] }) } };
  const ref = { owner: "example", repo: "app" };
  assert.equal((await m.resolveProject(paseo, ref, owned.projectId)).projectId, owned.projectId);
  assert.equal((await m.resolveProject(paseo, ref, foreign.projectId)).projectId, first.projectId);
  assert.equal((await m.resolveProject(paseo, ref, "deleted")).projectId, first.projectId);
});

test("an Additional bridge downgrade refuses a registered-agent send before forwarding it", async () => {
  const m = await load("server/peers.ts", {});
  const original = globalThis.fetch; const paths = [];
  globalThis.fetch = async url => {
    paths.push(new URL(url).pathname);
    return Response.json({ ok: true, name: "send-to-paseo", contract: 1, paired: true, daemon: { serverId: "additional" } });
  };
  try {
    await assert.rejects(m.sendToMachine({ id: "vm", label: "Fixture", machineName: "Fixture", bridgeUrl: "https://fixture.invalid", token: "synthetic-token", serverId: "additional", enabled: true }, { forge: "github", owner: "example", repo: "app", number: 1, prompt: "Synthetic", target: { kind: "existing", workspaceId: "owned" }, agentDispatch: "main", followUpAgentId: "registered" }), /Update Send to Paseo/);
    assert.deepEqual(paths, ["/v1/ping"]);
  } finally { globalThis.fetch = original; }
});

const view = (id, patch = {}) => ({ workspaceId: id, agentId: `agent-${id}`, title: `Follow-up ${id}`, agentStatus: "idle", group: "waiting", state: "Waiting on others", ...patch });
const workspacesModule = reply => load("server/follow-up.ts", { "./daemon": { callFollowUp: async (method, input) => {
  assert.equal(method, "follow.pr-workspaces"); assert.deepEqual(input, { repo: "example/app", number: 7 });
  if (reply instanceof Error) throw reply; return reply;
} } });
test("PR workspaces lookup: owner found, several owners, none, repository not granted, Follow-up absent", async () => {
  const one = await (await workspacesModule({ tracked: true, more: 0, workspaces: [view("w1", { group: "needs", state: "Needs you · Merge ready" })] })).lookupPrWorkspaces("example", "app", 7);
  assert.deepEqual(one, { more: 0, workspaces: [view("w1", { group: "needs", state: "Needs you · Merge ready" })] });
  const several = await (await workspacesModule({ tracked: true, more: 2, workspaces: [view("a"), view("b"), view("c")] })).lookupPrWorkspaces("example", "app", 7);
  assert.deepEqual([several.workspaces.map(w => w.workspaceId), several.more], [["a", "b", "c"], 2]);
  assert.deepEqual(await (await workspacesModule({ tracked: true, more: 0, workspaces: [] })).lookupPrWorkspaces("example", "app", 7), { workspaces: [], more: 0 }, "tracked repository, no owner: say so");
  assert.equal(await (await workspacesModule({ tracked: false, more: 0, workspaces: [] })).lookupPrWorkspaces("example", "app", 7), null, "outside Follow-up's advertised scope: nothing");
  for (const reply of [new Error("Plugin follow-through is not installed"), new Error("Unknown RPC follow.pr-workspaces"), null, {}, { tracked: true, more: 0, workspaces: [view("a"), view("b"), view("c"), view("d")] }, { tracked: true, more: 0, workspaces: [{ workspaceId: "w" }] }])
    assert.equal(await (await workspacesModule(reply)).lookupPrWorkspaces("example", "app", 7), null, `fails closed for ${JSON.stringify(reply) ?? reply}`);
});

test("the popover view carries Paseo's workspace name and both open links for this machine only", async () => {
  const m = await load("server/follow-up.ts", { "./daemon": { callFollowUp: async () => null } });
  const found = { more: 1, workspaces: [view("w1"), view("w2", { title: "" })] };
  const out = m.followUpView(found, "srv/main", new Map([["w1", "brawny-dodo"]]));
  assert.deepEqual(out.workspaces.map(w => [w.title, w.deepLink, w.webUrl]), [
    ["brawny-dodo", "paseo://h/srv%2Fmain/agent/agent-w1", "https://app.paseo.sh/h/srv%2Fmain/agent/agent-w1"],
    ["w2", "paseo://h/srv%2Fmain/agent/agent-w2", "https://app.paseo.sh/h/srv%2Fmain/agent/agent-w2"],
  ]);
  assert.equal(out.more, 1);
  assert.equal(m.followUpView(found, null, new Map()), undefined, "no server id, no links, no section");
  assert.equal(m.followUpView(null, "srv", new Map()), undefined);
});

test("agent links: desktop deep link and web link share one encoded route", async () => {
  const m = await load("shared/contracts.ts", {});
  for (const [serverId, agentId, route] of [["srv_abc", "agt_1", "/h/srv_abc/agent/agt_1"], [" srv pad ", " a/b?c#d ", "/h/srv%20pad/agent/a%2Fb%3Fc%23d"]]) {
    assert.equal(m.buildAgentDeepLink({ serverId, agentId }), `paseo:/${route}`);
    assert.equal(m.buildAgentWebLink({ serverId, agentId }), `https://app.paseo.sh${route}`);
  }
  assert.throws(() => m.buildAgentWebLink({ serverId: " ", agentId: "a" }), /server ID/);
});

test("an Additional machine receives the Follow-up opt-in with the resolve it is asked", async () => {
  const m = await load("server/peers.ts", {});
  const original = globalThis.fetch; const bodies = [];
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname === "/v1/ping") return Response.json({ ok: true, name: "send-to-paseo", contract: 1, paired: true, providers: [], daemon: { reachable: true, serverId: "additional" } });
    bodies.push(JSON.parse(init.body));
    return Response.json({ error: { code: "project_not_found", message: "Synthetic" } }, { status: 404 });
  };
  try {
    await m.resolveOnMachine({ id: "vm", label: "Fixture", machineName: "Fixture", bridgeUrl: "https://fixture.invalid", token: "synthetic-token", serverId: "additional", enabled: true }, { forge: "github", owner: "example", repo: "app", number: 7, followUp: true });
    assert.equal(bodies[0]?.followUp, true);
  } finally { globalThis.fetch = original; }
});

test("Follow-up's id: tries follow-up, then follow-through only when follow-up isn't installed", async () => {
  const fresh = async () => (await load("server/follow-up-id.ts", {})).invokeFollowUp; // module state is per load
  const { FOLLOW_UP_PLUGIN_IDS } = await load("server/follow-up-id.ts", {});
  assert.deepEqual([...FOLLOW_UP_PLUGIN_IDS], ["follow-up", "follow-through"]);
  const calls = [];
  const host = installed => async (id, method, input) => { calls.push(id); if (id !== installed) throw new Error(`Request failed: Plugin is not available: ${id} requestType=plugin.rpc.invoke.request`); return { id, method, input }; };
  assert.deepEqual(await (await fresh())(host("follow-up"), "follow.pr-owner", { n: 1 }), { id: "follow-up", method: "follow.pr-owner", input: { n: 1 } });
  assert.deepEqual(calls, ["follow-up"], "2.0: one call");
  calls.length = 0;
  assert.equal((await (await fresh())(host("follow-through"), "follow.pr-owner", {})).id, "follow-through");
  assert.deepEqual(calls, ["follow-up", "follow-through"], "1.x: falls back");
  await assert.rejects((await fresh())(host("none"), "follow.pr-owner", {}), /not available: follow-through/, "neither installed: the last absence");
  calls.length = 0;
  await assert.rejects((await fresh())(async id => { calls.push(id); throw new Error("Unknown RPC follow.pr-workspaces"); }, "follow.pr-workspaces", {}), /Unknown RPC/);
  assert.deepEqual(calls, ["follow-up"], "a real error from follow-up is the answer, no second try");
});

test("Follow-up's id: the id that answered is remembered, so an absent id is probed at most once", async () => {
  const { invokeFollowUp } = await load("server/follow-up-id.ts", {});
  const calls = [];
  const host = installed => async id => { calls.push(id); if (id !== installed.current) throw new Error(`Plugin is not available: ${id}`); return id; };
  const only = { current: "follow-through" };
  for (let n = 0; n < 20; n++) assert.equal(await invokeFollowUp(host(only), "follow.browser-exchange", {}), "follow-through");
  assert.equal(calls.filter(id => id === "follow-up").length, 1, "20 polls against a 1.x host probe follow-up once");
  assert.equal(calls.length, 21);
  // 2.0 finishes moving to its new id mid-process: the remembered id goes absent, the other one answers.
  calls.length = 0; only.current = "follow-up";
  assert.equal(await invokeFollowUp(host(only), "follow.browser-exchange", {}), "follow-up");
  assert.deepEqual(calls, ["follow-through", "follow-up"]);
  calls.length = 0;
  for (let n = 0; n < 5; n++) await invokeFollowUp(host(only), "follow.browser-exchange", {});
  assert.deepEqual(calls, Array(5).fill("follow-up"), "and is remembered again");
  // Rollback.
  calls.length = 0; only.current = "follow-through";
  assert.equal(await invokeFollowUp(host(only), "follow.browser-exchange", {}), "follow-through");
  assert.deepEqual(calls, ["follow-up", "follow-through"]);
});

test("Follow-up's id: a real error from the remembered id is not treated as absence", async () => {
  const { invokeFollowUp } = await load("server/follow-up-id.ts", {});
  const calls = [];
  let broken = false;
  const invoke = async id => { calls.push(id); if (id === "follow-up") throw new Error("Plugin is not available: follow-up"); if (broken) throw new Error("Unknown RPC"); return "ok"; };
  await invokeFollowUp(invoke, "m", {});
  calls.length = 0; broken = true;
  await assert.rejects(invokeFollowUp(invoke, "m", {}), /Unknown RPC/);
  assert.deepEqual(calls, ["follow-through"], "no re-probe of follow-up on a non-absence failure");
});

test("Follow-up's id: with neither installed, absence is cached briefly instead of probed on every poll", async () => {
  let clock = 1_000;
  const { invokeFollowUp } = await load("server/follow-up-id.ts", {});
  const calls = [];
  const invoke = async id => { calls.push(id); throw new Error(`Plugin is not available: ${id}`); };
  for (let n = 0; n < 10; n++) await assert.rejects(invokeFollowUp(invoke, "m", {}, () => clock), /not available/);
  assert.equal(calls.length, 2, "one probe of each id");
  clock += 60_000;
  await assert.rejects(invokeFollowUp(invoke, "m", {}, () => clock), /not available/);
  assert.equal(calls.length, 4, "re-probed after the cache expires");
});
