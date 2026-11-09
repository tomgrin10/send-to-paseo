/** Real daemon verification; requires the synthetic Follow Up preview, never a user daemon. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const { DaemonClient } = require("@getpaseo/client/internal/daemon-client");
const { createPaseoApi } = require("@getpaseo/client");
const exec = promisify(execFile);
assert.ok(process.env.STP_FOLLOW_UP_FIXTURE, "Set STP_FOLLOW_UP_FIXTURE to the isolated .preview-isolated.json");
const fixture = JSON.parse(await readFile(process.env.STP_FOLLOW_UP_FIXTURE, "utf8"));
assert.ok(fixture.root.startsWith("/tmp/follow-install-") && resolve(fixture.home) === join(fixture.root, "home"), "Only the synthetic Follow Up fixture is allowed");
const number = Math.floor(Date.now() / 1000) % 1_000_000 + 1000;
const { port, token } = JSON.parse(await readFile(join(fixture.home, "plugin-data/send-to-paseo/settings.json"), "utf8"));
const client = new DaemonClient({ url: `ws://127.0.0.1:${fixture.port}/ws`, clientId: "routing-fixture", clientType: "cli", reconnect: { enabled: false } });
await client.connect(); const api = createPaseoApi(client);
try {
  await exec("paseo", ["--home", fixture.home, "plugin", "reload", "send-to-paseo"], { env: { ...process.env, HOME: fixture.home, PASEO_HOME: fixture.home, PASEO_DAEMON_URL: `ws://127.0.0.1:${fixture.port}/ws` } });
  const path = join(fixture.root, `routing-repository-${Date.now()}`); await mkdir(path, { recursive: true });
  await exec("git", ["init", "-b", "routing-feature", path]);
  await writeFile(join(path, "README.md"), "Synthetic routing fixture.\n");
  await exec("git", ["-C", path, "add", "README.md"]);
  await exec("git", ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic fixture"]);
  await exec("git", ["-C", path, "remote", "add", "origin", "https://github.com/example/routing-fixture.git"]);
  const gh = join(fixture.root, "bin/gh"); const old = await readFile(gh, "utf8");
  await writeFile(gh, old.replace(/^#![^\n]*\n/, `#!/usr/bin/env node\nif(process.argv[2]==='pr' && process.argv[3]==='view'){const n=Number(process.argv[4]);console.log(JSON.stringify({number:n,title:'Synthetic routing PR',headRefName:'routing-feature',baseRefName:'main',state:'OPEN',url:'https://github.com/example/routing-fixture/pull/'+n}));process.exit(0)}\n`));
  const w = await api.workspaces.create({ title: "Synthetic registration routing", source: { kind: "directory", path } });
  const owner = await w.agents.create({ config: { provider: "followthrough-fixture/fixture", model: "fixture", modeId: "default" }, title: "Original PR agent" });
  const call = (method, input) => client.invokePluginRpc("follow-through", method, input);
  await call("follow.activate", { workspaceId: w.id });
  await call("follow.enroll", { agentId: owner.id, goal: "Verify synthetic PR routing" });
  await call("follow.register-pr", { agentId: owner.id, repo: "example/routing-fixture", number, stack: "Synthetic stack" });
  const decoy = await w.agents.create({ config: { provider: "followthrough-fixture/fixture" }, title: "Main" });
  const bridge = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const reply = await r.json(); assert.equal(r.status, 200, JSON.stringify(reply)); return reply;
  };
  const ref = { forge: "github", owner: "example", repo: "routing-fixture", number };
  const resolved = await bridge("/v1/resolve", ref);
  const selected = resolved.candidates[resolved.defaultCandidateIndex];
  assert.equal(selected.workspaceId, w.id); assert.equal(selected.followUpAgent.agentId, owner.id); assert.equal(selected.mainAgent.agentId, decoy.id);
  assert.equal(resolved.followUp, undefined, "the Follow-up view is opt-in");
  const serverId = (await readFile(join(fixture.home, "server-id"), "utf8")).trim();
  const viewed = await bridge("/v1/resolve", { ...ref, followUp: true });
  assert.equal(viewed.followUp.more, 0); assert.equal(viewed.followUp.workspaces.length, 1);
  const [ownerView] = viewed.followUp.workspaces;
  assert.equal(ownerView.workspaceId, w.id); assert.equal(ownerView.agentId, owner.id); assert.match(ownerView.state, /\S/); assert.ok(ownerView.title);
  assert.equal(ownerView.deepLink, `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(owner.id)}`);
  assert.equal(ownerView.webUrl, `https://app.paseo.sh/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(owner.id)}`);
  assert.deepEqual((await bridge("/v1/resolve", { ...ref, number: number + 1, followUp: true })).followUp, { workspaces: [], more: 0 }, "tracked repository, unowned PR");
  console.log(`followUp view: ${ownerView.title} · ${ownerView.state} · agent ${ownerView.agentStatus}`);
  const sent = await bridge("/v1/send", { ...ref, prompt: "Synthetic routing assertion", target: { kind: "existing", workspaceId: w.id }, agentDispatch: "main", followUpAgentId: owner.id });
  assert.equal(sent.agentId, owner.id); assert.equal(sent.agentCreated, false); assert.notEqual(sent.agentId, decoy.id);
  for (let i = 0; i < 50; i++) {
    const receipts = await readFile(join(fixture.home, "fixture-receipts.jsonl"), "utf8").catch(() => "");
    if (receipts.split("\n").filter(Boolean).map(l => JSON.parse(l)).some(r => r.agentId === owner.id && JSON.stringify(r).includes("Synthetic routing assertion"))) break;
    if (i === 49) throw new Error("Synthetic provider did not receive the routed message"); await new Promise(r => setTimeout(r, 100));
  }
  const fresh = await bridge("/v1/send", { ...ref, prompt: "Synthetic explicit new agent", target: { kind: "existing", workspaceId: w.id }, agentDispatch: "new", provider: "followthrough-fixture/fixture" });
  assert.equal(fresh.agentCreated, true); assert.notEqual(fresh.agentId, owner.id);
  console.log("PASS: real installed plugins resolve the registered agent over a newer Main, deliver once to the synthetic provider, and honor explicit new-agent dispatch.");
} finally { await api.dispose(); await client.close(); }
