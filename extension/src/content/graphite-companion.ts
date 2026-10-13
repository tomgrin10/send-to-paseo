import { validGraphiteCommand, type GraphiteCommand, type GraphitePrState, type GraphiteResult } from "../shared/follow-through";
declare const __STP_EXTRA_HOSTS__: string[];
const hosts = ["app.graphite.com", "app.graphite.dev", ...(typeof __STP_EXTRA_HOSTS__ === "undefined" ? [] : __STP_EXTRA_HOSTS__)];

export function graphiteRecord(payload: unknown, repo: string, number: number): GraphitePrState {
  const [owner, name] = repo.split("/");
  const queue: unknown[] = [payload]; let visited = 0;
  while (queue.length && visited++ < 20_000) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    const p = value as Record<string, any>;
    if (p.number === number && p.repo?.owner === owner && p.repo?.name === name && p.repo?.forgeSource === "github" && typeof p.headSHA === "string" && typeof p.state === "string" && ["OPEN", "CLOSED", "MERGED"].includes(p.state)) {
      if (p.mergeWhenReady !== undefined && typeof p.mergeWhenReady !== "boolean") throw new Error("Graphite's toggle format changed. Refresh Graphite before continuing.");
      return { repo, number, head: p.headSHA, state: p.state as GraphitePrState["state"], mergeWhenReady: p.mergeWhenReady ?? false, merging: p.stackJobState?.state === "QUEUED" || ["ACTIVE", "PENDING"].includes(p.mergeQueueEntry?.status?.status) || p.hasActiveEntryInGithubMergeQueue === true };
    }
    for (const child of Object.values(p)) if (child && typeof child === "object") queue.push(child);
  }
  throw new Error("Could not read the requested PR from Graphite. Refresh its page and check the connection.");
}

export async function executeGraphiteCommand(command: GraphiteCommand, runFetch: typeof fetch = fetch): Promise<GraphiteResult> {
  if (!validGraphiteCommand(command)) throw new Error("Invalid Graphite command.");
  const result: GraphiteResult = { id: command.id, nonce: command.nonce, outcome: "completed", prs: [], applied: [], error: "" };
  const [owner, name] = command.repo.split("/"); let writing = false;
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await runFetch(`/api/v1/graphite/${path}`, { method: body ? "POST" : "GET", credentials: "include", redirect: "error", headers: body ? { "content-type": "text/plain" } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
      if (!response.ok) {
        if (body && response.status >= 400 && response.status < 500 && response.status !== 408) writing = false;
        throw new Error(response.status === 401 ? "Sign in to Graphite in this Chrome browser." : `Graphite refused the action (HTTP ${response.status}). Refresh its status.`);
      }
      return await response.json();
    } finally { clearTimeout(timer); }
  };
  const read = async (number: number) => graphiteRecord(await request(`github-pr/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/${number}`), command.repo, number);
  try {
    if (Date.now() >= Date.parse(command.expiresAt)) throw new Error("This request expired before execution.");
    for (const target of command.prs) {
      const pr = await read(target.number);
      if (pr.head !== target.head) throw new Error("The PR revision changed. Review a fresh confirmation.");
      if (command.op === "read") { result.prs.push(pr); continue; }
      if (pr.state !== "OPEN") throw new Error("The selected PR is no longer open.");
      const enable = command.op === "enable_mwr";
      if (enable && pr.merging && !pr.mergeWhenReady) throw new Error("The PR is already merging.");
      if (pr.mergeWhenReady !== enable) {
        if (Date.now() >= Date.parse(command.expiresAt)) throw new Error("The request expired; remaining PRs were not changed.");
        writing = true;
        const reply = await request(`mutation/${enable ? "enable-mwr" : "disable-mwr"}`, { forgeSource: "github", owner, name, number: target.number, ...(enable ? { trunkBranchName: target.trunk } : {}) });
        if (!reply || !Array.isArray((reply as { optimisticCreates?: unknown }).optimisticCreates)) throw new Error("Graphite did not return a confirmed mutation receipt.");
        const observed = await read(target.number);
        if (observed.head !== target.head || observed.mergeWhenReady !== enable) throw new Error("Graphite has not confirmed the requested state. Check state before retrying.");
        result.prs.push(observed); writing = false;
      } else result.prs.push(pr);
      result.applied.push(target.number);
    }
  } catch (error) { result.outcome = writing ? "uncertain" : "failed"; result.error = (error instanceof Error ? error.message : "Graphite request failed.").slice(0, 500); }
  return result;
}

export function startGraphiteCompanion() {
  if (!hosts.includes(location.host) || window.top !== window) return;
  let port: chrome.runtime.Port | null = null; let stopped = false;
  const connect = () => {
    if (stopped) return;
    port = chrome.runtime.connect({ name: "follow-through-graphite-v1" });
    let executing = false;
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== "object") return;
      const m = message as { type?: string; command?: unknown };
      if (m.type === "check") {
        void fetch("/api/v1/auth-check", { credentials: "include", redirect: "error" }).then(async r => { const data = r.ok ? await r.json() as { githubHandle?: unknown } : null; port?.postMessage({ type: "session", ready: typeof data?.githubHandle === "string" && !!data.githubHandle }); }).catch(() => port?.postMessage({ type: "session", ready: false }));
      } else if (m.type === "execute" && !executing && validGraphiteCommand(m.command)) {
        executing = true;
        void executeGraphiteCommand(m.command).then(result => port?.postMessage({ type: "result", result })).finally(() => { executing = false; });
      }
    });
    port.onDisconnect.addListener(() => { port = null; if (!stopped) setTimeout(connect, 3_000); });
  };
  connect();
  window.addEventListener("pagehide", () => { stopped = true; port?.disconnect(); }, { once: true });
}
