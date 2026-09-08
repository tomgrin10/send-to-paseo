/**
 * Stored settings. This module is only ever bundled into the service worker and
 * the options page — never into a content script. A host's `token` must not
 * cross into page-adjacent code.
 *
 * The store holds a *list* of bridges, because one browser routinely faces more
 * than one Paseo machine: a laptop and a dev box, each running its own daemon
 * and its own copy of this plugin, the remote one reached through a loopback
 * tunnel. Every entry carries its own URL and its own pairing token — tokens
 * are per-plugin-install and are never interchangeable.
 */

export interface HostConfig {
  /** Stable local identity. Never shown, never sent to a bridge. */
  id: string;
  /**
   * What the user calls this machine. May be empty, in which case
   * `hostDisplayName` falls back to what the bridge said it was, then to the
   * URL's authority. Never empty *for display*.
   */
  label: string;
  bridgeUrl: string;
  token: string;
  /** Skip this host on resolve without forgetting its token. */
  enabled: boolean;
  /**
   * `machine.name` from the last successful ping, cached so the host list reads
   * as "devbox" rather than "127.0.0.1:7789" before anything is pinged again.
   * Additive on the wire, so a plugin that predates it leaves this "".
   */
  machineName: string;
}

export interface StoredSettings {
  version: 2;
  hosts: HostConfig[];
  /**
   * Preferred provider id, applied to whichever host a send lands on when that
   * host offers it. Global rather than per-host: it expresses "I want Opus",
   * which is not a fact about a machine.
   */
  defaultProvider: string;
}

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7788";

const KEY = "settings";

/** Shape written by versions before multi-host support. */
interface LegacySettings {
  bridgeUrl?: string;
  token?: string;
  defaultProvider?: string;
}

function newId(): string {
  // crypto.randomUUID is available in MV3 service workers and extension pages.
  return crypto.randomUUID();
}

/**
 * The id given to the single host a pre-multi-host store becomes.
 *
 * A CONSTANT, and that is the whole point. `readSettings` migrates in memory and
 * does not persist, so the same legacy store is migrated again on the next read
 * — and if the id were freshly random each time, nothing could be addressed
 * across two reads. `writeHost(id, …)` would match no host and silently do
 * nothing, and worse, a send would look up the `hostId` a resolve had just
 * returned, not find it, and refuse with "no longer configured". The first send
 * after an upgrade would fail.
 */
const LEGACY_HOST_ID = "migrated-default";

/**
 * A stable id for a stored host that has none — a hand-edited settings file, or
 * one written by a future version. Derived from the URL so it is identical on
 * every read, for the same reason as `LEGACY_HOST_ID`.
 */
function derivedId(bridgeUrl: string, index: number): string {
  return `url:${normaliseBridgeUrl(bridgeUrl)}#${index}`;
}

export function makeHost(patch: Partial<HostConfig> = {}): HostConfig {
  return {
    id: patch.id ?? newId(),
    label: typeof patch.label === "string" ? patch.label : "",
    bridgeUrl: normaliseBridgeUrl(patch.bridgeUrl ?? DEFAULT_BRIDGE_URL),
    token: typeof patch.token === "string" ? patch.token : "",
    enabled: patch.enabled !== false,
    machineName: typeof patch.machineName === "string" ? patch.machineName : "",
  };
}

function coerceHost(raw: unknown, index: number): HostConfig | null {
  if (raw === null || typeof raw !== "object") return null;
  const h = raw as Partial<HostConfig>;
  if (typeof h.bridgeUrl !== "string" || h.bridgeUrl.trim() === "") return null;
  return makeHost({
    ...h,
    id: typeof h.id === "string" && h.id !== "" ? h.id : derivedId(h.bridgeUrl, index),
  });
}

/**
 * Read, migrating a pre-multi-host store into a one-host list on the way past.
 *
 * The migration is deliberately **in memory only**. An earlier iteration of the
 * options page wrote settings during its read-only load, which turned opening
 * the page into a side effect and clobbered a concurrent write; the e2e suite
 * still asserts that reading never writes. The migrated shape is persisted the
 * next time something legitimately saves.
 */
export async function readSettings(): Promise<StoredSettings> {
  const got = await chrome.storage.local.get(KEY);
  const raw = (got?.[KEY] ?? {}) as Partial<StoredSettings> & LegacySettings;

  const defaultProvider =
    typeof raw.defaultProvider === "string" ? raw.defaultProvider : "";

  if (Array.isArray(raw.hosts)) {
    const hosts = raw.hosts
      .map((h, i) => coerceHost(h, i))
      .filter((h): h is HostConfig => h !== null);
    return { version: 2, hosts: dedupeIds(hosts), defaultProvider };
  }

  // Legacy single-bridge store, or an empty one. Either way it becomes exactly
  // one host, so a user who upgrades stays paired and sees no setup screen.
  return {
    version: 2,
    hosts: [
      makeHost({
        id: LEGACY_HOST_ID,
        bridgeUrl: raw.bridgeUrl ?? DEFAULT_BRIDGE_URL,
        token: raw.token ?? "",
      }),
    ],
    defaultProvider,
  };
}

