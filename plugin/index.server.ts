import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  clearRecentSends,
  getStatus,
  regenerateToken,
  revealToken,
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
    };
  });

  server.handle(revealToken, async () => ({ token: (await settings.read()).token }));

  server.handle(regenerateToken, async () => ({
    token: (await settings.regenerateToken()).token,
  }));

  server.handle(
    updateConfig,
    async ({ port, defaultProvider, defaultProfileId, defaultModeId }) => {
      const before = await settings.read();
      const patch: {
        port?: number;
        defaultProvider?: string | null;
        defaultProfileId?: string | null;
        defaultModeId?: string | null;
      } = {};
      if (port !== undefined) patch.port = port;
      if (defaultProvider !== undefined) patch.defaultProvider = defaultProvider;
      if (defaultProfileId !== undefined) patch.defaultProfileId = defaultProfileId;
      if (defaultModeId !== undefined) patch.defaultModeId = defaultModeId;
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

  return runBridge();
}
