import { enabledHosts, type HostConfig } from "./settings";
import { validGraphiteCommand, type GraphiteCommand, type GraphiteResult } from "../shared/follow-through";
declare const __STP_EXTRA_HOSTS__: string[];
const hosts = ["app.graphite.com", "app.graphite.dev", ...(typeof __STP_EXTRA_HOSTS__ === "undefined" ? [] : __STP_EXTRA_HOSTS__)];
type Session = { port: chrome.runtime.Port; ready: boolean; busy: boolean; checkedAt: number };
const sessions = new Set<Session>();
const receipts = new Map<string, { hostId: string; routeId: string; result: GraphiteResult; at: number }>();
const issued = new Map<string, { hostId: string; routeId: string; command: GraphiteCommand; session: Session }>();
let timer: ReturnType<typeof setTimeout> | undefined; let polling = false;
const deviceId = crypto.randomUUID();

async function exchange(host: HostConfig, ready: boolean, acceptJobs: boolean) {
  if (!host.token) return;
  const origin = new URL(host.bridgeUrl);
  if (origin.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) return;
  if (!await chrome.permissions.contains({ origins: [`${origin.origin}/*`] })) return;
  const pending = [...receipts.values()].filter(r => r.hostId === host.id).slice(0, 10);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${origin.origin}/follow-through/v1/exchange`, { method: "POST", credentials: "omit", redirect: "error", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify({ clientId: deviceId, ready, acceptJobs, results: pending.map(p => ({ ...p.result, routeId: p.routeId })) }), signal: controller.signal });
    if (!response.ok) return;
    const data = await response.json() as { routes?: { routeId: string; jobs: unknown[]; accepted: string[] }[] };
    if (!Array.isArray(data.routes)) return;
    for (const route of data.routes) {
      if (typeof route.routeId !== "string" || !Array.isArray(route.jobs) || !Array.isArray(route.accepted)) continue;
      for (const id of route.accepted) receipts.delete(`${host.id}:${route.routeId}:${id}`);
      for (const job of route.jobs) {
        if (!validGraphiteCommand(job) || Date.parse(job.expiresAt) <= Date.now()) continue;
        const session = [...sessions].find(s => s.ready && !s.busy);
        if (!session || issued.has(job.id)) continue;
        session.busy = true; issued.set(job.id, { hostId: host.id, routeId: route.routeId, command: job, session });
        session.port.postMessage({ type: "execute", command: job });
      }
    }
  } finally { clearTimeout(timeout); }
}

async function poll() {
  if (polling || !sessions.size) return;
  polling = true;
  try {
    for (const session of sessions) if (Date.now() - session.checkedAt >= 30_000 && !session.busy) { session.checkedAt = Date.now(); session.port.postMessage({ type: "check" }); }
    for (const [id, job] of issued) if (Date.parse(job.command.expiresAt) + 9_000 <= Date.now()) { job.session.busy = false; issued.delete(id); }
    for (const [key, result] of receipts) if (Date.now() - result.at > 60_000) receipts.delete(key);
    const ready = [...sessions].some(s => s.ready);
    if (!ready && !receipts.size) return;
    const enabled = await enabledHosts();
    // Sequential hosts share one browser capacity; a command is leased only once.
    for (const host of enabled) await exchange(host, ready, [...sessions].some(s => s.ready && !s.busy)).catch(() => undefined);
  } finally {
    polling = false;
    if (sessions.size) timer = setTimeout(() => void poll(), 2_000);
  }
}

export function startFollowThroughBridge() {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== "follow-through-graphite-v1" || port.sender?.frameId !== 0) return;
    let url: URL; try { url = new URL(port.sender.url ?? ""); } catch { return; }
    if (!hosts.includes(url.host)) { port.disconnect(); return; }
    const session: Session = { port, ready: false, busy: false, checkedAt: Date.now() };
    sessions.add(session); port.postMessage({ type: "check" });
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== "object") return;
      const m = message as { type?: string; ready?: boolean; result?: GraphiteResult };
      if (m.type === "session" && typeof m.ready === "boolean") session.ready = m.ready;
      if (m.type === "result" && m.result) {
        const job = issued.get(m.result.id);
        if (!job || job.session !== session || job.command.nonce !== m.result.nonce) return;
        issued.delete(m.result.id); session.busy = false;
        receipts.set(`${job.hostId}:${job.routeId}:${m.result.id}`, { hostId: job.hostId, routeId: job.routeId, result: m.result, at: Date.now() });
      }
    });
    port.onDisconnect.addListener(() => { sessions.delete(session); if (!sessions.size && timer) clearTimeout(timer); });
    if (timer) clearTimeout(timer); void poll();
  });
}
