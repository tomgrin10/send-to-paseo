import { z } from "zod";
import { callFollowUp, readDaemonStatus } from "./daemon";
import { exchangeBrowserOnMachine } from "./peers";
import { settings } from "./settings";

const repo = z.string().max(201).regex(/^[\w.-]+\/[\w.-]+$/);
const result = z.object({ routeId: z.string().min(1).max(200), id: z.string().min(1).max(200), nonce: z.string().min(1).max(200), outcome: z.enum(["completed", "failed", "uncertain"]), prs: z.array(z.object({ repo, number: z.number().int().positive(), head: z.string().min(1).max(200), state: z.enum(["OPEN", "CLOSED", "MERGED"]), mergeWhenReady: z.boolean(), merging: z.boolean() })).max(50), applied: z.array(z.number().int().positive()).max(50), error: z.string().max(500) });
export const browserExchange = z.object({
  clientId: z.string().min(1).max(100),
  routes: z.array(z.object({ routeId: z.string().min(1).max(200), serverId: z.string().min(1).max(200), repositories: z.array(repo).max(100) })).max(32),
  ready: z.boolean(), acceptJobs: z.boolean(), results: z.array(result).max(10),
});
type Exchange = z.infer<typeof browserExchange>;
const turns = new Map<string, number>();
type Route = { routeId: string; serverId: string | null; label: string; available: boolean; repositories?: string[]; jobs: unknown[]; accepted: string[] };

/** Each route gets its own consent scopes. A proxy can never widen them. */
export async function exchangeBrowser(input: Exchange, localOnly: boolean) {
  const configured = await settings.read();
  const machines = localOnly ? [] : configured.additionalMachines.filter(m => m.enabled);
  const eligible = ["local", ...machines.map(m => m.id)].filter(id => input.routes.some(r => r.routeId === id && r.repositories.length));
  const turn = turns.get(input.clientId) ?? 0;
  const selected = eligible[turn % eligible.length];
  if (turns.size >= 100) turns.delete(turns.keys().next().value!);
  turns.set(input.clientId, turn + 1);
  const daemon = await readDaemonStatus();
  const localScope = input.routes.find(r => r.routeId === "local" && r.serverId === daemon.serverId);
  const local: Route = { routeId: "local", serverId: daemon.serverId, label: "This Paseo machine", available: false, jobs: [], accepted: [] };
  try {
    const answer = await callFollowUp("follow.browser-exchange", {
      clientId: `send:${input.clientId}`, ready: input.ready && !!localScope?.repositories.length,
      acceptJobs: input.acceptJobs && selected === "local", repositories: localScope?.repositories ?? [],
      results: input.results.filter(r => r.routeId === "local").map(({ routeId: _, ...r }) => r),
    }) as { jobs?: unknown[]; accepted?: string[]; repositories?: unknown };
    local.available = true;
    if (Array.isArray(answer.repositories)) local.repositories = [...new Set(answer.repositories.filter((r): r is string => repo.safeParse(r).success).map(r => r.toLowerCase()))].slice(0, 100);
    local.jobs = Array.isArray(answer.jobs) ? answer.jobs : [];
    local.accepted = Array.isArray(answer.accepted) ? answer.accepted : [];
  } catch { /* Follow Up is optional, including older versions. */ }
  // One fair lease slot across all routes; sleeping peers run within independent total budgets.
  const remoteRoutes = await Promise.all(machines.map(async machine => {
    const route: Route = { routeId: machine.id, serverId: null, label: machine.label, available: false, jobs: [], accepted: [] };
    try {
      const scope = input.routes.find(r => r.routeId === machine.id);
      const response = await exchangeBrowserOnMachine(machine, { ...input, acceptJobs: input.acceptJobs && selected === machine.id, routes: scope ? [{ ...scope, routeId: "local" }] : [], results: input.results.filter(r => r.routeId === machine.id).map(r => ({ ...r, routeId: "local" })) }) as { routes?: Route[] };
      const remote = response.routes?.find(r => r.routeId === "local");
      if (remote) { route.serverId = remote.serverId; route.available = remote.available; route.repositories = remote.repositories; route.jobs = remote.jobs; route.accepted = remote.accepted; }
    } catch { /* A sleeping peer cannot disable local sends. */ }
    return route;
  }));
  return { routes: [local, ...remoteRoutes] };
}
