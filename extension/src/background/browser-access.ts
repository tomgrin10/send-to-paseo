import type { HostConfig } from "./settings";
import type { GraphiteCommand } from "../shared/follow-through";

export interface BrowserGrant { hostId: string; routeId: string; serverId: string; binding: string; repo: string; enable_toggle_changes?: boolean }
export interface BrowserRoute { hostId: string; routeId: string; serverId: string; binding: string; label: string; available: boolean }
const KEY = "graphiteBrowserGrants";
export const validRepo = (s: unknown): s is string => typeof s === "string" && s.length <= 201 && /^[\w.-]+\/[\w.-]+$/.test(s) && s.split("/").every(p => p !== "." && p !== "..");
/** Re-pairing or changing a bridge invalidates its old browser authority. */
export async function bridgeBinding(host: HostConfig): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([host.id, host.bridgeUrl, host.token]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
export async function readGrants(): Promise<BrowserGrant[]> {
  const raw = (await chrome.storage.local.get(KEY))[KEY];
  return Array.isArray(raw) ? raw.filter(g => g && [g.hostId, g.routeId, g.serverId, g.binding].every(v => typeof v === "string" && !!v) && validRepo(g.repo)) : [];
}
export async function saveGrants(grants: BrowserGrant[]) { await chrome.storage.local.set({ [KEY]: grants }); }
export function permits(grants: BrowserGrant[], route: BrowserRoute, command: GraphiteCommand): boolean {
  return route.available && grants.some(g => g.hostId === route.hostId && g.routeId === route.routeId && g.serverId === route.serverId && g.binding === route.binding && g.repo === command.repo.toLowerCase());
}

export function allowsToggleChanges(grants: BrowserGrant[], route: BrowserRoute, command: GraphiteCommand): boolean {
  return permits(grants, route, command) && grants.some(g => g.hostId === route.hostId && g.routeId === route.routeId && g.serverId === route.serverId && g.binding === route.binding && g.repo === command.repo.toLowerCase() && g.enable_toggle_changes === true);
}
