import { z } from "zod";
import { callFollowUp } from "./daemon";
import type { ListedAgent } from "./main-agent";
import { buildAgentDeepLink, buildAgentWebLink, type FollowUpView } from "../shared/contracts";

const ownerReply = z.object({ owner: z.object({ workspaceId: z.string().min(1).max(200), agentId: z.string().min(1).max(200) }).nullable() });
export type PrOwner = NonNullable<z.infer<typeof ownerReply>["owner"]>;
export async function lookupPrOwner(owner: string, repo: string, number: number): Promise<PrOwner | null> {
  // Missing, old, stopped or broken companions cannot break standalone sends.
  try { return ownerReply.parse(await callFollowUp("follow.pr-owner", { repo: `${owner}/${repo}`, number })).owner; }
  catch { return null; }
}
export function registeredAgent(agents: readonly ListedAgent[], owner: PrOwner | null, workspaceId: string): ListedAgent | null {
  if (!owner || owner.workspaceId !== workspaceId) return null;
  return agents.find(a => a.id === owner.agentId && a.workspaceId === workspaceId && a.archivedAt == null) ?? null;
}

const text = (max: number) => z.string().max(max);
const workspacesReply = z.object({
  tracked: z.boolean(), more: z.number().int().nonnegative().max(10_000),
  workspaces: z.array(z.object({ workspaceId: text(200).min(1), agentId: text(200).min(1), title: text(200), agentStatus: text(40), group: text(20), state: text(200) })).max(3),
});
export type PrWorkspaces = Omit<z.infer<typeof workspacesReply>, "tracked">;
/**
 * Follow-up's owners of a PR, or null when there is nothing to show: Follow-up absent, older than this RPC,
 * broken, or the repository outside the scope it tracks (and therefore advertises to the browser).
 */
export async function lookupPrWorkspaces(owner: string, repo: string, number: number): Promise<PrWorkspaces | null> {
  try {
    const reply = workspacesReply.parse(await callFollowUp("follow.pr-workspaces", { repo: `${owner}/${repo}`, number }));
    return reply.tracked ? { workspaces: reply.workspaces, more: reply.more } : null;
  } catch { return null; }
}
/** Adds this machine's open links and Paseo's own workspace names. Without a server id no link can be built, so nothing is shown. */
export function followUpView(found: PrWorkspaces | null, serverId: string | null, names: ReadonlyMap<string, string>): FollowUpView | undefined {
  if (!found || !serverId) return undefined;
  return {
    more: found.more,
    workspaces: found.workspaces.map(w => ({ ...w, title: names.get(w.workspaceId) || w.title || w.workspaceId, deepLink: buildAgentDeepLink({ serverId, agentId: w.agentId }), webUrl: buildAgentWebLink({ serverId, agentId: w.agentId }) })),
  };
}
