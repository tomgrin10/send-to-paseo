/**
 * Options page. Runs in an extension page (not a content script), so it is
 * allowed to read/write tokens directly — it never shares a world with a web
 * page.
 *
 * It manages a *list* of Paseo hosts. Each card owns one bridge URL, one
 * pairing token and one connection verdict, because those three are per-machine
 * and a single shared status box would have to lie about at least one of them.
 */

import { CONTRACT_VERSION, type Provider } from "../shared/contract";
import { presentError } from "../shared/errors";
import { renderProse } from "../shared/format";
import { ping } from "../background/bridge-client";
import {
  addHost,
  authorityOf,
  DEFAULT_BRIDGE_URL,
  originPatternFor,
  readSettings,
  removeHost,
  writeHost,
  writeSettings,
  type HostConfig,
} from "../background/settings";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const hostsBox = $<HTMLDivElement>("hosts");
const hostTemplate = $<HTMLTemplateElement>("hostTemplate");
const addHostBtn = $<HTMLButtonElement>("addHost");
const testAllBtn = $<HTMLButtonElement>("testAll");
const defaultProvider = $<HTMLSelectElement>("defaultProvider");
const providerHelp = $<HTMLSpanElement>("providerHelp");
const savedFlag = $<HTMLSpanElement>("saved");

let savedTimer: number | undefined;

function flashSaved(): void {
  savedFlag.dataset.on = "1";
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => delete savedFlag.dataset.on, 1400) as unknown as number;
}

type Tone = "idle" | "ok" | "warn" | "bad" | "busy";

function setStatus(
  box: HTMLElement,
  tone: Tone,
  title: string,
  detail?: string,
  hint?: string,
): void {
  box.dataset.tone = tone === "busy" ? "idle" : tone;
  box.textContent = "";

  const st = document.createElement("span");
  st.className = "st";
  if (tone === "busy") {
    const sp = document.createElement("span");
    sp.className = "spinner";
    st.append(sp, document.createTextNode(" " + title));
  } else {
    st.textContent = title;
  }
  box.append(st);

  if (detail) {
    const sd = document.createElement("span");
    sd.className = "sd";
    sd.append(renderProse(detail));
    box.append(sd);
  }
  if (hint) {
    const sh = document.createElement("span");
    sh.className = "sh";
    sh.append(renderProse(hint));
    box.append(sh);
  }
}

/* -------------------------------------------------------------------------- */
/* provider picker                                                            */
/* -------------------------------------------------------------------------- */

const NO_PROVIDER = "";

/**
 * Populate the picker from the union of every host's providers.
 *
 * A union rather than one host's list, because this setting is a preference
 * ("I want Opus") applied to whichever host a send lands on. The composer still
 * offers only the selected host's own providers, so a union entry that one
 * machine lacks degrades to that machine's default rather than being sent.
 */
function renderProviders(providers: Provider[], selected: string, hostCount: number): void {
  defaultProvider.textContent = "";
  defaultProvider.append(
    new Option("(use each host's own default)", NO_PROVIDER, false, selected === NO_PROVIDER),
  );

  for (const p of providers) {
    defaultProvider.append(
      new Option(
        p.isDefault ? `${p.label} — ${p.id} (a host default)` : `${p.label} — ${p.id}`,
        p.id,
        false,
        p.id === selected,
      ),
    );
  }

  // Never silently drop a stored choice no bridge listed.
  if (selected !== NO_PROVIDER && !providers.some((p) => p.id === selected)) {
    defaultProvider.append(
      new Option(`${selected} (not offered by any host)`, selected, false, true),
    );
  }
  defaultProvider.value = selected;

  providerHelp.textContent = providers.length
    ? `${providers.length} providers reported across ${hostCount} host${hostCount === 1 ? "" : "s"}.`
    : "No providers known yet — run Test all connections with a valid token.";
}

/**
 * The per-host provider cache the service worker writes.
 *
 * Stored as `{ [hostId]: Provider[] }`. An array here is the pre-multi-host
 * shape; it is read as one anonymous host's list rather than discarded, so the
 * picker is not empty on the first load after an upgrade.
 */
async function cachedProviders(): Promise<Provider[]> {
  const got = await chrome.storage.local.get("lastProviders");
  const raw = got?.lastProviders;
  const lists: Provider[][] = Array.isArray(raw)
    ? [raw as Provider[]]
    : raw !== null && typeof raw === "object"
      ? Object.values(raw as Record<string, Provider[]>).filter(Array.isArray)
      : [];

  const byId = new Map<string, Provider>();
  for (const list of lists) {
    for (const p of list) {
      if (p && typeof p.id === "string" && !byId.has(p.id)) byId.set(p.id, p);
    }
  }
  return [...byId.values()];
}

