import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addAdditionalMachine,
  clearRecentSends,
  enablePrivateAccess,
  getConnectionCode,
  getStatus,
  removeAdditionalMachine,
  regenerateToken,
  revealToken,
  testAdditionalMachine,
  updateAdditionalMachine,
  updateConfig,
} from "./shared/contracts";
import { getBridgeStatus, restartBridge, runBridge } from "./server/bridge";
import { dependencySnapshot } from "./server/deps";
import {
  listAgentProfiles,
  listEffectiveProviders,
  listModes,
  resolveSelectedProfile,
} from "./server/resolve";
import { settings } from "./server/settings";
import {
  addMachineFromCode,
  enableMachinePrivateAccess,
  getMachineConnectionCode,
  publicMachine,
  testMachine,
} from "./server/peers";

export default function contribute(server: PluginServerContext) {
  server.handle(getStatus, async (_input, { paseo }) => {
    const current = await settings.read();
    const profile = await resolveSelectedProfile(paseo);
    const [status, providerResult, catalog, profileResult, deps] = await Promise.all([
      getBridgeStatus(),
      listEffectiveProviders(paseo, profile),
      listModes(paseo),
      listAgentProfiles(paseo),
      // Cached; a warm snapshot costs nothing, a cold one costs two --version
      // calls and one `gh auth status`, each individually timed out.
      dependencySnapshot(),
    ]);
    return {
      status,
      providers: providerResult.providers,
      providersError: providerResult.error ?? catalog.error,
      modes: catalog.modes,
      profiles: profileResult.profiles,
      profilesError: profileResult.error,
      recentSends: current.recentSends,
      dependencies: deps.dependencies,
      additionalMachines: current.additionalMachines.map(publicMachine),
    };
  });

  server.handle(revealToken, async () => ({ token: (await settings.read()).token }));

  server.handle(regenerateToken, async () => ({
    token: (await settings.regenerateToken()).token,
  }));

  server.handle(
    updateConfig,
    async ({ port, defaultProvider, defaultProfileId, defaultModeId, externalBridgeUrl }) => {
      const before = await settings.read();
      const patch: {
        port?: number;
        defaultProvider?: string | null;
        defaultProfileId?: string | null;
        defaultModeId?: string | null;
        externalBridgeUrl?: string | null;
      } = {};
      if (port !== undefined) patch.port = port;
      if (defaultProvider !== undefined) patch.defaultProvider = defaultProvider;
      if (defaultProfileId !== undefined) patch.defaultProfileId = defaultProfileId;
      if (defaultModeId !== undefined) patch.defaultModeId = defaultModeId;
      if (externalBridgeUrl !== undefined) patch.externalBridgeUrl = externalBridgeUrl;
      await settings.update(patch);
      // Only rebinding the listener needs a restart; a provider or mode change
      // does not.
      if (port !== undefined && port !== before.port) {
        const status = await restartBridge();
        return { status, error: status.error };
      }
      const status = await getBridgeStatus();
      return { status, error: status.error };
    },
  );

  server.handle(clearRecentSends, async () => ({
    removed: await settings.clearRecentSends(),
  }));

  server.handle(addAdditionalMachine, async ({ connectionCode }) => ({
    machine: await addMachineFromCode(connectionCode),
  }));

  server.handle(updateAdditionalMachine, async ({ id, label, enabled }) => {
    const current = await settings.read();
    const before = current.additionalMachines.find((machine) => machine.id === id);
    if (before === undefined) throw new Error("That additional Paseo machine no longer exists.");
    await settings.updateAdditionalMachine(id, {
      ...(label === undefined ? {} : { label }),
      ...(enabled === undefined ? {} : { enabled }),
    });
    const after = (await settings.read()).additionalMachines.find((machine) => machine.id === id);
    if (after === undefined) throw new Error("That additional Paseo machine no longer exists.");
    return { machine: publicMachine(after) };
  });

  server.handle(removeAdditionalMachine, async ({ id }) => ({
    removed: await settings.removeAdditionalMachine(id),
  }));

  server.handle(testAdditionalMachine, async ({ id }) => {
    const machine = (await settings.read()).additionalMachines.find((item) => item.id === id);
    if (machine === undefined) {
      return { ok: false, machineName: null, detail: "That additional Paseo machine no longer exists." };
    }
    return testMachine(machine);
  });

  server.handle(getConnectionCode, async () => getMachineConnectionCode());
  server.handle(enablePrivateAccess, async () => enableMachinePrivateAccess());

  return runBridge();
}
