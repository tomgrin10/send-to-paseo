/**
 * Stored settings. This module is only ever bundled into the service worker and
 * the options page — never into a content script. `token` must not cross into
 * page-adjacent code.
 */

export interface StoredSettings {
  bridgeUrl: string;
  token: string;
  defaultProvider: string;
}

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7788";

const DEFAULTS: StoredSettings = {
  bridgeUrl: DEFAULT_BRIDGE_URL,
  token: "",
  defaultProvider: "",
};

const KEY = "settings";

export async function readSettings(): Promise<StoredSettings> {
  const got = await chrome.storage.local.get(KEY);
  const raw = (got?.[KEY] ?? {}) as Partial<StoredSettings>;
  return {
    bridgeUrl: normaliseBridgeUrl(raw.bridgeUrl ?? DEFAULTS.bridgeUrl),
    token: typeof raw.token === "string" ? raw.token : DEFAULTS.token,
    defaultProvider:
      typeof raw.defaultProvider === "string"
        ? raw.defaultProvider
        : DEFAULTS.defaultProvider,
  };
}

export async function writeSettings(
  patch: Partial<StoredSettings>,
): Promise<StoredSettings> {
  const next = { ...(await readSettings()), ...patch };
  next.bridgeUrl = normaliseBridgeUrl(next.bridgeUrl);
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Strip a trailing slash so `new URL("/v1/ping", base)` is predictable. */
export function normaliseBridgeUrl(url: string): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return DEFAULT_BRIDGE_URL;
  return trimmed.replace(/\/+$/, "");
}
