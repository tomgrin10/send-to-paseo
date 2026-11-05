import type { Provenance } from "./chat";
import type { RecentSend } from "./contracts";

/** "GitHub" / "Graphite", or null when the send carried no page URL. */
export function siteLabel(site: Provenance["site"]): string | null {
  return site === "github" ? "GitHub" : site === "graphite" ? "Graphite" : null;
}

/**
 * Why the send landed where it did, in one line. The prompt header says which
 * branch the workspace is on; the recorded send (when this host still has it)
 * adds the workspace name, whether a worktree was created, and whether the
 * message started an agent or reached the workspace's main one.
 */
export function routeLine(card: Provenance, send: RecentSend | null): { text: string; attention: boolean } {
  const parts: string[] = [];
  let attention = false;
  if (send?.workspaceCreated) parts.push(`New worktree for #${card.number}`);
  else if (send !== null) parts.push(send.workspaceLabel);
  if (!send?.workspaceCreated) {
    if (card.branchState === "merged") { parts.push(`on ${card.workspaceBranch}, a merged branch of this stack`); attention = true; }
    else if (card.branchState === "closed") { parts.push(`on ${card.workspaceBranch}, a closed branch of this stack`); attention = true; }
    else if (card.branchState === "sibling") parts.push(`on ${card.workspaceBranch}, another branch of this stack`);
    else if (card.degraded) parts.push(card.workspaceBranch === null ? "PR details unavailable (gh)" : `on ${card.workspaceBranch} · PR details unavailable (gh)`);
    else parts.push("on the PR's branch");
  }
  if (send?.dispatch === "main") parts.push("sent to this agent");
  else if (send?.dispatch === "new" || send?.workspaceCreated) parts.push("new agent");
  const text = parts.join(" · ");
  // Capitalise only our own leading phrase; a workspace name is shown as Paseo shows it.
  const ours = send === null || send.workspaceCreated;
  return { text: ours ? text.charAt(0).toUpperCase() + text.slice(1) : text, attention };
}