/* -------------------------------------------------------------------------- */
/* test connection — the same six outcomes, now per host                      */
/* -------------------------------------------------------------------------- */

/**
 * The user needs to be able to tell these apart, so each gets its own tone and
 * headline:
 *
 *   1. bridge unreachable        -> bad   "Can't reach the Paseo bridge"
 *   2. token rejected (401)      -> bad   "Token rejected"
 *   3. no token stored           -> warn  "Bridge reachable, not paired yet"
 *   4. paired                    -> ok    "Paired with Paseo"
 *   5. contract mismatch         -> bad   "Update required"
 *   6. bridge up, daemon down    -> warn  "Bridge up, Paseo daemon unreachable"
 *
 * `host` is passed by value, not re-read: the caller has just flushed what is on
 * screen, and re-reading would race the debounced autosave.
 */
async function testConnection(row: HostRow, host: HostConfig): Promise<void> {
  row.test.disabled = true;
  const hasToken = host.token.trim().length > 0;

  setStatus(
    row.status,
    "busy",
    "Contacting the bridge…",
    `GET ${host.bridgeUrl}/v1/ping${hasToken ? " with your token" : " (no token stored)"}`,
  );

  const res = await ping(host, { authenticated: hasToken });
  row.test.disabled = false;

  if (!res.ok) {
    const p = presentError(res.error.code);
    if (res.error.code === "unauthorized") {
      // Outcome 2: the bridge is up and answered — it just refused the token.
      // Only reachable because ping's auth is optional; a token-free ping would
      // have returned 200 here.
      setStatus(
        row.status,
        "bad",
        "Token rejected",
        res.error.message,
        "This bridge is running but did not accept this token. Copy it again from that machine's Paseo → send-to-paseo → Pairing token. Tokens are per host and never interchangeable.",
      );
      return;
    }
    setStatus(row.status, "bad", p.title, res.error.message, res.error.hint ?? p.hint);
    return;
  }

  const d = res.data;

  // Contract gate, reported rather than silently tolerated.
  if (d.contract !== CONTRACT_VERSION) {
    setStatus(
      row.status,
      "bad",
      "Update required",
      `The plugin on this host speaks bridge contract v${d.contract}; this extension was built for v${CONTRACT_VERSION}.`,
      "Sends are blocked to this host until the versions match. Update whichever side is older. Other hosts are unaffected.",
    );
    return;
  }

  // A bridge that names itself gets to relabel its own card, but only while the
  // user has not named it — never overwrite a label someone typed.
  const machineName = (d.machine?.name ?? "").trim();
  if (machineName && machineName !== host.machineName) {
    await writeHost(host.id, { machineName });
    if (!host.label.trim()) row.label.placeholder = machineName;
  }

  await refreshProviderPicker();

  const daemonBit = d.daemon.reachable
    ? `daemon ${d.daemon.version ?? "?"} (${d.daemon.serverId ?? "no serverId"})`
    : "daemon UNREACHABLE";
  const machineBit = machineName ? `${machineName} · ` : "";
  const detail = `${machineBit}${d.name} ${d.version} · contract v${d.contract} · ${daemonBit} · ${d.providers?.length ?? 0} providers`;

  if (!d.daemon.reachable) {
    setStatus(
      row.status,
      "warn",
      "Bridge up, Paseo daemon unreachable",
      detail,
      "Start the Paseo app on that machine, then test again.",
    );
    return;
  }

  if (!hasToken) {
    // Outcome 3: liveness confirmed, pairing not done.
    setStatus(
      row.status,
      "warn",
      "Bridge reachable, not paired yet",
      detail,
      "Paste this host's pairing token above to finish pairing. Until then it is skipped when a pull request is resolved.",
    );
    return;
  }

  if (!d.paired) {
    setStatus(
      row.status,
      "warn",
      "Bridge reachable, but it reports not paired",
      detail,
      "The token was accepted but the bridge says paired: false. Test again; if it persists, check `paseo plugin logs send-to-paseo`.",
    );
    return;
  }

  setStatus(
    row.status,
    "ok",
    "Paired with Paseo",
    detail,
    "Open a GitHub or Graphite PR and click Send to Paseo.",
  );
}

/* -------------------------------------------------------------------------- */
/* host rows                                                                  */
/* -------------------------------------------------------------------------- */

