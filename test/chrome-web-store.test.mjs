import { test } from "node:test";
import assert from "node:assert/strict";
import { publishExtension } from "../scripts/chrome-web-store.mjs";

const config = {
  publisherId: "publisher", itemId: "blflbbgkckbabbkoigpocilbkkmfijfg",
  token: "test-credential", version: "1.4.1", zip: Buffer.from("test ZIP"),
};
const revision = (state, version) => ({ state, distributionChannels: [{ crxVersion: version }] });
function harness(responses, options = {}) {
  const calls = [], logs = [];
  return {
    calls, logs,
    run: (overrides = {}) => publishExtension({ ...config, ...overrides }, {
      fetchImpl: async (url, init) => {
        calls.push({ url, ...init });
        assert.equal(init.headers.Authorization, `Bearer ${config.token}`);
        assert.ok(responses.length, "Unexpected API call");
        const response = responses.shift();
        return new Response(JSON.stringify(response.body ?? response), { status: response.httpStatus ?? 200 });
      },
      sleep: async () => {}, log: (value) => logs.push(value), pollAttempts: 2, ...options,
    }),
  };
}

test("upload processing finishes before review submission; approval publishes automatically", async () => {
  const h = harness([
    {}, { uploadState: "IN_PROGRESS" }, { lastAsyncUploadState: "IN_PROGRESS" },
    { lastAsyncUploadState: "SUCCEEDED" }, { state: "PENDING_REVIEW" },
  ]);
  assert.equal((await h.run()).state, "PENDING_REVIEW");
  assert.equal(h.calls[1].body, config.zip);
  assert.match(h.calls[1].url, /\/upload\/v2\/publishers\/publisher\/items\/.+:upload$/);
  assert.deepEqual(JSON.parse(h.calls.at(-1).body), {
    publishType: "DEFAULT_PUBLISH", skipReview: false, blockOnWarnings: false,
  });
});

test("immediate successful upload submits once", async () => {
  const h = harness([{}, { uploadState: "SUCCEEDED", crxVersion: "1.4.1" }, { state: "PENDING_REVIEW" }]);
  assert.equal((await h.run()).outcome, "submitted");
  assert.equal(h.calls.length, 3);
});

test("rerunning an already pending or published version makes no mutations", async () => {
  for (const [field, state] of [
    ["submittedItemRevisionStatus", "PENDING_REVIEW"], ["publishedItemRevisionStatus", "PUBLISHED"],
  ]) {
    const h = harness([{ [field]: revision(state, "1.4.1") }]);
    assert.equal((await h.run()).outcome, "already-submitted");
    assert.equal(h.calls.length, 1);
  }
});

test("different pending/staged version and stale release cannot overwrite store state", async () => {
  for (const status of [
    { submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.4.0") },
    { submittedItemRevisionStatus: revision("STAGED", "1.4.1") },
    { publishedItemRevisionStatus: revision("PUBLISHED", "1.5.0") },
    { submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.4.2") },
    {
      publishedItemRevisionStatus: revision("PUBLISHED", "1.4.1"),
      submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.4.2"),
    },
  ]) {
    const h = harness([status]);
    await assert.rejects(h.run(), /Another submission|newer version/);
    assert.equal(h.calls.length, 1);
  }
});

test("failed, unknown, mismatched and timed out uploads never publish", async () => {
  for (const response of [
    { uploadState: "FAILED" }, {}, { uploadState: "SUCCEEDED", crxVersion: "1.4.2" },
    { uploadState: "UPLOAD_IN_PROGRESS" },
  ]) {
    const h = harness([{}, response, { lastAsyncUploadState: "IN_PROGRESS" }, { lastAsyncUploadState: "IN_PROGRESS" }]);
    await assert.rejects(h.run(), /Upload did not succeed|version does not match/);
    assert.ok(h.calls.every((call) => !call.url.endsWith(":publish")));
  }
});

test("API errors fail without retrying a mutation or logging the credential", async () => {
  const h = harness([{}, { httpStatus: 403, body: { error: { message: `Denied ${config.token}` } } }]);
  await assert.rejects(h.run(), (error) => error.message.includes("403") && !error.message.includes(config.token));
  assert.equal(h.calls.length, 2);
});

test("status check makes only a read request", async () => {
  const h = harness([{ submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.4.0") }]);
  assert.equal((await h.run({ operation: "status", version: undefined, zip: undefined })).outcome, "status");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, undefined);
});

test("invalid config and policy flags stop publishing", async () => {
  const h = harness([]);
  await assert.rejects(h.run({ publisherId: "" }), /CWS_PUBLISHER_ID/);
  await assert.rejects(h.run({ itemId: "wrong" }), /CWS_EXTENSION_ID/);
  await assert.rejects(h.run({ token: "" }), /CWS_ACCESS_TOKEN/);
  assert.equal(h.calls.length, 0);
  for (const flag of ["warned", "takenDown"]) {
    const denied = harness([{ [flag]: true }]);
    await assert.rejects(denied.run(), /policy/);
    assert.equal(denied.calls.length, 1);
  }
});

test("publish failures and unexpected response states remain failures", async () => {
  for (const response of [{ httpStatus: 400, body: { error: { message: "Listing incomplete" } } }, { state: "REJECTED" }]) {
    const h = harness([{}, { uploadState: "SUCCEEDED" }, response]);
    await assert.rejects(h.run(), /HTTP 400|Unexpected submission state/);
    assert.equal(h.calls.length, 3);
  }
});
