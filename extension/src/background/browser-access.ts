import type { HostConfig } from "./settings";
import type { GraphiteCommand } from "../shared/follow-through";

export interface BrowserGrant { hostId: string; routeId: string; serverId: string; binding: string; repo: string; enable_toggle_changes?: boolean }
export interface BrowserRoute { hostId: string; routeId: string; serverId: string; binding: string; label: string; available: boolean; repositories?: string[] }
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
  return route.available && (route.repositories?.includes(command.repo.toLowerCase()) === true || grants.some(g => g.hostId === route.hostId && g.routeId === route.routeId && g.serverId === route.serverId && g.binding === route.binding && g.repo === command.repo.toLowerCase()));
}

export function allowsToggleChanges(grants: BrowserGrant[], route: BrowserRoute, command: GraphiteCommand): boolean {
  return permits(grants, route, command) && grants.some(g => g.hostId === route.hostId && g.routeId === route.routeId && g.serverId === route.serverId && g.binding === route.binding && g.repo === command.repo.toLowerCase() && g.enable_toggle_changes === true);
}

// Disabling this revokes browser execution without forgetting Send pairing or explicit grants.
export async function followUpEnabled(): Promise<boolean> {
  return (await chrome.storage.local.get("enableGraphiteFollowUp")).enableGraphiteFollowUp !== false;
}
export async function setFollowUpEnabled(enabled: boolean) {
  await chrome.storage.local.set({ enableGraphiteFollowUp: enabled });
}

let grantWrites = Promise.resolve();
export function updateGrants(update: (grants: BrowserGrant[]) => BrowserGrant[]): Promise<void> {
  const next = grantWrites.then(async () => saveGrants(update(await readGrants())));
  grantWrites = next.catch(() => undefined);
  return next;
}
