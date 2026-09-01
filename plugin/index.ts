import type { PluginContext } from "@getpaseo/plugin";
import {
  clearRecentSends,
  getStatus,
  regenerateToken,
  revealToken,
  updateConfig,
} from "./contracts.shared";
import { lifecycle } from "./lifecycle.shared";
import { SendToPaseoSettings } from "./settings.client";
import { getBridgeStatus, restartBridge } from "./bridge.server";
import { dependencySnapshot } from "./deps.server";
import { listAgentProfiles, listEffectiveProviders, listModes, resolveSelectedProfile } from "./resolve.server";
import { settings } from "./settings.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(getStatus, async (_input, { paseo }) => {
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

  plugin.handle(revealToken, async () => ({ token: (await settings.read()).token }));

  plugin.handle(regenerateToken, async () => ({ token: (await settings.regenerateToken()).token }));

  plugin.handle(updateConfig, async ({ port, defaultProvider, defaultProfileId, defaultModeId }) => {
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
  });

  plugin.handle(clearRecentSends, async () => ({ removed: await settings.clearRecentSends() }));

  plugin.addSurface("settings", SendToPaseoSettings);
  plugin.addSidebarItem({
    id: "send-to-paseo",
    title: "Send to Paseo",
    icon: "Send",
    surface: "settings",
  });
  plugin.addCommandCenterItem({
    id: "send-to-paseo-settings",
    title: "Send to Paseo: bridge settings",
    icon: "Send",
    keywords: ["graphite", "bridge", "token", "pull request", "extension"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("settings");
    },
  });

  // Stops the HTTP listener through a shared object rather than by naming
  // bridge.server: Paseo strips server imports from the client bundle but keeps
  // the surrounding code, so a server identifier here would break every
  // contribution. Skipping this leaves a listening socket holding the
  // subprocess event loop open, which hangs Paseo's "Stopping plugin" step and
  // wedges `paseo plugin reload`.
  return async () => {
    const teardown = lifecycle.teardown;
    lifecycle.teardown = null;
    await teardown?.();
  };
}
