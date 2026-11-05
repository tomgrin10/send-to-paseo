export interface Summary {
  state: "starting" | "running" | "failed" | "stopped";
  paired: boolean;
  lastSendAt: string | null;
  lastSendFailed: boolean;
}

/** What the sidebar dot says, or null when nothing needs the person. */
export function summaryAttention(summary: Summary): { tone: "warning" | "danger"; label: string } | null {
  if (summary.state === "failed" || summary.state === "stopped") return { tone: "danger", label: "Bridge is not running" };
  if (summary.lastSendFailed) return { tone: "danger", label: "The last send failed" };
  if (!summary.paired) return { tone: "warning", label: "Not paired with Chrome yet" };
  return null;
}
