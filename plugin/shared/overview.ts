import type { BridgeStatus, RecentSend } from "./contracts";

export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/detail/send-to-paseo/blflbbgkckbabbkoigpocilbkkmfijfg";

export type Lead =
  | { kind: "down"; text: string; detail: string }
  | { kind: "setup"; text: string; detail: string }
  | { kind: "ready"; text: string; detail: string };

/** "4m ago", "just now". Absolute dates past a day. */
export function ago(iso: string | null, now = Date.now()): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "never";
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The one sentence at the top of the screen: is it working, and what is next. */
export function lead(status: BridgeStatus, sends: RecentSend[], now = Date.now()): Lead {
  if (status.state === "failed" || status.state === "stopped") {
    return {
      kind: "down",
      text: "The bridge isn't running",
      detail: status.error ?? `Nothing is listening on port ${status.configuredPort}. Reload the plugin, or pick another port under Connection details.`,
    };
  }
  if (status.state === "starting") return { kind: "ready", text: "Starting the bridge…", detail: "" };
  if (!status.paired) {
    return { kind: "setup", text: "Pair Chrome to start sending", detail: "Three steps, once. Then a Send to Paseo button appears on every GitHub and Graphite pull request." };
  }
  const today = new Date(now).toDateString();
  const sentToday = sends.filter((send) => send.outcome === "ok" && new Date(send.at).toDateString() === today).length;
  if (sends.length === 0) {
    return { kind: "ready", text: "Paired with Chrome", detail: "Open a pull request on GitHub or Graphite and press Send to Paseo. Your sends show up here." };
  }
  const count = sentToday === 0 ? "nothing sent today" : `${sentToday} send${sentToday === 1 ? "" : "s"} today`;
  return { kind: "ready", text: `Paired with Chrome · ${count}`, detail: `Last send ${ago(sends[0]!.at, now)}.` };
}

/** The second line of a send row: where it went and how. */
export function destination(send: RecentSend): string {
  if (send.outcome === "failed") return send.error ?? "Failed";
  const parts = [
    send.workspaceCreated ? `New worktree · ${send.workspaceLabel}` : send.workspaceLabel,
    send.dispatch === "main" ? `messaged ${send.title}` : "new agent",
    ...(send.dryRun ? ["dry run"] : []),
  ];
  return parts.join(" · ");
}

/** "acme/billing-service#421" → "acme/billing-service #421". */
export function prLabel(label: string): string {
  return label.replace(/#(\d+)$/, " #$1");
}
