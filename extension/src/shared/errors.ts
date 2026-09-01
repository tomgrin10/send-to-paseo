/**
 * Error presentation. Every code in CONTRACT.md's table plus the extension's
 * own local codes maps to a specific, actionable sentence. There is no bare
 * "failed" anywhere in this file — that is the point of it.
 */

import type { AnyErrorCode, ContractErrorCode, LocalErrorCode } from "./contract";

export interface PresentedError {
  /** Short bold headline shown in the popover / options page. */
  title: string;
  /** One concrete next step. */
  hint: string;
  /** Render an "Open extension options" link. */
  openOptions?: boolean;
}

/**
 * Typed as an exhaustive Record over both code unions, so omitting any code from
 * CONTRACT.md's table is a COMPILE error rather than a runtime "failed".
 */
const TABLE: Record<ContractErrorCode | LocalErrorCode, PresentedError> = {
  /* ---- CONTRACT.md error codes ------------------------------------------ */
  unauthorized: {
    title: "Not paired with Paseo",
    hint: "Paste the pairing token from the Paseo plugin surface into the extension options.",
    openOptions: true,
  },
  forbidden_origin: {
    title: "Bridge rejected this extension's origin",
    hint: "The bridge only accepts chrome-extension:// origins. If you pinned extension IDs in the plugin settings, add this extension's ID.",
    openOptions: true,
  },
  forbidden_host: {
    title: "Bridge rejected the request host",
    hint: "The bridge URL must be http://127.0.0.1:<port> or http://localhost:<port>. Check the bridge URL in options.",
    openOptions: true,
  },
  bad_request: {
    title: "The bridge rejected this request",
    hint: "This is a bug in the extension or a contract mismatch. Check the plugin version in options → Test connection.",
  },
  payload_too_large: {
    title: "Message too long",
    hint: "Shorten the instruction to under 16,000 characters and send again.",
  },
  rate_limited: {
    title: "Slow down",
    hint: "The bridge allows 60 requests per 10 seconds. Wait a moment and try again.",
  },
  project_not_found: {
    title: "This repo isn't a Paseo project",
    hint: "Add the repository as a project in Paseo, then reopen this popover.",
  },
  pr_not_found: {
    title: "Couldn't find this pull request",
    hint: "Check that the PR exists and that your GitHub account can see it.",
  },
  forge_unauthenticated: {
    title: "GitHub CLI isn't authenticated",
    hint: "Run: gh auth login",
  },
  workspace_create_failed: {
    title: "Couldn't create a worktree for this PR",
    hint: "See the reason above, then check `paseo plugin logs send-to-paseo`.",
  },
  agent_create_failed: {
    title: "Paseo refused to start the agent",
    hint: "See the reason above, then check the Paseo app for daemon errors.",
  },
  daemon_unreachable: {
    title: "Paseo daemon unreachable",
    hint: "Start the Paseo app (or `paseo daemon start`) and try again.",
  },
  internal: {
    title: "The bridge hit an unexpected error",
    hint: "Check `paseo plugin logs send-to-paseo` for the stack trace.",
  },

  /* ---- extension-local codes ------------------------------------------- */
  bridge_unreachable: {
    title: "Can't reach the Paseo bridge",
    hint: "Open Paseo and make sure the send-to-paseo plugin is running, then check the bridge URL in options.",
    openOptions: true,
  },
  not_configured: {
    title: "Not paired with Paseo",
    hint: "Open the extension options and paste the pairing token from the Paseo plugin surface.",
    openOptions: true,
  },
  bad_response: {
    title: "The bridge sent something unexpected",
    hint: "The plugin may be a different contract version. Run options → Test connection to see what it reports.",
    openOptions: true,
  },
  contract_mismatch: {
    title: "Update required",
    hint: "The Paseo plugin and this extension speak different contract versions. Update whichever is older, then reload this page. Options → Test connection reports both.",
    openOptions: true,
  },
  extension_internal: {
    title: "The extension hit an unexpected error",
    hint: "Reload the page. If it persists, check the service worker console in chrome://extensions.",
  },
};

const UNKNOWN: PresentedError = {
  title: "The bridge reported an error it didn't document",
  hint: "Check `paseo plugin logs send-to-paseo`; the raw code is shown above.",
};

/**
 * Shell commands the bridge is allowed to mention. CONTRACT.md Clarifications:
 * `hint` carries commands BARE ("gh auth login", not backticked) and the
 * extension owns presentation — so the formatting lives here, as an exact-match
 * list rather than a regex that might mangle prose.
 */
export const KNOWN_COMMANDS = [
  "gh auth login",
  "gh auth status",
  "paseo plugin logs send-to-paseo",
  "paseo plugin reload send-to-paseo",
  "paseo plugin ls",
  "paseo daemon start",
  "paseo daemon status",
] as const;

export function presentError(code: AnyErrorCode): PresentedError {
  return (
    TABLE[code as ContractErrorCode] ?? { ...UNKNOWN, title: `Unrecognised error: ${code}` }
  );
}
