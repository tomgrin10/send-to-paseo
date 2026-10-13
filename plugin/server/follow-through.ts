import { z } from "zod";
import { exchangeFollowThrough } from "./daemon";
import { fetchJson } from "./peers";
import { settings } from "./settings";

const result = z.object({ routeId: z.string().max(200), id: z.string().max(200), nonce: z.string().max(200), outcome: z.enum(["completed", "failed", "uncertain"]), prs: z.array(z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), head: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), mergeWhenReady: z.boolean(), merging: z.boolean() })).max(50), applied: z.array(z.number().int().positive()).max(50), error: z.string().max(500) });
export const followThroughExchange = z.object({ clientId: z.string().min(1).max(100), ready: z.boolean(), acceptJobs: z.boolean(), results: z.array(result).max(10) });
type Exchange = z.infer<typeof followThroughExchange>;
type Answer = { jobs: unknown[]; accepted: string[] };
const turns = new Map<string, number>();

export async function followThrough(input: Exchange, localOnly: boolean) {
  const machines = localOnly ? [] : (await settings.read()).additionalMachines.filter(m => m.enabled);
  const slot = localOnly ? 0 : (turns.get(input.clientId) ?? 0) % (machines.length + 1);
  turns.set(input.clientId, slot + 1);
  const forRoute = (routeId: string) => ({ clientId: `send-to-paseo:${input.clientId}`, ready: input.ready, acceptJobs: input.acceptJobs && slot === 0, results: input.results.filter(r => r.routeId === routeId).map(({ routeId: _, ...result }) => result) });
  const local = await exchangeFollowThrough(forRoute("local")).catch(() => ({ jobs: [], accepted: [] })) as Answer;
  const routes = [{ routeId: "local", jobs: Array.isArray(local.jobs) ? local.jobs : [], accepted: Array.isArray(local.accepted) ? local.accepted : [] }];
  if (!localOnly) {
    const remote = await Promise.all(machines.map(async (machine, index) => {
      try {
        const payload = { ...input, acceptJobs: input.acceptJobs && slot === index + 1, results: input.results.filter(r => r.routeId === machine.id).map(r => ({ ...r, routeId: "local" })) };
        const response = await fetchJson(machine, "/follow-through/v1/exchange?local=1", { method: "POST", body: JSON.stringify(payload) }, 8_000) as { routes?: { jobs: unknown[]; accepted: string[] }[] };
        return { routeId: machine.id, jobs: response.routes?.[0]?.jobs ?? [], accepted: response.routes?.[0]?.accepted ?? [] };
      } catch { return { routeId: machine.id, jobs: [], accepted: [] }; }
    }));
    routes.push(...remote);
  }
  return { routes };
}
