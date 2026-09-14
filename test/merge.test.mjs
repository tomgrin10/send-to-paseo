import assert from "node:assert/strict";
import test from "node:test";

import { clampIndex, mergeHostAnswers, primaryFailure } from "../extension/src/shared/merge.ts";

function candidate(label, rank) {
  return { kind: "existing", workspaceId: label, label, rank, reason: "stack" };
}

function host(hostId, candidates, defaultCandidateIndex = 0) {
  return {
    hostId,
    hostLabel: hostId,
    bridgeAuthority: `${hostId}.example:7788`,
    resolved: {
      pr: {
        number: 42,
        title: "Example",
        headBranch: "feature/example",
        baseBranch: "main",
        state: "open",
        url: "https://github.com/acme/widgets/pull/42",
      },
      project: { projectId: hostId, name: "widgets", path: "/work/widgets" },
      candidates,
      defaultCandidateIndex,
      providers: [],
    },
    error: null,
  };
}

test("merges host candidates by rank while preserving each host's local ordering", () => {
  const laptop = host("laptop", [candidate("laptop-near", 2), candidate("laptop-far", 2), candidate("laptop-create", 4)]);
  const devbox = host("devbox", [candidate("devbox-exact", 1), candidate("devbox-stack", 2), candidate("devbox-create", 4)]);

  const merged = mergeHostAnswers([laptop, devbox]);

  assert.deepEqual(
    merged.candidates.map(({ label, hostIndex }) => [label, hostIndex]),
    [
      ["devbox-exact", 1],
      ["laptop-near", 0],
      ["devbox-stack", 1],
      ["laptop-far", 0],
      ["laptop-create", 0],
      ["devbox-create", 1],
    ],
  );
  assert.equal(merged.defaultCandidateIndex, 0);
});

test("honours each host's declared default and keeps malformed ranks from winning", () => {
  const first = host("first", [candidate("first-exact-but-not-default", 1), candidate("first-default", 3)], 1);
  const second = host("second", [candidate("second-default", 2)], 0);
  const malformed = host("malformed", [candidate("bad-rank", Number.NaN)], 0);

  const merged = mergeHostAnswers([first, second, malformed]);

  assert.equal(merged.candidates[merged.defaultCandidateIndex]?.label, "second-default");
  assert.equal(merged.candidates.at(-1)?.label, "bad-rank");
  assert.equal(clampIndex(-1, 2), 0);
  assert.equal(clampIndex(4, 2), 0);
  assert.equal(clampIndex(1.8, 2), 1);
  assert.equal(clampIndex(0, 0), 0);
});

test("prefers an actionable total failure over an unreachable host", () => {
  const unreachable = {
    ...host("sleeping", []),
    resolved: null,
    error: { code: "bridge_unreachable", message: "Tunnel is down." },
  };
  const unpaired = {
    ...host("new-machine", []),
    resolved: null,
    error: { code: "not_configured", message: "Pair this host first." },
  };

  assert.equal(primaryFailure([unreachable, unpaired]), unpaired);
  assert.equal(primaryFailure([]), null);
});
