import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { PLUGIN_VERSION } from "../shared/contracts.ts";

// Render the actual settings component, replacing only host APIs and native
// primitives. No daemon, timers or plugin installation are needed.
const require = createRequire(import.meta.url);
const stubs = {
  react: 'export const useMemo = f => f(); export const useState = v => [v, () => {}];',
  "react-native": 'export const Platform = { OS: "web" }; export const ScrollView = "ScrollView", Text = "Text", View = "View", Pressable = "Pressable", TextInput = "TextInput";',
  "@getpaseo/plugin/client": 'export const useHosts = () => []; export const useRpc = () => () => {}; export const getPaseoClient = () => {};',
  "@getpaseo/plugin/client/react-native": 'export const copyText = () => {}; export const useToast = () => ({});',
  "@getpaseo/plugin/client/ui": 'export const Icon = () => null; export const ExternalLink = () => null;',
  "@tanstack/react-query": 'export const useQuery = () => ({data: null}); export const useQueryClient = () => ({}); export const useMutation = () => ({});',
};
const bundle = await build({
  entryPoints: [new URL("settings.tsx", import.meta.url).pathname], bundle: true,
  write: false, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "host-fixtures", setup(b) {
    b.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: "fixture" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs[args.path] }));
  } }],
});
const mod = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, mod, mod.exports);

test("settings display a selectable plugin version using the host theme in both themes", () => {
  for (const foregroundMuted of ["#676e79", "#98a0ab"]) {
    const tree = mod.exports.SendToPaseoSettings({ theme: { colors: { foregroundMuted } }, host: { id: "dev-box" }, layout: { compact: false } });
    const label = tree.props.children.flat().find(node => node?.type === "Text" && [].concat(node.props.children).join("").startsWith("Send to Paseo "));
    assert.ok(label, "footer version is present even while status is loading");
    assert.equal([].concat(label.props.children).join(""), `Send to Paseo ${PLUGIN_VERSION}`);
    assert.equal(label.props.selectable, true, "version can be copied");
    assert.equal(label.props.style.color, foregroundMuted, "version follows the host theme");
  }
});

test("settings navigation focuses the destination host only when supported", async () => {
  const { openSettingsAgent } = await import("./navigation.ts");
  for (const supportsFocusHost of [true, false, undefined]) {
    const calls = [];
    openSettingsAgent({ supportsFocusHost, openAgent: input => calls.push(input) }, "dev-box", "agent");
    assert.deepEqual(calls, [{ agentId: "agent", serverId: "dev-box", ...(supportsFocusHost === true ? { focusHost: true } : {}) }]);
  }
  assert.doesNotThrow(() => openSettingsAgent(undefined, "dev-box", "agent"));
});