interface HostRow {
  el: HTMLElement;
  label: HTMLInputElement;
  url: HTMLInputElement;
  token: HTMLInputElement;
  enabled: HTMLInputElement;
  status: HTMLElement;
  test: HTMLButtonElement;
  grantRow: HTMLElement;
  grantHelp: HTMLElement;
}

const pick = <T extends HTMLElement>(root: ParentNode, cls: string): T =>
  root.querySelector(`.${cls}`) as T;

/**
 * A fetch to a host Chrome has not granted fails as a bare network error, which
 * reads exactly like "the bridge is down". So the grant row is surfaced next to
 * the URL that needs it, and re-checked whenever that URL changes.
 *
 * Only `127.0.0.1:7788` is granted by the manifest. Every tunnel port is a
 * different origin and needs its own consent — which is the correct trade for
 * an endpoint that can start agents.
 */
async function refreshGrantRow(row: HostRow): Promise<void> {
  const pattern = originPatternFor(row.url.value);
  if (!pattern) {
    row.grantRow.hidden = true;
    row.grantHelp.textContent = "";
    return;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    granted = false;
  }
  row.grantRow.hidden = granted;
  row.grantHelp.textContent = granted ? "" : `Chrome needs permission for ${pattern}`;
}

function buildRow(host: HostConfig, index: number, total: number): HostRow {
  const frag = hostTemplate.content.cloneNode(true) as DocumentFragment;
  const el = frag.querySelector(".host") as HTMLElement;
  el.dataset.stpHost = host.id;
  el.dataset.enabled = host.enabled ? "1" : "0";

  const row: HostRow = {
    el,
    label: pick<HTMLInputElement>(el, "hostLabel"),
    url: pick<HTMLInputElement>(el, "hostUrl"),
    token: pick<HTMLInputElement>(el, "hostToken"),
    enabled: pick<HTMLInputElement>(el, "hostEnabled"),
    status: pick<HTMLElement>(el, "hostStatus"),
    test: pick<HTMLButtonElement>(el, "hostTest"),
    grantRow: pick<HTMLElement>(el, "hostGrantRow"),
    grantHelp: pick<HTMLElement>(el, "hostGrantHelp"),
  };

  (pick<HTMLElement>(el, "idx")).textContent = `${index + 1}`;
  row.label.value = host.label;
  // The placeholder carries the fallback the rest of the UI would show, so an
  // unnamed host still reads as something. `machineName` is what the bridge
  // called itself; the authority is the last resort.
  row.label.placeholder = host.machineName || authorityOf(host.bridgeUrl) || "name this host";
  row.label.setAttribute("aria-label", "Host name");
  row.url.value = host.bridgeUrl;
  row.token.value = host.token;
  row.enabled.checked = host.enabled;
  // Removing the only host would leave a settings page with nothing on it and
  // no way to get back to a working state, so the last one stays.
  const removeBtn = pick<HTMLButtonElement>(el, "hostRemove");
  removeBtn.disabled = total <= 1;
  if (total <= 1) removeBtn.title = "The last host can't be removed — edit it instead.";

  /* ---- wiring ---------------------------------------------------------- */

  debouncedSave(row.label, () => writeHost(host.id, { label: row.label.value }));
  debouncedSave(row.url, async () => {
    await writeHost(host.id, { bridgeUrl: row.url.value });
    await refreshGrantRow(row);
    if (!row.label.value.trim()) {
      row.label.placeholder = authorityOf(row.url.value) || "name this host";
    }
  });
  debouncedSave(row.token, () => writeHost(host.id, { token: row.token.value }));

  row.enabled.addEventListener("change", async () => {
    await writeHost(host.id, { enabled: row.enabled.checked });
    el.dataset.enabled = row.enabled.checked ? "1" : "0";
    flashSaved();
  });

  pick<HTMLButtonElement>(el, "hostReveal").addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const showing = row.token.type === "text";
    row.token.type = showing ? "password" : "text";
    btn.textContent = showing ? "Show" : "Hide";
  });

  pick<HTMLButtonElement>(el, "hostClear").addEventListener("click", async () => {
    row.token.value = "";
    await writeHost(host.id, { token: "" });
    flashSaved();
    setStatus(
      row.status,
      "idle",
      "Token cleared",
      "This host is no longer paired, and is skipped when a pull request is resolved.",
    );
  });

  pick<HTMLButtonElement>(el, "hostGrant").addEventListener("click", async () => {
    const pattern = originPatternFor(row.url.value);
    if (!pattern) return;
    try {
      await chrome.permissions.request({ origins: [pattern] });
    } catch (e) {
      setStatus(row.status, "bad", "Couldn't request permission", String(e));
    }
    await refreshGrantRow(row);
  });

  removeBtn.addEventListener("click", async () => {
    await removeHost(host.id);
    flashSaved();
    await load();
  });

  row.test.addEventListener("click", () => void flushAndTest(row, host.id));

  void refreshGrantRow(row);
  return row;
}

