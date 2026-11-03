import { enabledHosts, hostById, hostDisplayName, type HostConfig } from "./settings";
import { allowsToggleChanges, followUpEnabled, setFollowUpEnabled, bridgeBinding, permits, readGrants, updateGrants, validRepo, type BrowserRoute } from "./browser-access";
import { validGraphiteCommand, type GraphiteCommand, type GraphiteResult } from "../shared/follow-through";
declare const __STP_EXTRA_HOSTS__: string[];
const hosts = ["app.graphite.com", "app.graphite.dev", ...(typeof __STP_EXTRA_HOSTS__ === "undefined" ? [] : __STP_EXTRA_HOSTS__)];
type Session = { port: chrome.runtime.Port; ready: boolean; busy: boolean; checkedAt: number };
type Job = { key: string; route: BrowserRoute; command: GraphiteCommand; session: Session; phase: "approval" | "executing"; browserApproved: boolean };
const sessions = new Set<Session>();
const issued = new Map<string, Job>();
const receipts = new Map<string, { route: BrowserRoute; result: GraphiteResult; at: number }>();
const inventory = new Map<string, BrowserRoute>();
const connectionErrors = new Map<string, string>();
let refreshedAt = 0; let refreshing: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined; let polling = false; let nextHost = 0;
const deviceId = crypto.randomUUID();
const routeKey = (r: Pick<BrowserRoute, "hostId" | "routeId">) => JSON.stringify([r.hostId, r.routeId]);
const jobKey = (r: BrowserRoute, id: string) => JSON.stringify([r.hostId, r.routeId, r.serverId, id]);
const failure = (c: GraphiteCommand, error: string): GraphiteResult => ({ id: c.id, nonce: c.nonce, outcome: "failed", prs: [], applied: [], error });
function finish(job: Job, result: GraphiteResult) {
  issued.delete(job.key); job.session.busy = false;
  receipts.set(job.key, { route: job.route, result, at: Date.now() });
}
async function stillPermitted(job: Job) {
  const host = await hostById(job.route.hostId);
  return await followUpEnabled() && !!host && host.enabled && (await enabledHosts()).some(h => h.id === host.id) && await bridgeBinding(host) === job.route.binding && permits(await readGrants(), job.route, job.command) && Date.parse(job.command.expiresAt) > Date.now();
}
async function execute(job: Job) {
  if (!await stillPermitted(job) || !sessions.has(job.session) || !job.session.ready) {
    finish(job, failure(job.command, "Browser access was revoked, the browser disconnected, or this request expired.")); return;
  }
  if (job.command.op !== "read" && !job.browserApproved && !allowsToggleChanges(await readGrants(), job.route, job.command)) {
    finish(job, failure(job.command, "Direct toggle permission was revoked. No change was sent.")); return;
  }
  job.phase = "executing";
  job.session.port.postMessage({ type: "execute", command: job.command });
}
async function exchange(host: HostConfig, ready: boolean, acceptJobs: boolean) {
  if (!host.token) throw new Error("Pair Send to Paseo using the connection above.");
  const origin = new URL(host.bridgeUrl);
  if (origin.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw new Error("Use HTTPS or a loopback bridge for this connection.");
  if (!await chrome.permissions.contains({ origins: [`${origin.origin}/*`] })) throw new Error("Allow Chrome access to the existing Send to Paseo connection above.");
  const binding = await bridgeBinding(host); const grants = await readGrants();
  const pending = [...receipts.values()].filter(r => r.route.hostId === host.id && r.route.binding === binding).slice(0, 10);
  const scopes = new Map<string, { routeId: string; serverId: string; repositories: string[] }>();
  for (const grant of grants.filter(g => g.hostId === host.id && g.binding === binding)) {
    const key = JSON.stringify([grant.routeId, grant.serverId]);
    const scope = scopes.get(key) ?? { routeId: grant.routeId, serverId: grant.serverId, repositories: [] };
    scope.repositories.push(grant.repo); scopes.set(key, scope);
  }
  // First exchange discovers the authenticated daemon identity and tracked repositories.
  // Later exchanges echo those exact scopes; no wildcard or new pairing is introduced.
  for (const route of inventory.values()) {
    if (route.hostId !== host.id || route.binding !== binding || !route.available) continue;
    const key = JSON.stringify([route.routeId, route.serverId]);
    const scope = scopes.get(key) ?? { routeId: route.routeId, serverId: route.serverId, repositories: [] };
    scope.repositories = [...new Set([...scope.repositories, ...(route.repositories ?? [])])].slice(0, 100);
    scopes.set(key, scope);
  }
  const enabled = await followUpEnabled();
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${origin.origin}/follow-up/v1/exchange`, { method: "POST", credentials: "omit", redirect: "error", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify({ clientId: deviceId, ready: enabled && ready, acceptJobs: enabled && acceptJobs, routes: enabled ? [...scopes.values()] : [], results: pending.map(p => ({ ...p.result, routeId: p.route.routeId })) }), signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 404
      ? "Update Send to Paseo on this connection’s Primary machine to enable Follow Up."
      : response.status === 401 ? "The Send to Paseo pairing was refused. Check the existing connection above."
      : `The existing Send to Paseo connection returned HTTP ${response.status}. Try again.`);
    const data = await response.json() as { routes?: { routeId: string; serverId: string; label: string; available: boolean; repositories?: unknown; jobs: unknown[]; accepted: string[] }[] };
    if (!Array.isArray(data.routes) || data.routes.length > 32) throw new Error("Update Send to Paseo on the Primary machine; its Follow Up response is unsupported.");
    for (const [key, route] of inventory) if (route.hostId === host.id) inventory.delete(key);
    connectionErrors.delete(host.id);
    for (const r of data.routes) {
      if (typeof r.routeId !== "string" || !r.routeId || typeof r.serverId !== "string" || !r.serverId || !Array.isArray(r.jobs) || !Array.isArray(r.accepted)) continue;
      const route: BrowserRoute = { hostId: host.id, routeId: r.routeId, serverId: r.serverId, binding, label: r.routeId === "local" ? hostDisplayName(host) : `${hostDisplayName(host)} / ${String(r.label).slice(0, 120)}`, available: r.available === true, repositories: Array.isArray(r.repositories) ? [...new Set(r.repositories.filter(validRepo).map(repo => repo.toLowerCase()))].slice(0, 100) : [] };
      inventory.set(routeKey(route), route);
      for (const id of r.accepted) receipts.delete(jobKey(route, id));
      for (const command of r.jobs.slice(0, 1)) {
        if (!validGraphiteCommand(command) || Date.parse(command.expiresAt) <= Date.now()) continue;
        const key = jobKey(route, command.id);
        if (issued.has(key) || receipts.has(key)) continue;
        const session = [...sessions].find(s => s.ready && !s.busy);
        if (!enabled || !session || !permits(await readGrants(), route, command)) {
          receipts.set(key, { route, result: failure(command, "This machine has no browser permission for the repository, or the browser is busy."), at: Date.now() }); continue;
        }
        const job: Job = { key, route, command, session, phase: "approval", browserApproved: false };
        session.busy = true; issued.set(key, job);
        if (command.op === "read" || allowsToggleChanges(await readGrants(), route, command)) await execute(job);
        else { await chrome.action.setBadgeText({ text: "1" }); await chrome.runtime.openOptionsPage(); }
      }
    }
  } finally { clearTimeout(timeout); }
}
async function poll() {
  if (polling || !sessions.size) return;
  polling = true;
  const startedAt = Date.now();
  try {
    for (const session of sessions) if (Date.now() - session.checkedAt >= 30_000 && !session.busy) { session.checkedAt = Date.now(); session.port.postMessage({ type: "check" }); }
    for (const job of issued.values()) {
      if (Date.parse(job.command.expiresAt) <= Date.now()) {
        if (job.phase === "approval") finish(job, failure(job.command, "Browser confirmation expired. No toggle was sent."));
        else { issued.delete(job.key); job.session.busy = false; }
      } else if (job.phase === "approval" && !await stillPermitted(job)) finish(job, failure(job.command, "Browser access was revoked."));
    }
    for (const [key, receipt] of receipts) if (Date.now() - receipt.at > 60_000) receipts.delete(key);
    const ready = [...sessions].some(s => s.ready);
    const enabled = await enabledHosts();
    const start = nextHost++ % Math.max(1, enabled.length);
    const ordered = [...enabled.slice(start), ...enabled.slice(0, start)];
    // Poll connections together so an offline machine cannot starve a healthy heartbeat.
    // Only one host may lease work; each bridge already rotates fairly among its routes.
    await Promise.all(ordered.map((host, index) => exchangeSafely(host, ready, index === 0 && [...sessions].some(s => s.ready && !s.busy))));
    await chrome.action.setBadgeText({ text: [...issued.values()].some(j => j.phase === "approval") ? "1" : "" });
  } finally {
    polling = false;
    if (sessions.size) timer = setTimeout(() => void poll(), Math.max(100, 3_000 - (Date.now() - startedAt)));
  }
}
async function exchangeSafely(host: HostConfig, ready: boolean, acceptJobs: boolean) {
  try { await exchange(host, ready, acceptJobs); }
  catch (error) {
    connectionErrors.set(host.id, error instanceof Error && error.name !== "TypeError" && error.name !== "AbortError" ? error.message : "The existing Send to Paseo connection is unreachable. Check it above and retry.");
    for (const [key, route] of inventory) if (route.hostId === host.id) inventory.delete(key);
  }
}
async function refreshConnections(force = false) {
  if (refreshing) return refreshing;
  if (!force && Date.now() - refreshedAt < 5_000) return;
  refreshing = (async () => {
    const enabled = await enabledHosts();
    const ids = new Set(enabled.map(h => h.id));
    for (const [key, route] of inventory) if (!ids.has(route.hostId)) inventory.delete(key);
    for (const id of connectionErrors.keys()) if (!ids.has(id)) connectionErrors.delete(id);
    await Promise.all(enabled.map(host => exchangeSafely(host, [...sessions].some(s => s.ready), false)));
    refreshedAt = Date.now();
  })();
  try { await refreshing; } finally { refreshing = null; }
}
/** Called only for the extension's own options page, never a content script. */
export async function browserAccessIntent(message: { type: string; route?: BrowserRoute; repo?: string; key?: string; approve?: boolean; enable_toggle_changes?: boolean; enabled?: boolean; remember?: boolean }) {
  if (message.type === "browserAccessRefresh") {
    await refreshConnections(true);
  } else if (message.type === "browserAccessEnable") {
    await setFollowUpEnabled(message.enabled === true);
    await refreshConnections(true);
  } else if (message.type === "browserAccessStatus") {
    await refreshConnections();
  } else if (message.type === "browserAccessGrant") {
    const route = message.route && inventory.get(routeKey(message.route));
    const host = route && await hostById(route.hostId);
    if (!route?.available || route.serverId !== message.route?.serverId || route.binding !== message.route?.binding || !host || await bridgeBinding(host) !== route.binding || !validRepo(message.repo)) throw new Error("Refresh machines and enter an exact owner/repository.");
    const repo = message.repo.toLowerCase();
    await updateGrants(grants => {
      const retained = grants.filter(g => !(g.hostId === route.hostId && g.routeId === route.routeId && g.serverId === route.serverId && g.binding === route.binding && g.repo === repo));
      if (retained.length >= 100) throw new Error("Revoke an existing repository before allowing another.");
      return [...retained, { hostId: route.hostId, routeId: route.routeId, serverId: route.serverId, binding: route.binding, repo, enable_toggle_changes: message.enable_toggle_changes === true }];
    });
  } else if (message.type === "browserAccessRevoke") {
    const route = message.route;
    await updateGrants(grants => grants.filter(g => !(route && g.hostId === route.hostId && g.routeId === route.routeId && g.serverId === route.serverId && g.repo === message.repo)));
    const host = route && await hostById(route.hostId);
    if (host) await exchangeSafely(host, [...sessions].some(s => s.ready), false);
  } else if (message.type === "browserAccessConfirm") {
    const job = message.key && issued.get(message.key);
    if (!job || job.phase !== "approval") throw new Error("This request expired or was already handled.");
    // Consume approval before the asynchronous recheck so two clicks cannot write twice.
    job.phase = "executing";
    if (message.approve === true) {
      job.browserApproved = true;
      if (message.remember === true && await stillPermitted(job)) {
        try {
          await updateGrants(saved => {
            const grants = saved.filter(g => !(g.hostId === job.route.hostId && g.routeId === job.route.routeId && g.serverId === job.route.serverId && g.binding === job.route.binding && g.repo === job.command.repo.toLowerCase()));
            if (grants.length >= 100) throw new Error("Remove an existing remembered permission first.");
            return [...grants, { hostId: job.route.hostId, routeId: job.route.routeId, serverId: job.route.serverId, binding: job.route.binding, repo: job.command.repo.toLowerCase(), enable_toggle_changes: true }];
          });
        } catch {
          finish(job, failure(job.command, "Could not remember permission. No toggle was sent. Remove an existing permission and retry."));
          return browserAccessIntent({ type: "browserAccessStatus" });
        }
      }
      await execute(job);
    } else finish(job, failure(job.command, "Cancelled in Chrome. No toggle was sent."));
  }
  return { enabled: await followUpEnabled(), browserReady: [...sessions].some(s => s.ready), errors: [...connectionErrors].map(([hostId, message]) => ({ hostId, message })), routes: [...inventory.values()], grants: await readGrants(), pending: [...issued.values()].filter(j => j.phase === "approval").map(j => ({ key: j.key, label: j.route.label, command: j.command })) };
}
export function startFollowUpBridge() {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== "follow-through-graphite-v1") return;
    let url: URL; try { url = new URL(port.sender?.url ?? ""); } catch { port.disconnect(); return; }
    const testHost = typeof __STP_EXTRA_HOSTS__ !== "undefined" && __STP_EXTRA_HOSTS__.includes(url.host);
    if (port.sender?.id !== chrome.runtime.id || port.sender.frameId !== 0 || !hosts.includes(url.host) || !testHost && url.protocol !== "https:") { port.disconnect(); return; }
    const session: Session = { port, ready: false, busy: false, checkedAt: Date.now() };
    sessions.add(session); port.postMessage({ type: "check" });
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== "object") return;
      const m = message as { type?: string; ready?: boolean; result?: GraphiteResult };
      if (m.type === "session" && typeof m.ready === "boolean") session.ready = m.ready;
      if (m.type === "result" && m.result) {
        const job = [...issued.values()].find(j => j.session === session && j.phase === "executing" && j.command.id === m.result!.id && j.command.nonce === m.result!.nonce);
        if (job) finish(job, m.result);
      }
    });
    port.onDisconnect.addListener(() => { sessions.delete(session); if (!sessions.size && timer) clearTimeout(timer); });
    if (timer) clearTimeout(timer); void poll();
  });
}