/**
 * Two hosts sharing an id would make `hostById` ambiguous, and a send routes on
 * that id. Cheap to make impossible rather than to reason about.
 *
 * The replacement is DERIVED, never random: this runs inside `readSettings`,
 * which does not persist, so a random id would differ between two reads of the
 * same store and nothing could be addressed across them.
 */
function dedupeIds(hosts: HostConfig[]): HostConfig[] {
  const seen = new Set<string>();
  return hosts.map((h, i) => {
    if (h.id && !seen.has(h.id)) {
      seen.add(h.id);
      return h;
    }
    let id = derivedId(h.bridgeUrl, i);
    // Only reachable if a stored id already collides with a derived one.
    while (seen.has(id)) id = `${id}+`;
    seen.add(id);
    return { ...h, id };
  });
}

export async function writeSettings(
  patch: Partial<StoredSettings>,
): Promise<StoredSettings> {
  const next: StoredSettings = { ...(await readSettings()), ...patch, version: 2 };
  next.hosts = dedupeIds(
    next.hosts.map((h) => ({ ...h, bridgeUrl: normaliseBridgeUrl(h.bridgeUrl) })),
  );
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Applies a patch to one host by id. A missing id is a no-op, not a throw. */
export async function writeHost(
  id: string,
  patch: Partial<Omit<HostConfig, "id">>,
): Promise<StoredSettings> {
  const current = await readSettings();
  return writeSettings({
    hosts: current.hosts.map((h) => (h.id === id ? { ...h, ...patch } : h)),
  });
}

export async function addHost(patch: Partial<HostConfig> = {}): Promise<HostConfig> {
  const host = makeHost(patch);
  const current = await readSettings();
  await writeSettings({ hosts: [...current.hosts, host] });
  return host;
}

export async function removeHost(id: string): Promise<StoredSettings> {
  const current = await readSettings();
  return writeSettings({ hosts: current.hosts.filter((h) => h.id !== id) });
}

export async function hostById(id: string): Promise<HostConfig | null> {
  const { hosts } = await readSettings();
  return hosts.find((h) => h.id === id) ?? null;
}

/**
 * The hosts a resolve should fan out to: every **enabled** one.
 *
 * Deliberately not filtered on "has a token". The `enabled` tick is the user's
 * way of saying "skip this one", and it is the only thing that should make a
 * host disappear silently. A host that is enabled but has no token is an
 * unfinished setup, and dropping it without a word is the confusing case —
 * you added a machine, it never appears, and nothing says why. It surfaces as
 * a `not_configured` row instead.
 *
 * Firing no HTTP request for such a host is still guaranteed; that is enforced
 * one level up, in `resolveOnHost`.
 */
export async function enabledHosts(): Promise<HostConfig[]> {
  const { hosts } = await readSettings();
  return hosts.filter((h) => h.enabled);
}

/** Never empty: the user's name, else the bridge's own, else the authority. */
export function hostDisplayName(host: HostConfig): string {
  const label = host.label.trim();
  if (label) return label;
  if (host.machineName.trim()) return host.machineName.trim();
  return authorityOf(host.bridgeUrl) || host.bridgeUrl;
}

/** `http://127.0.0.1:7789` -> `127.0.0.1:7789`. `""` if unparseable. */
export function authorityOf(url: string): string {
  try {
    return new URL(normaliseBridgeUrl(url)).host;
  } catch {
    return "";
  }
}

/** Strip a trailing slash so `${bridgeUrl}/v1/ping` is predictable. */
export function normaliseBridgeUrl(url: string): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return DEFAULT_BRIDGE_URL;
  return trimmed.replace(/\/+$/, "");
}

/**
 * The `chrome.permissions` origin pattern for a bridge URL, or null when the URL
 * is not an http(s) one it makes sense to request.
 *
 * Shared by the options page's Grant button and the service worker's
 * pre-request check: a fetch to a host Chrome has not granted fails as a
 * network error, which reads as "bridge down" and sends the user hunting for a
 * daemon that is running perfectly well.
 */
export function originPatternFor(url: string): string | null {
  try {
    const u = new URL(normaliseBridgeUrl(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}