/**
 * Flush the debounced saves for this card, then test what was actually stored.
 *
 * The stored value is the one the service worker will use on a real send, so
 * testing anything else would verify a configuration that does not exist.
 */
async function flushAndTest(row: HostRow, hostId: string): Promise<void> {
  await writeHost(hostId, {
    label: row.label.value,
    bridgeUrl: row.url.value,
    token: row.token.value,
  });
  const stored = (await readSettings()).hosts.find((h) => h.id === hostId);
  if (!stored) return;
  row.url.value = stored.bridgeUrl; // normalisation is visible, not silent
  await refreshGrantRow(row);
  await testConnection(row, stored);
}

function debouncedSave(input: HTMLInputElement, save: () => Promise<unknown>): void {
  let t: number | undefined;
  input.addEventListener("input", () => {
    if (t) clearTimeout(t);
    t = setTimeout(async () => {
      await save();
      flashSaved();
    }, 250) as unknown as number;
  });
}

/* -------------------------------------------------------------------------- */

let rows: { row: HostRow; hostId: string }[] = [];

async function refreshProviderPicker(): Promise<void> {
  const s = await readSettings();
  renderProviders(await cachedProviders(), s.defaultProvider, s.hosts.length);
}

/**
 * Render the whole list.
 *
 * Note it does NOT write: an earlier version of this page saved settings during
 * its read-only load, which turned opening it into a side effect and clobbered
 * concurrent writes. The e2e suite still asserts that.
 */
async function load(): Promise<void> {
  const s = await readSettings();
  hostsBox.textContent = "";
  rows = [];

  if (s.hosts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No Paseo host yet. Press “Add a host”.";
    hostsBox.append(empty);
  }

  for (const [i, host] of s.hosts.entries()) {
    const row = buildRow(host, i, s.hosts.length);
    hostsBox.append(row.el);
    rows.push({ row, hostId: host.id });
  }

  renderProviders(await cachedProviders(), s.defaultProvider, s.hosts.length);

  // With a token present, refresh providers (and the pairing verdict) straight
  // away — that is the whole point of ping taking optional auth. Sequential
  // rather than parallel so a slow host cannot interleave its status writes
  // with another card's.
  for (const { row, hostId } of rows) {
    const host = s.hosts.find((h) => h.id === hostId);
    if (host?.token) await testConnection(row, host);
  }
}

/**
 * The URL a freshly added card starts on: one past the highest loopback port
 * already configured.
 *
 * Not the default bridge URL. With one host already there, a second card
 * pointing at the same bridge is never what was meant, and two entries for one
 * bridge would resolve it twice and show every candidate twice in the composer.
 * A tunnel is typically `ssh -L <next>:127.0.0.1:7788`, so "next port up" is
 * also the number the user is about to type.
 */
function nextBridgeUrl(hosts: HostConfig[]): string {
  const ports = hosts
    .map((h) => Number(authorityOf(h.bridgeUrl).split(":")[1] ?? ""))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65535);
  if (ports.length === 0) return DEFAULT_BRIDGE_URL;
  return `http://127.0.0.1:${Math.max(...ports) + 1}`;
}

addHostBtn.addEventListener("click", async () => {
  await addHost({ bridgeUrl: nextBridgeUrl((await readSettings()).hosts) });
  flashSaved();
  await load();
  hostsBox.querySelector<HTMLInputElement>(".host:last-of-type .hostLabel")?.focus();
});

testAllBtn.addEventListener("click", async () => {
  testAllBtn.disabled = true;
  for (const { row, hostId } of rows) await flushAndTest(row, hostId);
  testAllBtn.disabled = false;
});

defaultProvider.addEventListener("change", async () => {
  await writeSettings({ defaultProvider: defaultProvider.value });
  flashSaved();
});

// A host renamed or re-pointed from another surface (the composer's cog opens
// this page in a second tab) must not leave a stale list behind.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const before = changes.settings.oldValue as { hosts?: unknown[] } | undefined;
  const after = changes.settings.newValue as { hosts?: unknown[] } | undefined;
  // Only a change in the *set* of hosts needs a rebuild. Reacting to every
  // keystroke's autosave would rip the focused input out from under the user.
  if ((before?.hosts?.length ?? -1) !== (after?.hosts?.length ?? -1)) void load();
});

void load();
