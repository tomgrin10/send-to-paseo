import { z } from "zod";
import { callFollowUp } from "./daemon";
import type { ListedAgent } from "./main-agent";

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
