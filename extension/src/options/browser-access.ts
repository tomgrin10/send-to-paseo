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
    } catch (e) { status.textContent = e instanceof Error ? e.message : "Could not check the existing Send to Paseo connection. Retry below."; }
  };
  function render() {
    enabled.checked = current.enabled;
    const available = current.routes.filter(r => r.available);
    status.textContent = !current.enabled ? "Follow Up browser access is off. Send to Paseo still works."
      : available.length ? current.browserReady ? "Connected through Send to Paseo."
        : "Connection ready. Open Graphite in this browser and sign in to use Merge when ready."
      : "Checking your existing Send to Paseo connections. No separate pairing is needed.";
    const nextConnections = JSON.stringify([current.routes, current.errors]);
    if (nextConnections !== connectionsKey) {
      connectionsKey = nextConnections; connections.replaceChildren();
      for (const route of current.routes) {
        const row = document.createElement("p"); row.className = "help";
        row.textContent = `${route.label} — ${route.available
          ? route.repositories?.length ? `Follow Up connected · ${route.repositories.length} tracked ${route.repositories.length === 1 ? "repository" : "repositories"}`
            : "Follow Up connected. Update Follow Up to use tracked repositories automatically."
          : "Follow Up is unavailable. Install or enable it on this machine."}`;
        connections.append(row);
      }
      for (const error of current.errors) {
        const row = document.createElement("p"); row.className = "help"; row.textContent = error.message; connections.append(row);
      }
      if (!current.routes.length && !current.errors.length) connections.textContent = "Pair Send to Paseo above. Follow Up will use that connection automatically.";
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
  document.getElementById("graphiteRefresh")!.addEventListener("click", event => {
    const retry = event.currentTarget as HTMLButtonElement; retry.disabled = true;
    status.textContent = "Checking your Send to Paseo connection…";
    void call("browserAccessRefresh").finally(() => { retry.disabled = false; });
  });
  const refresh = async () => { if (busy) return; busy = true; try { await call("browserAccessStatus"); } finally { busy = false; } };
  void refresh();
  const timer = setInterval(() => void refresh(), 2_000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
