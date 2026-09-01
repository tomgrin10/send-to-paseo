/**
 * Options page. Runs in an extension page (not a content script), so it is
 * allowed to read/write the token directly — it never shares a world with a
 * web page.
 */

import { CONTRACT_VERSION, type Provider } from "../shared/contract";
import { presentError } from "../shared/errors";
import { renderProse } from "../shared/format";
import { ping } from "../background/bridge-client";
import { normaliseBridgeUrl, readSettings, writeSettings } from "../background/settings";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const bridgeUrl = $<HTMLInputElement>("bridgeUrl");
const token = $<HTMLInputElement>("token");
const defaultProvider = $<HTMLSelectElement>("defaultProvider");
const providerHelp = $<HTMLSpanElement>("providerHelp");
const revealBtn = $<HTMLButtonElement>("reveal");
const clearBtn = $<HTMLButtonElement>("clear");
const testBtn = $<HTMLButtonElement>("test");
const statusBox = $<HTMLDivElement>("status");
const savedFlag = $<HTMLSpanElement>("saved");
const grantRow = $<HTMLDivElement>("grantRow");
const grantBtn = $<HTMLButtonElement>("grant");
const grantHelp = $<HTMLSpanElement>("grantHelp");

let savedTimer: number | undefined;

function flashSaved(): void {
  savedFlag.dataset.on = "1";
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => delete savedFlag.dataset.on, 1400) as unknown as number;
}

type Tone = "idle" | "ok" | "warn" | "bad" | "busy";

function setStatus(tone: Tone, title: string, detail?: string, hint?: string): void {
  statusBox.dataset.tone = tone === "busy" ? "idle" : tone;
  statusBox.textContent = "";

  const st = document.createElement("span");
  st.className = "st";
  if (tone === "busy") {
    const sp = document.createElement("span");
    sp.className = "spinner";
    st.append(sp, document.createTextNode(" " + title));
  } else {
    st.textContent = title;
  }
  statusBox.append(st);

  if (detail) {
    const sd = document.createElement("span");
    sd.className = "sd";
    sd.append(renderProse(detail));
    statusBox.append(sd);
  }
  if (hint) {
    const sh = document.createElement("span");
    sh.className = "sh";
    sh.append(renderProse(hint));
    statusBox.append(sh);
  }
}

/* -------------------------------------------------------------------------- */
/* provider picker                                                            */
/* -------------------------------------------------------------------------- */

const NO_PROVIDER = "";

/**
 * Populate the picker. Providers come from the bridge: `GET /v1/ping` with a
 * valid token returns the full list (CONTRACT.md "Token validation on ping"), and
 * `POST /v1/resolve` returns the same shape. The service worker caches whichever
 * arrived last so this page has something to show before its first ping.
 */
function renderProviders(providers: Provider[], selected: string): void {
  defaultProvider.textContent = "";
  defaultProvider.append(
    new Option("(use the plugin's default)", NO_PROVIDER, false, selected === NO_PROVIDER),
  );

  for (const p of providers) {
    defaultProvider.append(
      new Option(
        p.isDefault ? `${p.label} — ${p.id} (plugin default)` : `${p.label} — ${p.id}`,
        p.id,
        false,
        p.id === selected,
      ),
    );
  }

  // Never silently drop a stored choice the bridge didn't list.
  if (selected !== NO_PROVIDER && !providers.some((p) => p.id === selected)) {
    defaultProvider.append(new Option(`${selected} (not offered by the bridge)`, selected, false, true));
  }
  defaultProvider.value = selected;

  providerHelp.textContent = providers.length
    ? `${providers.length} providers reported by the bridge.`
    : "No providers known yet — run Test connection with a valid token.";
}

async function cachedProviders(): Promise<Provider[]> {
  const got = await chrome.storage.local.get("lastProviders");
  const list = got?.lastProviders;
  return Array.isArray(list) ? (list as Provider[]) : [];
}

/* -------------------------------------------------------------------------- */
/* optional host permission for a non-default bridge port                     */
/* -------------------------------------------------------------------------- */

