import { readFileSync } from "node:fs";

export function checkRelease(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Expected a release tag such as v1.4.1");
  const version = tag.slice(1);
  const plugin = JSON.parse(readFileSync("plugin/package.json", "utf8"));
  const extension = JSON.parse(readFileSync("extension/package.json", "utf8"));
  const manifest = JSON.parse(readFileSync("extension/public/manifest.json", "utf8"));
  const contract = readFileSync("plugin/shared/contracts.ts", "utf8");
  const pluginVersion = contract.match(/PLUGIN_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  for (const actual of [plugin.version, extension.version, manifest.version, pluginVersion]) {
    if (actual !== version) throw new Error(`Release ${tag} disagrees with version ${actual}`);
  }
  return version;
}

if (process.argv[1]?.endsWith("check-release.mjs")) {
  console.log(`Release versions agree: ${checkRelease(process.env.RELEASE_TAG)}`);
}
