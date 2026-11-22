/**
 * What the page button says about the PR's workspace, before anyone opens it.
 *
 * Pure and `chrome`-free, like merge.ts and open-workspace.ts: the rules are
 * readable (and tested) without a browser. The input is the resolve answer the
 * page already made when the button mounted (`warmPopoverResolution`), so the
 * state costs no request of its own.
 *
 * Direction D (DESIGN.md, "Workspace state on the button"):
 * - The label never changes: "Send to Paseo", with Paseo's mark.
 * - A mark, read by shape before colour:
 *     `needs`   a 9px solid dot in the state's tone. Only here a word chip
 *               joins the label ("Asks you", "Merge ready", "2 need you").
 *     `working` a small blue dot: an agent or Follow-up is working on it.
 *     `cross`   an ×: couldn't reach Paseo, or not set up.
 *     `none`    waiting, quiet, done, no owner, or nothing known yet.
 * - The accessible name stays "Send to Paseo", with the state appended.
 * - The tooltip carries Follow-up's full line, the workspace and the machine,
 *   or how to fix the ×.
 */
import type { FailurePayload, HostSlice, MultiResolveResponse, Result } from "./messages";
// `.ts` so the unit tests can load this file with Node's type stripping (esbuild resolves it as usual).
import { ownerSection, type OwnerRow } from "./open-workspace.ts";

export const LABEL = "Send to Paseo";

/** Follow-up's `tone` on each `follow.pr-workspaces` row (Follow-up 2.3.1+). */
export const TONES = ["attention", "danger", "success", "accent", "muted"] as const;
export type Tone = (typeof TONES)[number];

export type WorkspaceMark = "none" | "working" | "needs" | "cross";

export interface WorkspaceState {
  mark: WorkspaceMark;
  /** Colour of the dot and the chip. Null for `none`. */
  tone: Tone | null;
  /** The word chip, only in needs-you states. */
  chip: string | null;
  /** Appended to "Send to Paseo" in the accessible name, or null. */
  spoken: string | null;
  /** The tooltip: first line strong, the rest quieter. Empty means the plain idle tooltip. */
  tip: string[];
}

export const PLAIN: WorkspaceState = { mark: "none", tone: null, chip: null, spoken: null, tip: [] };

const NEEDS_PREFIX = "Needs you · ";
const WORKING_GROUPS = new Set(["running", "sending", "fixing"]);
/** Unreachable is not unpaired: the bridge did not answer at all. */
const UNREACHABLE_CODES = new Set(["bridge_unreachable", "timeout"]);
/** The user's next step is in settings: pair, or allow the connection. */
const SETUP_CODES = new Set(["not_configured", "unauthorized", "permission_required"]);

function isTone(value: unknown): value is Tone {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

/**
 * The tone of a row: Follow-up's own when it sent one, else the group's, so an
 * older Follow-up (no `tone`) still gets a dot. Never parsed from the English.
 */
export function rowTone(row: Pick<OwnerRow, "group"> & { tone?: unknown }): Tone {
  if (isTone(row.tone)) return row.tone;
  if (row.group === "needs") return "attention";
  if (WORKING_GROUPS.has(row.group)) return "accent";
  return "muted";
}

/** The chip's word: the part of Follow-up's line after "Needs you · " (its first badge). */
export function chipWord(state: string): string {
  const word = state.startsWith(NEEDS_PREFIX) ? state.slice(NEEDS_PREFIX.length).trim() : "";
  return word || "Needs you";
}

function where(row: OwnerRow, hosts: readonly HostSlice[]): string {
  const host = hosts[row.hostIndex]?.hostLabel;
  return host ? `${row.title} on ${host}` : row.title;
}

/** A standalone send target with a running main agent, when Follow-up said nothing. */
function standaloneRunning(data: MultiResolveResponse): { title: string; host: string } | null {
  for (const c of data.candidates) {
    if (c.kind !== "existing" || c.reason !== "exact") continue;
    const status = c.mainAgent?.status;
    if (status === "running" || status === "initializing") {
      return { title: c.label, host: data.hosts[c.hostIndex]?.hostLabel ?? "" };
    }
  }
  return null;
}

function failureState(error: FailurePayload): WorkspaceState {
  if (SETUP_CODES.has(error.code)) {
    return {
      mark: "cross", tone: "muted", chip: null, spoken: "Not set up",
      tip: error.code === "permission_required"
        ? ["Not set up", "Allow the connection in Send to Paseo's settings"]
        : ["Not set up", "Open Send to Paseo's settings to pair this browser with Paseo"],
    };
  }
  if (UNREACHABLE_CODES.has(error.code)) {
    return {
      mark: "cross", tone: "muted", chip: null, spoken: "Couldn't reach Paseo",
      tip: ["Couldn't reach Paseo", "Check that Paseo is running, or test the connection in settings"],
    };
  }
  // Anything else (the repository isn't a Paseo project, a version mismatch) is
  // not a state of this PR's workspace. The composer explains it on click.
  return PLAIN;
}

/**
 * The button's workspace state from a resolve answer. `null` means the answer
 * hasn't landed: plain label, never a spinner for it.
 */
export function workspaceState(result: Result<MultiResolveResponse> | null): WorkspaceState {
  if (!result) return PLAIN;
  if (!result.ok) return failureState(result.error);
  const data = result.data;
  const section = ownerSection(data.hosts);
  const rows = section?.rows ?? [];

  const needs = rows.filter((r) => r.group === "needs");
  if (needs.length > 0) {
    const top = needs[0];
    const tone = rowTone(top);
    // The count is across rows only: Follow-up's `more` is not split by group.
    const chip = needs.length > 1 ? `${needs.length} need you` : chipWord(top.state);
    // Name the other workspaces that need you too, so "2 need you" doesn't need a click to explain.
    const others = needs.slice(1).map((r) => `Also ${where(r, data.hosts)}: ${chipWord(r.state)}`);
    return {
      mark: "needs", tone, chip, spoken: chip,
      tip: [top.state || "Needs you", where(top, data.hosts), ...others],
    };
  }

  const working = rows.find((r) => WORKING_GROUPS.has(r.group) || (!r.group && (r.agentStatus === "running" || r.agentStatus === "initializing")));
  if (working) {
    return {
      mark: "working", tone: "accent", chip: null, spoken: "Agent working",
      tip: [working.state || "Running", where(working, data.hosts)],
    };
  }

  const top = rows[0];
  if (top) {
    // Waiting, quiet, done: no mark, but the tooltip still says where it stands.
    return { ...PLAIN, tip: [top.state || "Registered for this PR", where(top, data.hosts)] };
  }

  // Follow-up absent, off, or out of scope: the standalone main agent, if it is busy.
  if (!section) {
    const busy = standaloneRunning(data);
    if (busy) {
      return {
        mark: "working", tone: "accent", chip: null, spoken: "Agent working",
        tip: ["Agent working", busy.host ? `${busy.title} on ${busy.host}` : busy.title],
      };
    }
  }
  return PLAIN;
}

/** The accessible name: the label, with the state appended when there is one. */
export function accessibleName(state: WorkspaceState): string {
  return state.spoken ? `${LABEL}, ${state.spoken}` : LABEL;
}
