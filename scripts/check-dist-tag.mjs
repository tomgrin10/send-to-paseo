import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// A prerelease belongs on beta and a stable release on latest. Never let a prerelease be latest.
export function expectedDistTag(version) {
  return version.includes("-") ? "beta" : "latest";
}

export function checkDistTags(version, tags) {
  const tag = expectedDistTag(version);
  if (tag === "beta" && tags.latest === version) throw new Error(`Prerelease ${version} is tagged latest`);
  if (tags[tag] !== version) throw new Error(`The ${tag} dist-tag is ${tags[tag]}, expected ${version}`);
  return tag;
}

if (process.argv[1]?.endsWith("check-dist-tag.mjs")) {
  const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
  let last;
  for (let attempt = 0; attempt < 60; attempt++) {
    const view = spawnSync("npm", ["view", name, "dist-tags", "--json", "--prefer-online", "--registry", "https://registry.npmjs.org"], { encoding: "utf8" });
    if (view.status === 0) {
      try { console.log(`Registry verified: ${name}@${version} is ${checkDistTags(version, JSON.parse(view.stdout))}.`); process.exit(0); }
      catch (error) { last = error; if (/tagged latest/.test(error.message)) throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw last ?? new Error("Could not read dist-tags");
}
