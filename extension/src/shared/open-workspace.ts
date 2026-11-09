/**
 * "Open workspace": the Follow-up owners of a PR, flattened across every host
 * that answered, ready for the popover. Pure and `chrome`-free so the rules are
 * readable (and tested) without a browser.
 *
 * Every field arrives from a bridge, possibly an Additional machine proxied
 * through the Primary, so links are re-checked here: a desktop link must be a
 * `paseo://h/...` agent link and a web link must be on the Paseo web app. A row
 * with any other link is dropped rather than rendered as a clickable anchor.
 */
import type { FollowUpWorkspace } from "./contract";
import type { HostSlice } from "./messages";

export type OpenTarget = "app" | "web";
export const PASEO_WEB_ORIGIN = "https://app.paseo.sh";
export const OWNER_LIMIT = 3;

export interface OwnerRow extends FollowUpWorkspace {
  hostIndex: number;
}

export interface OwnerSection {
  rows: OwnerRow[];
  /** Owners not shown: the bridges' own `more` plus anything past the limit here. */
  more: number;
}

const GROUP_ORDER = ["needs", "fixing", "running", "waiting", "later", "quiet"];

export function isDesktopLink(href: string): boolean {
  try { const u = new URL(href); return u.protocol === "paseo:" && u.hostname === "h" && /^\/[^/]+\/agent\/[^/]+$/.test(u.pathname) && !u.search && !u.hash; }
  catch { return false; }
}
export function isWebLink(href: string): boolean {
  try { const u = new URL(href); return u.origin === PASEO_WEB_ORIGIN && /^\/h\/[^/]+\/agent\/[^/]+$/.test(u.pathname) && !u.search && !u.hash; }
  catch { return false; }
}

/**
 * Null when no host sent a Follow-up view at all: Follow-up is absent, older,
 * browser access is off, or the repository is outside its scope. The popover
 * then shows no section. An empty `rows` is different: Follow-up tracks the
 * repository and no workspace owns this PR, which is worth saying.
 */
export function ownerSection(hosts: readonly HostSlice[]): OwnerSection | null {
  let seen = false;
  let more = 0;
  const rows: OwnerRow[] = [];
  hosts.forEach((slice, hostIndex) => {
    const view = slice.resolved?.followUp;
    if (!view || !Array.isArray(view.workspaces)) return;
    seen = true;
    more += Number.isInteger(view.more) && view.more > 0 ? view.more : 0;
    for (const w of view.workspaces) {
      if (typeof w?.title !== "string" || typeof w.state !== "string" || !isDesktopLink(w.deepLink) || !isWebLink(w.webUrl)) continue;
      rows.push({ ...w, hostIndex });
    }
  });
  if (!seen) return null;
  const rank = (g: string) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
  rows.sort((a, b) => rank(a.group) - rank(b.group) || a.hostIndex - b.hostIndex);
  return { rows: rows.slice(0, OWNER_LIMIT), more: more + Math.max(0, rows.length - OWNER_LIMIT) };
}

export function openHref(row: Pick<FollowUpWorkspace, "deepLink" | "webUrl">, target: OpenTarget): string {
  return target === "web" ? row.webUrl : row.deepLink;
}

/**
 * The main agent's status as a short phrase for the end of the state line, or
 * "" when the state line already says it ("Running" over "agent running").
 */
export function agentStatusText(status: string, state = ""): string {
  const text = (() => {
    switch (status) {
      case "permission": return "agent waiting for permission";
      case "running": case "initializing": return "agent running";
      case "error": return "agent errored";
      case "idle": return "agent idle";
      case "closed": return "agent closed";
      default: return status ? `agent ${status}` : "";
    }
  })();
  if (!text) return "";
  const said = state.toLowerCase();
  if ((status === "running" || status === "initializing") && said.startsWith("running")) return "";
  if (status === "permission" && said.includes("permission")) return "";
  if (status === "error" && said.includes("error")) return "";
  return text;
}
