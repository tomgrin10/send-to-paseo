export interface GraphiteCommand {
  id: string; nonce: string; expiresAt: string; op: "read" | "enable_mwr" | "disable_mwr"; repo: string;
  prs: { number: number; head: string; trunk: string }[];
}
export interface GraphitePrState { repo: string; number: number; head: string; state: "OPEN" | "MERGED" | "CLOSED"; mergeWhenReady: boolean; merging: boolean }
export interface GraphiteResult { id: string; nonce: string; outcome: "completed" | "failed" | "uncertain"; prs: GraphitePrState[]; applied: number[]; error: string }

export function validGraphiteCommand(value: unknown): value is GraphiteCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as GraphiteCommand;
  return typeof c.id === "string" && c.id.length > 0 && c.id.length <= 200 && typeof c.nonce === "string" && c.nonce.length > 0 && c.nonce.length <= 200 && typeof c.expiresAt === "string" && Number.isFinite(Date.parse(c.expiresAt)) && ["read", "enable_mwr", "disable_mwr"].includes(c.op) && typeof c.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(c.repo) && Array.isArray(c.prs) && c.prs.length > 0 && c.prs.length <= 50 && c.prs.every(p => p && Number.isSafeInteger(p.number) && p.number > 0 && typeof p.head === "string" && p.head.length > 0 && typeof p.trunk === "string" && p.trunk.length > 0) && new Set(c.prs.map(p => p.number)).size === c.prs.length;
}
