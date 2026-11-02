import type { BrowserGrant, BrowserRoute } from "../background/browser-access";
import type { GraphiteCommand } from "../shared/follow-through";

type Access = { routes: BrowserRoute[]; grants: BrowserGrant[]; pending: { key: string; label: string; command: GraphiteCommand }[] };
export function startBrowserAccessSettings() {
  const machine = document.getElementById("graphiteMachine") as HTMLSelectElement;
  const repo = document.getElementById("graphiteRepo") as HTMLInputElement;
  const toggleChanges = document.getElementById("graphiteToggleChanges") as HTMLInputElement;
  const status = document.getElementById("graphiteStatus")!;
  const grants = document.getElementById("graphiteGrants")!;
  const pending = document.getElementById("graphitePending")!;
  const grant = document.getElementById("graphiteGrant") as HTMLButtonElement;
  let current: Access = { routes: [], grants: [], pending: [] }; let pendingKey = "";
  const button = (label: string, action: () => Promise<void>) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label;
    b.addEventListener("click", () => { b.disabled = true; void action().finally(() => { b.disabled = false; }); }); return b;
  };
  const call = async (type: string, fields: Record<string, unknown> = {}) => {
    try {
      const reply = await chrome.runtime.sendMessage({ type, ...fields }) as { ok: boolean; data: Access; error?: { message: string } };
      if (!reply?.ok) throw new Error(reply?.error?.message || "The extension disconnected. Reload this page.");
      current = reply.data; render();
    } catch (e) { status.textContent = e instanceof Error ? e.message : "Could not update browser access."; }
  };
  function render() {
    const selected = machine.value; machine.replaceChildren();
    for (const [i, route] of current.routes.entries()) if (route.available) machine.add(new Option(`${route.label} (${route.serverId.slice(0, 8)})`, String(i)));
    if (!machine.options.length) machine.add(new Option("Find a machine with Follow Up installed", ""));
    if ([...machine.options].some(o => o.value === selected)) machine.value = selected;
    grant.disabled = !machine.value;
    grants.replaceChildren();
    if (!current.grants.length) grants.textContent = "No repositories allowed.";
    for (const g of current.grants) {
      const row = document.createElement("div"); row.className = "row";
      const text = document.createElement("span");
      const route = current.routes.find(r => r.hostId === g.hostId && r.routeId === g.routeId && r.serverId === g.serverId && r.binding === g.binding);
      text.textContent = `${g.repo} — ${route?.label ?? `Machine ${g.serverId.slice(0, 8)} (refresh to check)`} — ${g.enable_toggle_changes ? "Read and change toggles" : "Read; confirm changes in Chrome"}`;
      row.append(text, button("Revoke", () => call("browserAccessRevoke", { route: g, repo: g.repo }))); grants.append(row);
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
      scope.textContent = "This changes the PR setting, including later pushes. Graphite does not lock this toggle to a commit. Enabling it lets Graphite merge when its rules pass.";
      const actions = document.createElement("div"); actions.className = "row";
      actions.append(button("Cancel", () => call("browserAccessConfirm", { key: request.key, approve: false })), button(enable ? "Enable for these PRs" : "Disable for these PRs", () => call("browserAccessConfirm", { key: request.key, approve: true })));
      box.append(title, detail, scope, actions); pending.append(box);
    }
  }
  document.getElementById("graphiteRefresh")!.addEventListener("click", () => {
    status.textContent = "Looking for Follow Up on your paired machines…";
    void call("browserAccessRefresh").then(() => { status.textContent = current.routes.some(r => r.available) ? "Choose a machine and allow an exact repository." : "No Follow Up machine found. Check that both plugins are installed and the bridge is paired."; });
  });
  grant.addEventListener("click", () => {
    const route = current.routes[Number(machine.value)]; if (!route || !machine.value) return;
    grant.disabled = true;
    void call("browserAccessGrant", { route, repo: repo.value.trim(), enable_toggle_changes: toggleChanges.checked }).finally(() => { grant.disabled = false; });
  });
  void call("browserAccessStatus");
  const timer = setInterval(() => void call("browserAccessStatus"), 1_000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
