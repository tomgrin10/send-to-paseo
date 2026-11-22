import { z } from "zod";
import { callFollowUp, isFollowUpUnreachable } from "./daemon";
import type { ListedAgent } from "./main-agent";
import { buildAgentDeepLink, buildAgentWebLink, type Candidate, type FollowUpView } from "../shared/contracts";

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
  workspaces: z.array(z.object({
    workspaceId: text(200).min(1), agentId: text(200).min(1), title: text(200), agentStatus: text(40), group: text(20), state: text(200),
    // Additive: an unknown tone is dropped, never a reason to drop the row or the view.
    tone: z.enum(["attention", "danger", "success", "accent", "muted"]).optional().catch(undefined),
  })).max(3),
});
export type PrWorkspaces = Omit<z.infer<typeof workspacesReply>, "tracked">;
/** Follow-up could not be asked in time (not connected, budget spent, socket gone). Not "none". */
export const FOLLOW_UP_UNKNOWN = "unknown" as const;
/**
 * Follow-up's owners of a PR; null when there is nothing to show (Follow-up absent, older than this RPC,
 * broken, or the repository outside the scope it tracks and therefore advertises to the browser); or
 * `"unknown"` when it could not be asked. Unknown must never read as none (optional-lookup-never-silent).
 * Never waits on a daemon connect: the popover's click path does not pay for one (warm-daemon-connection).
 */
export async function lookupPrWorkspaces(owner: string, repo: string, number: number): Promise<PrWorkspaces | null | typeof FOLLOW_UP_UNKNOWN> {
  let raw: unknown;
  try { raw = await callFollowUp("follow.pr-workspaces", { repo: `${owner}/${repo}`, number }, { ifConnected: true }); }
  catch (error) { return isFollowUpUnreachable(error) ? FOLLOW_UP_UNKNOWN : null; }
  const reply = workspacesReply.safeParse(raw);
  return reply.success && reply.data.tracked ? { workspaces: reply.data.workspaces, more: reply.data.more } : null;
}
/** Adds this machine's open links and Paseo's own workspace names. Without a server id no link can be built, so nothing is shown. */
export function followUpView(found: PrWorkspaces | null, serverId: string | null, names: ReadonlyMap<string, string>): FollowUpView | undefined {
  if (!found || !serverId) return undefined;
  return {
    more: found.more,
    workspaces: found.workspaces.map(w => ({ ...w, title: names.get(w.workspaceId) || w.title || w.workspaceId, deepLink: buildAgentDeepLink({ serverId, agentId: w.agentId }), webUrl: buildAgentWebLink({ serverId, agentId: w.agentId }) })),
  };
}
/**
 * The resolve answer's Follow-up fields. When the workspaces lookup is unknown it says so
 * (`followUpUnreachable`), and still offers the registered owner from `follow.pr-owner` when that
 * owner's agent is one of this PR's candidates, with the same open links as `followUpView`.
 */
export function followUpAnswer(
  found: PrWorkspaces | null | typeof FOLLOW_UP_UNKNOWN,
  owner: PrOwner | null,
  candidates: readonly Candidate[],
  serverId: string | null,
  names: ReadonlyMap<string, string>,
): { followUp?: FollowUpView; followUpUnreachable?: true } {
  if (found !== FOLLOW_UP_UNKNOWN) { const view = followUpView(found, serverId, names); return view ? { followUp: view } : {}; }
  const registered = owner ? candidates.find(c => c.kind === "existing" && c.workspaceId === owner.workspaceId && c.followUpAgent?.agentId === owner.agentId) : undefined;
  const agent = registered?.kind === "existing" ? registered.followUpAgent : undefined;
  const fallback = owner && agent
    ? followUpView({ more: 0, workspaces: [{ workspaceId: owner.workspaceId, agentId: owner.agentId, title: "", agentStatus: agent.status, group: "", state: "" }] }, serverId, names)
    : undefined;
  return { followUpUnreachable: true, ...(fallback ? { followUp: fallback } : {}) };
}