function originPatternFor(url: string): string | null {
  try {
    const u = new URL(normaliseBridgeUrl(url));
    if (u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function refreshGrantRow(): Promise<void> {
  const pattern = originPatternFor(bridgeUrl.value);
  if (!pattern) {
    grantRow.hidden = true;
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  grantRow.hidden = granted;
  grantHelp.textContent = granted ? "" : `Chrome needs permission for ${pattern}`;
}

grantBtn.addEventListener("click", async () => {
  const pattern = originPatternFor(bridgeUrl.value);
  if (!pattern) return;
  try {
    await chrome.permissions.request({ origins: [pattern] });
  } catch (e) {
    setStatus("bad", "Couldn't request permission", String(e));
  }
  await refreshGrantRow();
});

/* -------------------------------------------------------------------------- */
/* test connection — three distinct outcomes                                  */
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
 */
async function testConnection({ flush = true } = {}): Promise<void> {
  testBtn.disabled = true;
  // Flush pending debounced saves so the client reads exactly what's on screen.
  // `flush: false` on page load: reading settings must never write them back —
  // that turned this page into a side effect and clobbered concurrent writes.
  if (flush) await writeSettings({ bridgeUrl: bridgeUrl.value, token: token.value });
  const hasToken = token.value.trim().length > 0;

  setStatus(
    "busy",
    "Contacting the bridge…",
    `GET ${normaliseBridgeUrl(bridgeUrl.value)}/v1/ping${hasToken ? " with your token" : " (no token stored)"}`,
  );

  const res = await ping({ authenticated: hasToken });
  testBtn.disabled = false;

  if (!res.ok) {
    const p = presentError(res.error.code);
    if (res.error.code === "unauthorized") {
      // Outcome 2: the bridge is up and answered — it just refused the token.
      // Only reachable because ping's auth is optional; a token-free ping would
      // have returned 200 here.
      setStatus(
        "bad",
        "Token rejected",
        res.error.message,
        "The bridge is running but did not accept this token. Copy it again from Paseo → send-to-paseo → Pairing token.",
      );
      return;
    }
    setStatus("bad", p.title, res.error.message, res.error.hint ?? p.hint);
    return;
  }

  const d = res.data;

  // Contract gate, reported rather than silently tolerated.
  if (d.contract !== CONTRACT_VERSION) {
    setStatus(
      "bad",
      "Update required",
      `The plugin speaks bridge contract v${d.contract}; this extension was built for v${CONTRACT_VERSION}.`,
      "Sends are blocked until the versions match. Update whichever side is older.",
    );
    return;
  }

  renderProviders(d.providers ?? [], defaultProvider.value);

  const daemonBit = d.daemon.reachable
    ? `daemon ${d.daemon.version ?? "?"} (${d.daemon.serverId ?? "no serverId"})`
    : "daemon UNREACHABLE";
  const detail = `${d.name} ${d.version} · contract v${d.contract} · ${daemonBit} · ${d.providers?.length ?? 0} providers`;

  if (!d.daemon.reachable) {
    setStatus(
      "warn",
      "Bridge up, Paseo daemon unreachable",
      detail,
      "Start the Paseo app, then test again.",
    );
    return;
  }

  if (!hasToken) {
    // Outcome 3: liveness confirmed, pairing not done.
    setStatus(
      "warn",
      "Bridge reachable, not paired yet",
      detail,
      "Paste the pairing token above to finish pairing. Until then the provider list is empty and sends will be refused.",
    );
    return;
  }

  if (!d.paired) {
    setStatus(
      "warn",
      "Bridge reachable, but it reports not paired",
      detail,
      "The token was accepted but the bridge says paired: false. Test again; if it persists, check `paseo plugin logs send-to-paseo`.",
    );
    return;
  }

  setStatus("ok", "Paired with Paseo", detail, "Open a Graphite PR and click Send to Paseo.");
}

/* -------------------------------------------------------------------------- */

async function load(): Promise<void> {
  const s = await readSettings();
  bridgeUrl.value = s.bridgeUrl;
  token.value = s.token;

  renderProviders(await cachedProviders(), s.defaultProvider);
  await refreshGrantRow();

  // With a token present, refresh providers (and the pairing verdict) straight
  // away — that is the whole point of ping taking optional auth.
  if (s.token) await testConnection({ flush: false });
}

function wireAutosaveInput(input: HTMLInputElement, key: "bridgeUrl" | "token"): void {
  let t: number | undefined;
  input.addEventListener("input", () => {
    if (t) clearTimeout(t);
    t = setTimeout(async () => {
      await writeSettings({ [key]: input.value } as never);
      flashSaved();
      if (key === "bridgeUrl") await refreshGrantRow();
    }, 250) as unknown as number;
  });
}

wireAutosaveInput(bridgeUrl, "bridgeUrl");
wireAutosaveInput(token, "token");

defaultProvider.addEventListener("change", async () => {
  await writeSettings({ defaultProvider: defaultProvider.value });
  flashSaved();
});

revealBtn.addEventListener("click", () => {
  const showing = token.type === "text";
  token.type = showing ? "password" : "text";
  revealBtn.textContent = showing ? "Show" : "Hide";
});

clearBtn.addEventListener("click", async () => {
  token.value = "";
  await writeSettings({ token: "" });
  flashSaved();
  setStatus("idle", "Token cleared", "The extension is no longer paired.");
});

testBtn.addEventListener("click", () => void testConnection());

void load();
