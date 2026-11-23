import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

/** Open a recent send on its own host. */
export function openSettingsAgent(navigation: PluginSurfaceProps["navigation"], serverId: string, agentId: string): void {
  const target = navigation as (NonNullable<PluginSurfaceProps["navigation"]> & { supportsFocusHost?: boolean }) | undefined;
  target?.openAgent({ agentId, serverId, ...(target.supportsFocusHost === true ? { focusHost: true } : {}) });
}
