// node --test --experimental-strip-types shared/chat.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt } from "./contracts.ts";
import { bridgeToolRow, isBridgeStatusTool, provenance } from "./chat.ts";
import { routeLine } from "./route.ts";
import { lead, destination } from "./overview.ts";
import { summaryAttention } from "./summary.ts";

const ref = { forge: "github", owner: "acme", repo: "billing-service", number: 421 };
const pr = { number: 421, title: "Show retry history", headBranch: "feat/retry-history", baseBranch: "feat/invoice-retries", url: "https://github.com/acme/billing-service/pull/421", state: "OPEN" };
const send = (over = {}) => ({ id: "1", at: new Date().toISOString(), prLabel: "acme/billing-service#421", prUrl: pr.url, workspaceLabel: "Invoice retry backoff", branch: "feat/invoice-retries", agentId: "a1", deepLink: null, title: "PR #421 · Add a column", provider: "claude", modeId: null, workspaceCreated: false, dryRun: false, outcome: "ok", error: null, ...over });

test("the card reads back exactly what composePrompt wrote", () => {
  const text = composePrompt({ ref, pr, prompt: "Add a column.\n\nKeep it small.", pageUrl: "https://app.graphite.com/github/pr/acme/billing-service/421" });
  const card = provenance(text);
  assert.ok(card);
  assert.equal(card.repo, "acme/billing-service");
  assert.equal(card.number, 421);
  assert.equal(card.title, "Show retry history");
  assert.equal(card.head, "feat/retry-history");
  assert.equal(card.base, "feat/invoice-retries");
  assert.equal(card.site, "graphite");
  assert.equal(card.instruction, "Add a column.\n\nKeep it small.");
  assert.equal(card.branchState, null);
});

test("stack siblings, merged branches and the degraded header", () => {
  const sibling = provenance(composePrompt({ ref, pr, prompt: "x", workspaceBranch: "feat/invoice-retries", pageUrl: "https://github.com/acme/billing-service/pull/421" }));
  assert.equal(sibling?.branchState, "sibling");
  assert.equal(sibling?.workspaceBranch, "feat/invoice-retries");
  assert.equal(sibling?.site, "github");
  const merged = provenance(composePrompt({ ref, pr, prompt: "x", workspaceBranch: "old", workspaceBranchState: "merged" }));
  assert.equal(merged?.branchState, "merged");
  assert.equal(routeLine(merged, null).attention, true);
  const degraded = provenance(composePrompt({ ref, pr, prompt: "x", workspaceBranch: "wb", prMetadataNote: "Note: gh is missing." }));
  assert.equal(degraded?.degraded, true);
  assert.equal(degraded?.title, null);
  assert.equal(degraded?.site, null);
});

test("ordinary messages are left alone", () => {
  assert.equal(provenance("Fix the test"), null);
  assert.equal(provenance("[Sent from Graphite — github/acme/x PR #1]\nno blank line"), null);
});

test("route line names workspace, branch and dispatch", () => {
  const card = provenance(composePrompt({ ref, pr, prompt: "x" }));
  assert.equal(routeLine(card, send({ dispatch: "main", title: "Main" })).text, "Invoice retry backoff · on the PR's branch · sent to this agent");
  assert.equal(routeLine(card, send({ workspaceCreated: true, dispatch: "new" })).text, "New worktree for #421 · new agent");
  assert.equal(routeLine(card, null).text, "On the PR's branch");
  assert.equal(routeLine(card, send({ workspaceLabel: "brawny-dodo" })).text, "brawny-dodo · on the PR's branch");
});

test("bridge tool rows", () => {
  assert.ok(isBridgeStatusTool("mcp__paseo__send_to_paseo_bridge_status"));
  assert.ok(isBridgeStatusTool("paseo.send_to_paseo_bridge_status"));
  assert.ok(!isBridgeStatusTool("mcp__paseo__other"));
  const ok = bridgeToolRow("completed", JSON.stringify({ state: "running", port: 7788, paired: true, dependencies: [{ name: "gh", state: "ok" }] }), null);
  assert.equal(ok.line, "Checked the Send to Paseo bridge · listening on 7788 · paired");
  assert.equal(ok.tone, "neutral");
  const warn = bridgeToolRow("completed", [{ type: "text", text: JSON.stringify({ state: "running", port: 7788, paired: false, dependencies: [{ name: "gh", state: "missing" }] }) }], null);
  assert.equal(warn.line, "Checked the Send to Paseo bridge · listening on 7788 · not paired yet · gh missing");
  assert.equal(warn.tone, "warning");
});

test("overview lead and sidebar attention", () => {
  const status = { state: "running", port: 7788, configuredPort: 7788, error: null, paired: false, tokenPreview: "ab…cd", daemon: { version: "0.15.2" } };
  assert.equal(lead(status, []).kind, "setup");
  assert.equal(lead({ ...status, paired: true }, []).text, "Paired with Chrome");
  assert.match(lead({ ...status, paired: true }, [send()]).text, /1 send today/);
  assert.equal(lead({ ...status, state: "failed", error: "EADDRINUSE" }, []).kind, "down");
  assert.equal(destination(send({ dispatch: "main", title: "Main" })), "Invoice retry backoff · messaged Main");
  assert.equal(summaryAttention({ state: "running", paired: false, lastSendAt: null, lastSendFailed: false })?.tone, "warning");
  assert.equal(summaryAttention({ state: "running", paired: true, lastSendAt: null, lastSendFailed: false }), null);
  assert.equal(summaryAttention({ state: "failed", paired: true, lastSendAt: null, lastSendFailed: false })?.tone, "danger");
});

test("failed sends name the cause and the fix", async () => {
  const { failure } = await import("./overview.ts");
  assert.match(failure(send({ outcome: "failed", prLabel: "acme/web-app#81", error: "Paseo could not create a worktree for PR #81: Unable to resolve GitHub repository for pull request checkout" })), /^Paseo couldn't check out PR #81\. Add acme\/web-app as a project in Paseo/);
  assert.equal(failure(send({ outcome: "failed", error: "Something new" })), "Something new");
});
