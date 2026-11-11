import { readFileSync } from "node:fs";
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

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");

test("the publish command always passes the tag from expectedDistTag", () => {
  const publishes = workflow.match(/\["publish"[^\]]*\]/g) ?? [];
  assert.equal(publishes.length, 1);
  assert.match(publishes[0], /"--tag", expectedDistTag\(pkg\.version\)/);
  assert.doesNotMatch(workflow, /npm publish/);
});

test("the dist-tag is verified after publishing, on the retry path too", () => {
  const publishAt = workflow.indexOf('["publish"');
  const verifyAt = workflow.indexOf("waitForDistTags(pkg.name, pkg.version)");
  const retryAt = workflow.indexOf("already published with matching contents");
  assert.ok(publishAt > 0 && verifyAt > publishAt && verifyAt > retryAt);
  assert.match(workflow, /import \{[^}]*waitForDistTags[^}]*\} from "\.\.\/scripts\/check-dist-tag\.mjs"/);
});

test("prerelease guards use the classified tag, never github.ref_name alone", () => {
  assert.doesNotMatch(workflow, /contains\(github\.ref_name/);
  const guards = workflow.match(/^\s+if: .*prerelease.*$/gm) ?? [];
  assert.equal(guards.length, 4); // package, upload, download, chrome
});

test("every job that reads needs.<job>.outputs lists <job> in its own needs", () => {
  const jobs = workflow.split(/^jobs:\n/m)[1].split(/^  (?=[\w-]+:\n)/m).filter(Boolean);
  assert.ok(jobs.length >= 3);
  for (const job of jobs) {
    const id = job.match(/^([\w-]+):/)[1];
    const listed = job.match(/^    needs: (.+)$/m)?.[1].replace(/[\[\]\s]/g, "").split(",") ?? [];
    for (const [, read] of job.matchAll(/needs\.([\w-]+)\.outputs/g)) {
      assert.ok(listed.includes(read), `job ${id} reads needs.${read}.outputs but needs only [${listed}]`);
    }
  }
});
