import type { BrowserGrant, BrowserRoute } from "../background/browser-access";
import type { GraphiteCommand } from "../shared/follow-through";

type Access = { enabled: boolean; browserReady: boolean; errors: { hostId: string; message: string }[]; routes: BrowserRoute[]; grants: BrowserGrant[]; pending: { key: string; label: string; command: GraphiteCommand }[] };
export function startBrowserAccessSettings() {
  const enabled = document.getElementById("graphiteEnabled") as HTMLInputElement;
  const status = document.getElementById("graphiteStatus")!;
  const connections = document.getElementById("graphiteConnections")!;
  const grants = document.getElementById("graphiteGrants")!;
  const pending = document.getElementById("graphitePending")!;
  let current: Access = { enabled: true, browserReady: false, errors: [], routes: [], grants: [], pending: [] };
  const retry = document.getElementById("graphiteRefresh") as HTMLButtonElement;
  let pendingKey = "", connectionsKey = "", grantsKey = "", busy = false;
  const button = (label: string, action: () => Promise<void>) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label;
    b.addEventListener("click", () => { b.disabled = true; void action().finally(() => { b.disabled = false; }); }); return b;
  };
  const call = async (type: string, fields: Record<string, unknown> = {}) => {
    try {
      const reply = await chrome.runtime.sendMessage({ type, ...fields }) as { ok: boolean; data: Access; error?: { message: string } };
      if (!reply?.ok) throw new Error(reply?.error?.message || "The extension disconnected. Reload this page.");
      current = reply.data; render();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Couldn’t check Follow Up. Retry below.";
      retry.hidden = false;
    }
  };
  function render() {
    enabled.checked = current.enabled;
    // Exactly one status line per state. Per-machine rows appear only when
    // there is more than one machine to tell apart; errors are folded into the
    // status line (deduplicated: every host can fail with the same sentence).
    const available = current.routes.filter(r => r.available);
    const errors = [...new Set(current.errors.map(e => e.message))];
    const multi = current.routes.length + current.errors.length > 1;
    const repoCount = (n: number) => `${n} tracked ${n === 1 ? "repository" : "repositories"}`;
    let line: string;
    if (!current.enabled) line = "Follow Up browser access is off. Send to Paseo still works.";
    else if (errors.length && !available.length) line = errors.join(" ");
    else if (available.length) {
      const repos = available.reduce((n, r) => n + (r.repositories?.length ?? 0), 0);
      line = current.browserReady
        ? `Connected through Send to Paseo${!multi && repos ? ` · ${repoCount(repos)}` : ""}.`
        : "Connected. Open Graphite in this browser and sign in to use Merge when ready.";
    } else if (current.routes.length) line = "Follow Up isn’t installed or enabled in Paseo on this machine.";
    // Follow Up only talks to Paseo while a Graphite tab is open, so "no
    // routes, no errors" is normal idle, not a broken connection.
    else line = "Ready. Follow Up connects when Graphite is open in this browser.";
    status.textContent = line;
    // Retry only when something is wrong; a healthy connection polls itself.
    retry.hidden = !current.enabled || (errors.length === 0 && (available.length > 0 || current.routes.length === 0));
    const nextConnections = JSON.stringify([current.routes, current.errors, multi]);
    if (nextConnections !== connectionsKey) {
      connectionsKey = nextConnections; connections.replaceChildren();
      if (multi) {
        for (const route of current.routes) {
          const row = document.createElement("p"); row.className = "help";
          row.textContent = `${route.label} — ${route.available
            ? route.repositories?.length ? `connected · ${repoCount(route.repositories.length)}` : "connected"
            : "Follow Up isn’t installed or enabled on this machine"}`;
          connections.append(row);
        }
        if (available.length) for (const error of current.errors) {
          const row = document.createElement("p"); row.className = "help"; row.textContent = error.message; connections.append(row);
        }
      }
    }
    const nextGrants = JSON.stringify([current.grants, current.routes]);
    if (nextGrants !== grantsKey) {
      grantsKey = nextGrants; grants.replaceChildren();
      for (const g of current.grants.filter(g => g.enable_toggle_changes)) {
        const row = document.createElement("div"); row.className = "row";
        const text = document.createElement("span");
        const route = current.routes.find(r => r.hostId === g.hostId && r.routeId === g.routeId && r.serverId === g.serverId && r.binding === g.binding);
        text.textContent = `${g.repo} · ${route?.label ?? "Disconnected machine"} · Changes allowed without confirmation`;
        row.append(text, button("Require confirmation", () => call("browserAccessRevoke", { route: g, repo: g.repo }))); grants.append(row);
      }
    }
    const key = JSON.stringify(current.pending.map(p => p.key));
    if (key === pendingKey) return; pendingKey = key; pending.replaceChildren();
    for (const request of current.pending) {
      const box = document.createElement("div");
      const title = document.createElement("strong");
      const enable = request.command.op === "enable_mwr";
      title.textContent = `${enable ? "Enable" : "Disable"} Merge when ready?`;
      const detail = document.createElement("p");
      detail.textContent = `${request.label} requests ${request.command.repo} ${request.command.prs.map(p => `#${p.number}`).join(", ")}.`;
      const scope = document.createElement("p");
      scope.textContent = "This changes the PR setting, including later pushes. Enabling it lets Graphite merge when its rules pass.";
      const remember = document.createElement("input"); remember.type = "checkbox";
      const permission = document.createElement("label"); permission.className = "toggle";
      permission.append(remember, document.createTextNode(` Allow future toggle changes for ${request.command.repo} from ${request.label} without confirmation`));
      const actions = document.createElement("div"); actions.className = "row";
      actions.append(button("Cancel", () => call("browserAccessConfirm", { key: request.key, approve: false })), button(enable ? "Enable for these PRs" : "Disable for these PRs", () => call("browserAccessConfirm", { key: request.key, approve: true, remember: remember.checked })));
      box.append(title, detail, scope, permission, actions); pending.append(box);
    }
  }
  enabled.addEventListener("change", () => { enabled.disabled = true; void call("browserAccessEnable", { enabled: enabled.checked }).finally(() => { enabled.disabled = false; }); });
  retry.addEventListener("click", () => {
    retry.disabled = true;
    status.textContent = "Checking Follow Up…";
    void call("browserAccessRefresh").finally(() => { retry.disabled = false; });
  });
  const refresh = async () => { if (busy) return; busy = true; try { await call("browserAccessStatus"); } finally { busy = false; } };
  void refresh();
  const timer = setInterval(() => void refresh(), 2_000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
