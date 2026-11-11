import assert from "node:assert/strict";
import test from "node:test";
import { checkDistTags, expectedDistTag } from "../scripts/check-dist-tag.mjs";

test("prereleases use beta and stable releases use latest", () => {
  assert.equal(expectedDistTag("2.4.1-beta.0"), "beta");
  assert.equal(expectedDistTag("2.4.1"), "latest");
});

test("a prerelease on latest is refused", () => {
  assert.throws(() => checkDistTags("2.4.1-beta.0", { beta: "2.4.1-beta.0", latest: "2.4.1-beta.0" }), /latest/);
  assert.equal(checkDistTags("2.4.1-beta.0", { beta: "2.4.1-beta.0", latest: "2.4.0" }), "beta");
});

test("a missing dist-tag is refused", () => {
  assert.throws(() => checkDistTags("2.4.1", { latest: "2.4.0" }), /latest/);
});
