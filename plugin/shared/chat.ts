import { z } from "zod";

/**
 * Send to Paseo as it appears inside an agent's chat, reduced to what a card or a
 * one-line row needs. Pure, so the transformers and the tests read the same rules.
 *
 * The provenance card is parsed back out of the header `composePrompt` writes
 * (CONTRACT.md, "Prompt header"). The header itself is unchanged: agents still
 * read exactly the same text; only the person sees the card.
 */
export const PROVENANCE_CARD_KIND = "send-to-paseo-provenance";
export const TOOL_ROW_KIND = "send-to-paseo-tool";

export const ProvenanceSchema = z.object({
  forge: z.string(),
  repo: z.string(),
  number: z.number(),
  /** Null when `gh` could not describe the PR (the degraded header). */
  title: z.string().nullable(),
  head: z.string().nullable(),
  base: z.string().nullable(),
  prUrl: z.string(),
  pageUrl: z.string().nullable(),
  /** Where the user pressed Send, from the Page: line. */
  site: z.enum(["github", "graphite"]).nullable(),
  /** Set only when the workspace is not on the PR's own branch, or when gh was unavailable. */
  workspaceBranch: z.string().nullable(),
  /** How the workspace branch relates to the PR, when the header says. */
  branchState: z.enum(["sibling", "merged", "closed"]).nullable(),
  degraded: z.boolean(),
  instruction: z.string(),
  text: z.string(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

const HEADER = /^\[Sent from Graphite — ([a-z]+)\/([^/\s]+)\/(\S+) PR #(\d+)\]$/;

function siteOf(url: string | null): Provenance["site"] {
  if (url === null) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (/(^|\.)graphite\.(dev|com)$/.test(host)) return "graphite";
  } catch {
    // Not a URL; say nothing about the site rather than guess.
  }
  return null;
}

/** The card for a message Send to Paseo wrote, or null for anything else. */
export function provenance(text: string): Provenance | null {
  const split = text.indexOf("\n\n");
  if (split < 0) return null;
  const lines = text.slice(0, split).split("\n");
  const header = HEADER.exec(lines[0] ?? "");
  if (!header) return null;
  const field = (name: string) => {
    const line = lines.find((entry) => entry.startsWith(`${name}: `));
    return line === undefined ? null : line.slice(name.length + 2).trim();
  };
  const prUrl = field("PR");
  if (prUrl === null) return null;
  const branch = field("Branch");
  const arrow = branch === null ? null : /^(.*) -> (.*)$/.exec(branch);
  const rawWorkspace = field("Workspace branch");
  const workspaceBranch = rawWorkspace === null ? null : rawWorkspace.replace(/\s*\(NOT this PR's branch.*\)$/, "");
  const branchState: Provenance["branchState"] =
    rawWorkspace === null || !/NOT this PR's branch/.test(rawWorkspace)
      ? null
      : /already merged/.test(rawWorkspace)
        ? "merged"
        : /closed without merging/.test(rawWorkspace)
          ? "closed"
          : "sibling";
  const pageUrl = field("Page");
  return {
    forge: header[1]!,
    repo: `${header[2]}/${header[3]}`,
    number: Number(header[4]),
    title: field("Title"),
    head: arrow?.[1] ?? null,
    base: arrow?.[2] ?? null,
    prUrl,
    pageUrl,
    site: siteOf(pageUrl),
    workspaceBranch,
    branchState,
    degraded: field("Title") === null,
    instruction: text.slice(split + 2).trim(),
    text,
  };
}

export const ToolRowSchema = z.object({
  state: z.enum(["running", "done", "failed"]),
  /** "Checked the bridge · running · paired". */
  line: z.string(),
  detail: z.string(),
  /** Muted unless something needs attention. */
  tone: z.enum(["neutral", "warning", "danger"]),
});
export type ToolRow = z.infer<typeof ToolRowSchema>;

/** Claude records mcp__paseo__send_to_paseo_bridge_status; Codex paseo.send_to_paseo_bridge_status. */
export function isBridgeStatusTool(name: string): boolean {
  return /(^|__|\.|\/|:)send_to_paseo_bridge_status$/.test(name);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text a tool result carries, however the provider wrapped it. */
export function readText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readText).join("\n");
  if (!record(value)) return "";
  if (typeof value.type === "string" && typeof value.text === "string") return value.text;
  const key = ["content", "output", "text", "message", "result", "structuredContent"].find((name) => name in value);
  if (key) return readText(value[key]);
  return JSON.stringify(value);
}

const BridgeResultSchema = z.object({
  state: z.string(),
  port: z.number().optional(),
  paired: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  dependencies: z.array(z.object({ name: z.string(), state: z.string() })).optional(),
});

/** One line for the agent tool, from its JSON result. */
export function bridgeToolRow(status: string, output: unknown, error: unknown): ToolRow {
  if (status === "running" || status === "pending") {
    return { state: "running", line: "Checking the Send to Paseo bridge", detail: "", tone: "neutral" };
  }
  const text = readText(output).trim();
  if (status === "failed" || (typeof error === "string" && error !== "")) {
    return { state: "failed", line: "Couldn't check the Send to Paseo bridge", detail: typeof error === "string" && error !== "" ? error : text, tone: "danger" };
  }
  let parsed: z.infer<typeof BridgeResultSchema> | null = null;
  try {
    const json = BridgeResultSchema.safeParse(JSON.parse(text.slice(text.indexOf("{"))));
    parsed = json.success ? json.data : null;
  } catch {
    parsed = null;
  }
  if (parsed === null) return { state: "done", line: "Checked the Send to Paseo bridge", detail: text, tone: "neutral" };
  const missing = (parsed.dependencies ?? []).filter((dep) => dep.state !== "ok").map((dep) => dep.name);
  const parts = [
    parsed.state === "running" ? `listening on ${parsed.port ?? "its port"}` : parsed.state,
    parsed.paired ? "paired" : "not paired yet",
    ...(missing.length === 0 ? [] : [`${missing.join(", ")} missing`]),
    ...(parsed.dryRun ? ["dry run"] : []),
  ];
  const tone: ToolRow["tone"] = parsed.state !== "running" ? "danger" : !parsed.paired || missing.length > 0 ? "warning" : "neutral";
  return { state: "done", line: `Checked the Send to Paseo bridge · ${parts.join(" · ")}`, detail: text, tone };
}
