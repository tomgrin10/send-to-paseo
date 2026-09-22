import type { PluginHostSummary } from "@getpaseo/plugin/client";
import type { AdditionalMachine } from "../shared/contracts";

export interface DiscoveredHostRow extends PluginHostSummary {
  readonly isSurfaceHost: boolean;
  readonly route: AdditionalMachine | null;
}

export interface HostDiscoveryModel {
  readonly hosts: readonly DiscoveredHostRow[];
  /** Bridge routes retained for compatibility but absent from Paseo's configured host list. */
  readonly undiscoveredRoutes: readonly AdditionalMachine[];
}

/**
 * Join Paseo's live host inventory to the bridge's saved routes by serverId.
 *
 * Names and URLs are deliberately not fallback keys: both can change, and a
 * fuzzy match here could make a later Send target the wrong daemon.
 */
export function organizeDiscoveredHosts(
  hosts: readonly PluginHostSummary[],
  surfaceServerId: string,
  routes: readonly AdditionalMachine[],
): HostDiscoveryModel {
  const routesByServerId = new Map<string, AdditionalMachine>();
  for (const route of routes) {
    if (route.serverId !== null && !routesByServerId.has(route.serverId)) {
      routesByServerId.set(route.serverId, route);
    }
  }
  const discoveredIds = new Set(hosts.map((host) => host.serverId));
  return {
    hosts: hosts.map((host) => ({
      ...host,
      isSurfaceHost: host.serverId === surfaceServerId,
      route: routesByServerId.get(host.serverId) ?? null,
    })),
    undiscoveredRoutes: routes.filter(
      (route) => route.serverId === null || !discoveredIds.has(route.serverId),
    ),
  };
}

export interface TargetedHostClient {
  readonly projects: {
    list(): Promise<{ projects: readonly unknown[] }>;
  };
}

export type HostClientGetter = (serverId: string) => TargetedHostClient;

/**
 * Perform one read through an explicitly targeted host client.
 *
 * The getter is called for every action instead of retaining a PaseoApi. That
 * is the 0.9 lifecycle contract: a same-client reconnect remains usable, but a
 * replaced connection releases the old API and the next action must reacquire
 * it. Unknown and disconnected errors are intentionally allowed to escape;
 * there is no selected/local-host fallback.
 */
export async function checkHostAccess(
  serverId: string,
  getClient: HostClientGetter,
): Promise<number> {
  if (serverId.trim() === "") throw new Error("A Paseo server ID is required.");
  const client = getClient(serverId);
  const { projects } = await client.projects.list();
  return projects.length;
}
