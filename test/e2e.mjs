#!/usr/bin/env node
/**
 * End-to-end tests: the real unpacked MV3 extension, loaded into a real
 * Chromium, against the mock bridge and the captured Graphite fixtures.
 *
 * Nothing here is stubbed inside the browser: the content script, the service
 * worker, chrome.storage, shadow DOM and the HTTP hop are all genuine. The only
 * fake is the bridge itself (test/mock-bridge.mjs), which is a faithful
 * implementation of CONTRACT.md.
 *
 * Run: node test/e2e.mjs [--keep-open] [--headed-pause]
 *
 * Screenshots land in docs/screenshots/. Results are printed and also written to
 * test/.last-run.json for transcription into extension/VERIFICATION.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";

import { createMockBridge, DEFAULT_TOKEN } from "./mock-bridge.mjs";
import { createFixtureServer } from "./fixture-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const extDir = join(repo, "extension");

// playwright-core is a devDependency of extension/, and this file lives in
// test/, so resolve it explicitly rather than relying on directory walking.
const { chromium } = createRequire(join(extDir, "package.json"))("playwright-core");
const distTest = join(extDir, "dist-test");
const shots = join(repo, "docs", "screenshots");

const FIXTURE_PORT = 4173;
// The real Paseo plugin listens on 7788, so the mock bridge uses a distinct
// port and the TEST build adds a matching host_permissions entry. The shipping
// manifest keeps only http://127.0.0.1:7788/*.
const BRIDGE_PORT = Number(process.env.STP_TEST_BRIDGE_PORT ?? 7799);
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

/* -------------------------------------------------------------------------- */
/* tiny test harness                                                          */
/* -------------------------------------------------------------------------- */

const results = [];
let currentName = null;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Stable stringify: object key order must not affect an equality assertion. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function assertEq(actual, expected, message) {
  const a = stable(actual);
  const e = stable(expected);
  if (a !== e) {
    throw new Error(
      `${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}

async function test(name, fn) {
  currentName = name;
  const started = Date.now();
  process.stdout.write(`\n── ${name}\n`);
  try {
    const notes = (await fn()) ?? [];
    results.push({ name, ok: true, ms: Date.now() - started, notes: [].concat(notes) });
    console.log(`   PASS (${Date.now() - started}ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started, error: e.message });
    console.log(`   FAIL ${e.message}`);
  } finally {
    currentName = null;
  }
}

function note(...args) {
  console.log("   ·", ...args);
}

function skip(name, reason) {
  results.push({ name, skipped: true, reason });
  process.stdout.write(`\n── ${name}\n   SKIP ${reason}\n`);
}

/* -------------------------------------------------------------------------- */
/* chromium discovery                                                          */
/* -------------------------------------------------------------------------- */

function findChromium() {
  const base = join(homedir(), "Library", "Caches", "ms-playwright");
  const candidates = existsSync(base)
    ? readdirSync(base)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const dir of candidates) {
    for (const rel of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-linux/chrome",
    ]) {
      const p = join(base, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(
    `No cached Playwright Chromium found under ${base}. ` +
      `Install one, or set STP_CHROMIUM to an executable path.`,
  );
}

/* -------------------------------------------------------------------------- */
/* helpers against the mock bridge control surface                            */
/* -------------------------------------------------------------------------- */

async function control(path, body) {
  const res = await fetch(`${BRIDGE_URL}/__test/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const bridgeLog = () => control("log");
const bridgeReset = () => control("reset", {});
const forceFail = (code, once = false) => control("fail", { code, once });
const bridgeConfig = (patch) => control("config", patch);

async function lastRequest(path) {
  const log = await bridgeLog();
  for (let i = log.length - 1; i >= 0; i--) if (log[i].path === path) return log[i];
  return null;
}

/* -------------------------------------------------------------------------- */
/* helpers against the extension                                              */
/* -------------------------------------------------------------------------- */

/**
 * Write settings straight into the service worker's storage.
 *
 * Deliberately NOT via the options page: that page legitimately reads settings
 * and pings on load, so using it as a seeding harness raced with its own writes
 * and silently clobbered the seeded token. (That race is what caught the real
 * bug of the options page writing storage during a read-only load.)
 */
async function serviceWorker(context) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
    if (sw) return sw;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("extension service worker not available");
}

async function seedSettings(context, _extensionId, patch) {
  const settings = { bridgeUrl: BRIDGE_URL, token: DEFAULT_TOKEN, defaultProvider: "", ...patch };
  const sw = await serviceWorker(context);
  const written = await sw.evaluate(async (s) => {
    await chrome.storage.local.set({ settings: s });
    return (await chrome.storage.local.get("settings")).settings;
  }, settings);
  // Read back: a seeding helper that silently no-ops would invalidate every test
  // that depends on it.
  assertEq(written, settings, "seedSettings must land exactly what it wrote");
  return written;
}

async function readStoredSettings(context) {
  const sw = await serviceWorker(context);
  return sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
}

async function clearCachedProviders(context) {
  const sw = await serviceWorker(context);
  await sw.evaluate(async () => chrome.storage.local.remove("lastProviders"));
}

const BUTTON = "send-to-paseo-button";
const POPOVER = "send-to-paseo-popover";

async function waitForButton(page, timeout = 12000) {
  await page.waitForSelector(BUTTON, { state: "attached", timeout });
  return page.locator(BUTTON);
}

async function openPopover(page) {
  await page.locator("[data-stp-button]").click();
  await page.waitForSelector(POPOVER, { state: "attached", timeout: 5000 });
}

async function waitForPhase(page, phase, timeout = 15000) {
  await page.waitForFunction(
    ([sel, want]) => document.querySelector(sel)?.getAttribute("data-stp-phase") === want,
    [POPOVER, phase],
    { timeout },
  );
}

/* ---- the Target combobox (non-native, searchable) ----------------------- */
/*
 * The Target picker is a custom combobox, not a <select> (see
 * extension/src/content/ui/combobox.ts), so every helper below drives the real
 * widget: click the trigger, type into the search box with real keystrokes,
 * click or arrow-and-Enter a row. Nothing here assigns `.value` or dispatches a
 * synthetic `change`, which is the point — a shim would let the widget be
 * broken and the suite still be green. `setSelect()` further down does exactly
 * that, but only for Provider and Mode, which remain native selects.
 *
 * Stable hooks: `data-stp-candidates` (trigger; its textContent is the
 * committed option's label), `data-stp-combobox[data-stp-combo-open]`,
 * `data-stp-combo-search`, `data-stp-combo-list`, `data-stp-combo-option`
 * (with `data-stp-index` = the candidate index and `data-stp-active`),
 * `data-stp-combo-empty`.
 */

const CANDIDATES = "[data-stp-candidates]";

async function candidatesOpen(page) {
  return page.evaluate(() => {
    const root = document
      .querySelector("send-to-paseo-popover")
      ?.shadowRoot?.querySelector("[data-stp-combobox]");
    return root?.getAttribute("data-stp-combo-open") === "true";
  });
}

/** Open the dropdown if it is closed. Returns the search input locator. */
async function openCandidates(page) {
  if (!(await candidatesOpen(page))) await page.locator(CANDIDATES).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("send-to-paseo-popover")
        ?.shadowRoot?.querySelector("[data-stp-combobox]")
        ?.getAttribute("data-stp-combo-open") === "true",
    undefined,
    { timeout: 4000 },
  );
  return page.locator("[data-stp-combo-search]");
}

async function closeCandidates(page) {
  if (await candidatesOpen(page)) await page.locator(CANDIDATES).click();
}

/**
 * Type a query with REAL keystrokes. Re-opens first so the query always starts
 * empty — opening resets it, which is also the behaviour under test.
 */
async function searchCandidates(page, query) {
  await closeCandidates(page);
  const input = await openCandidates(page);
  await page.keyboard.type(query, { delay: 5 });
  await page.waitForFunction(
    (q) =>
      document
        .querySelector("send-to-paseo-popover")
        ?.shadowRoot?.querySelector("[data-stp-combo-search]")?.value === q,
    query,
    { timeout: 4000 },
  );
  return input;
}

/** The dropdown's current state: rows, selection, active option, empty row. */
async function readCandidates(page, { close = true } = {}) {
  await openCandidates(page);
  const out = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    const rows = [...root.querySelectorAll("[data-stp-combo-option]")];
    const idx = rows.map((r) => Number(r.dataset.stpIndex));
    const input = root.querySelector("[data-stp-combo-search]");
    const selectedRow = rows.findIndex((r) => r.getAttribute("aria-selected") === "true");
    const activeRow = rows.findIndex((r) => r.hasAttribute("data-stp-active"));
    const list = root.querySelector("[data-stp-combo-list]");
    return {
      options: rows.map((r) => r.textContent),
      indices: idx,
      /** Candidate index carrying aria-selected, or -1 when it is filtered out. */
      selectedIndex: selectedRow === -1 ? -1 : idx[selectedRow],
      activeIndex: activeRow === -1 ? -1 : idx[activeRow],
      activeDescendant: input.getAttribute("aria-activedescendant"),
      activeRowId: activeRow === -1 ? null : rows[activeRow].id,
      emptyShown: !root.querySelector("[data-stp-combo-empty]").hasAttribute("hidden"),
      emptyText: root.querySelector("[data-stp-combo-empty]").textContent,
      trigger: root.querySelector("[data-stp-candidates]").textContent.trim(),
      triggerExpanded: root.querySelector("[data-stp-candidates]").getAttribute("aria-expanded"),
      inputRole: input.getAttribute("role"),
      inputControls: input.getAttribute("aria-controls"),
      listRole: list.getAttribute("role"),
      listId: list.id,
      optionRoles: [...new Set(rows.map((r) => r.getAttribute("role")))],
    };
  });
  if (close) await closeCandidates(page);
  return out;
}

/** The label showing on the closed trigger — i.e. the committed candidate. */
async function candidateTrigger(page) {
  return page.evaluate(() =>
    document
      .querySelector("send-to-paseo-popover")
      .shadowRoot.querySelector("[data-stp-candidates]")
      .textContent.trim(),
  );
}

/**
 * Commit candidate `index` by driving the widget: open, click the row, then
 * wait until the trigger really shows that row's label. Waiting on the label
 * rather than on "the dropdown closed" is what stops this passing vacuously.
 */
async function pickCandidate(page, index) {
  await openCandidates(page);
  const row = page.locator(`[data-stp-combo-option][data-stp-index="${index}"]`);
  await row.waitFor({ state: "visible", timeout: 4000 });
  const label = (await row.textContent()).trim();
  await row.click();
  await page.waitForFunction(
    (want) =>
      document
        .querySelector("send-to-paseo-popover")
        .shadowRoot.querySelector("[data-stp-candidates]")
        .textContent.trim() === want,
    label,
    { timeout: 4000 },
  );
  return label;
}

/** Region that contains the Graphite header plus the anchored popover. */
const POPOVER_CLIP = { x: 0, y: 0, width: 1280, height: 520 };

async function shot(page, name, clip) {
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`), ...(clip ? { clip } : {}) });
  note(`screenshot docs/screenshots/${name}.png`);
}

async function shotOf(locator, page, name) {
  mkdirSync(shots, { recursive: true });
  try {
    await locator.screenshot({ path: join(shots, `${name}.png`) });
    note(`screenshot docs/screenshots/${name}.png`);
  } catch {
    await shot(page, name);
  }
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

const keepOpen = process.argv.includes("--keep-open");

console.log("=== send-to-paseo extension e2e ===");

/* 1. regenerate the rotated fixture and build the test bundle -------------- */
execFileSync(process.execPath, [join(here, "fixtures", "rotate.mjs")], { stdio: "pipe" });
console.log("· regenerated graphite-pr-rotated.html");
execFileSync(
  process.execPath,
  [join(extDir, "build.mjs"), "--test", "--port", String(FIXTURE_PORT), "--bridge-port", String(BRIDGE_PORT)],
  {
    stdio: "pipe",
    cwd: extDir,
  },
);
console.log(`· built test bundle -> ${distTest}`);
execFileSync(process.execPath, [join(extDir, "build.mjs")], { stdio: "pipe", cwd: extDir });
console.log(`· built shipping bundle -> ${join(extDir, "dist")} (for hygiene assertions)`);

/* 2. servers --------------------------------------------------------------- */
let bridge = createMockBridge({ port: BRIDGE_PORT, token: DEFAULT_TOKEN, quiet: true });
await bridge.listen();
console.log(`· mock bridge on ${BRIDGE_URL}`);

const fixtures = createFixtureServer({ port: FIXTURE_PORT });
await fixtures.listen();
console.log(`· fixture server on http://localhost:${FIXTURE_PORT}`);

/* 3. browser --------------------------------------------------------------- */
const executablePath = process.env.STP_CHROMIUM ?? findChromium();
console.log(`· chromium: ${executablePath}`);
console.log(
  process.env.STP_HEADED === "1"
    ? "· mode: headed (STP_HEADED=1)"
    : "· mode: headless — set STP_HEADED=1 to watch the run",
);

const profile = join(here, ".chrome-profile");
rmSync(profile, { recursive: true, force: true });

// MV3 extensions require a persistent context. They also used to require a
// headed browser — Chrome's OLD headless was a separate binary with no
// extension support. Chrome's `--headless=new` runs the real browser and does
// load MV3 extensions, so the suite runs headless by default and stops stealing
// focus. Set STP_HEADED=1 to watch it (or to debug a failure interactively).
const headed = process.env.STP_HEADED === "1";
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: !headed,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${distTest}`,
    `--load-extension=${distTest}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DialMediaRouteProvider",
  ],
});

async function extensionId() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
    if (sw) return new URL(sw.url()).host;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("extension service worker never appeared");
}

const extId = await extensionId();
console.log(`· extension id: ${extId}`);

const consoleErrors = [];
context.on("weberror", (e) => consoleErrors.push(String(e.error())));

/* -------------------------------------------------------------------------- */
/* tests                                                                       */
/* -------------------------------------------------------------------------- */

await seedSettings(context, extId, {});
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

/* ---- 1. injection into the header action row ----------------------------- */
await test("1. Button injects into the header action row (normal fixture)", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);

  const info = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const next = host.nextElementSibling;
    return {
      mode: host.getAttribute("data-stp-mode"),
      pr: host.getAttribute("data-stp-pr"),
      marker: host.getAttribute("data-send-to-paseo"),
      style: host.getAttribute("data-stp-style"),
      insideHeader: Boolean(host.closest('[class*="PullRequestPageHeader_prPageHeader"]')),
      nextTag: next?.tagName ?? null,
      nextText: next?.textContent?.trim() ?? null,
      nextClass: next?.className ?? null,
      siblingButtons: host.parentElement
        ? [...host.parentElement.children].filter((c) => c.tagName === "BUTTON").length
        : 0,
      hasShadow: Boolean(host.shadowRoot),
      shadowButtonText: host.shadowRoot?.querySelector("button")?.textContent?.trim() ?? null,
      count: document.querySelectorAll(sel).length,
    };
  }, BUTTON);

  assertEq(info.marker, "button", "marker attribute must be present");
  assertEq(info.mode, "anchored", "expected the primary (header) anchor rung");
  assertEq(info.style, "graphite", "styleHint() must reach the button host");
  assertEq(info.pr, "942", "button must carry the PR number from the URL");
  assert(info.insideHeader, "button must live inside PullRequestPageHeader_prPageHeader");
  assert(info.nextText?.includes("Review Changes"), `expected to sit before Review Changes, next sibling was ${info.nextText}`);
  assert(info.nextClass?.includes("ReviewChangesAction_"), "next sibling should be Graphite's Review Changes button");
  assert(info.hasShadow, "button must render inside a shadow root");
  assertEq(info.shadowButtonText, "Send to Paseo", "shadow button label");
  assertEq(info.count, 1, "exactly one button host");

  note(`anchor: before ${info.nextClass}`);

  const header = page.locator('[class*="PullRequestPageHeader_prPageHeader"]');
  await shotOf(header, page, "injected-button-light");

  await page.emulateMedia({ colorScheme: "dark" });
  await shotOf(header, page, "injected-button-dark");
  await page.emulateMedia({ colorScheme: "light" });

  return [`sits before ${info.nextClass}`, `${info.siblingButtons} sibling buttons in the row`];
});

/* ---- 2. idempotency under a noisy observer ------------------------------- */
await test("2a. Injection is idempotent under DOM churn", async () => {
  const before = await page.evaluate((sel) => document.querySelectorAll(sel).length, BUTTON);
  await page.evaluate(() => {
    const row = document.querySelector('[class*="PullRequestPageHeader_prPageHeader"]');
    for (let i = 0; i < 30; i++) {
      const junk = document.createElement("span");
      junk.textContent = `churn-${i}`;
      row.appendChild(junk);
      junk.remove();
    }
  });
  await new Promise((r) => setTimeout(r, 700));
  const after = await page.evaluate((sel) => document.querySelectorAll(sel).length, BUTTON);
  assertEq([before, after], [1, 1], "mutation churn must not duplicate the button");
  return "30 mutation bursts -> still exactly 1 button host";
});

/* ---- 2. hash-rotated fixture -------------------------------------------- */
await test("2. Button still injects on the hash-rotated fixture", async () => {
  const normalHash = /PullRequestPageHeader_prPageHeader__(\w+)/.exec(
    readFileSync(join(here, "fixtures", "graphite-pr.html"), "utf8"),
  )[1];
  const rotatedHash = /PullRequestPageHeader_prPageHeader__(\w+)/.exec(
    readFileSync(join(here, "fixtures", "graphite-pr-rotated.html"), "utf8"),
  )[1];
  assert(normalHash !== rotatedHash, "the rotated fixture must actually have different hashes");
  note(`header hash ${normalHash} -> ${rotatedHash}`);

  await page.goto(fixtures.url({ fixture: "rotated" }), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  const info = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    return {
      mode: host.getAttribute("data-stp-mode"),
      insideHeader: Boolean(host.closest('[class*="PullRequestPageHeader_prPageHeader"]')),
      headerClass: host.closest('[class*="PullRequestPageHeader_prPageHeader"]')?.className ?? null,
      nextText: host.nextElementSibling?.textContent?.trim() ?? null,
    };
  }, BUTTON);

  assertEq(info.mode, "anchored", "rotated fixture must still hit the primary rung");
  assert(info.insideHeader, "must still find the header after hash rotation");
  assert(info.nextText?.includes("Review Changes"), "must still land before Review Changes");
  assert(
    info.headerClass.includes(rotatedHash),
    `sanity: the matched header should carry the NEW hash (${rotatedHash}), got ${info.headerClass}`,
  );

  await shotOf(
    page.locator('[class*="PullRequestPageHeader_prPageHeader"]'),
    page,
    "injected-button-hash-rotated",
  );
  return [`matched header with rotated hash __${rotatedHash}`, "still inserted before Review Changes"];
});

/* ---- 3. floating fallback ----------------------------------------------- */
await test("3. Floating fallback appears when no anchor exists", async () => {
  await page.goto(fixtures.url({ fixture: "no-anchor" }), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  const info = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const cs = getComputedStyle(host);
    return {
      mode: host.getAttribute("data-stp-mode"),
      floating: host.getAttribute("data-stp-floating"),
      parentIsBody: host.parentElement === document.body,
      position: cs.position,
      right: cs.right,
      bottom: cs.bottom,
      noHeader: document.querySelectorAll('[class*="PullRequestPageHeader_prPageHeader"]').length,
      noInfoGroup: document.querySelectorAll('[class*="MetadataSection_prInfoGroup"]').length,
      pr: host.getAttribute("data-stp-pr"),
    };
  }, BUTTON);

  assertEq([info.noHeader, info.noInfoGroup], [0, 0], "fixture must genuinely lack both anchors");
  assertEq(info.mode, "floating", "expected the floating fallback mode");
  assertEq(info.floating, "true", "floating attribute");
  assert(info.parentIsBody, "floating button attaches to <body>");
  assertEq(info.position, "fixed", "floating button must be position:fixed");
  assertEq(info.pr, "942", "still parses the PR from the URL");

  await shot(page, "floating-fallback");
  return [`position:${info.position} right:${info.right} bottom:${info.bottom}`];
});

/* ---- 4 + 5. popover, resolve, candidates, stack scrape ------------------- */
await test("4. Popover opens, calls /v1/resolve, renders target + candidates", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  const ui = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    const trigger = root.querySelector("[data-stp-candidates]");
    return {
      summary: root.querySelector("[data-stp-target-summary]").textContent.replace(/\s+/g, " ").trim(),
      prref: root.querySelector("[data-stp-prref]").textContent.trim(),
      // The Target picker is a custom combobox: closed it is a trigger button
      // showing the committed label, and it owns no <option> nodes at all.
      trigger: trigger.textContent.trim(),
      triggerTag: trigger.tagName.toLowerCase(),
      triggerPopup: trigger.getAttribute("aria-haspopup"),
      triggerExpanded: trigger.getAttribute("aria-expanded"),
      nativeSelects: [...root.querySelectorAll("select")].map((el) =>
        el.getAttribute("data-stp-provider") !== null
          ? "provider"
          : el.getAttribute("data-stp-mode") !== null
            ? "mode"
            : el.outerHTML.slice(0, 40),
      ),
      panelHidden: root.querySelector("[data-stp-combo-panel]").hasAttribute("hidden"),
      optionsWhileClosed: root.querySelectorAll("[data-stp-combo-option]").length,
      providers: [...root.querySelector("[data-stp-provider]").options].map((o) => o.textContent),
      providerValue: root.querySelector("[data-stp-provider]").value,
      promptFocused: root.activeElement?.getAttribute("data-stp-prompt") !== null,
      sendDisabled: root.querySelector("[data-stp-send]").disabled,
    };
  });

  const req = await lastRequest("/v1/resolve");
  assert(req, "the popover must call POST /v1/resolve on open");
  assertEq(req.method, "POST", "resolve method");
  assert(req.hasAuth, "resolve must be authenticated by the service worker");
  assertEq(req.body.forge, "github", "forge");
  assertEq(req.body.owner, "acmegizmos", "owner from URL");
  assertEq(req.body.repo, "gizmo-poc", "repo from URL");
  assertEq(req.body.number, 942, "number from URL");
  assert(req.origin?.startsWith("chrome-extension://") || req.origin === null,
    `origin must be a chrome-extension origin or absent, got ${req.origin}`);

  assert(ui.summary.includes("brawny-dodo"), `summary should name the rank-1 workspace, got: ${ui.summary}`);
  assert(ui.summary.includes("giz-1133-widget-backed-inventory-audit-rule"), "summary should show the branch");
  assertEq(ui.prref, "acmegizmos/gizmo-poc #942", "header PR reference");

  /* The Target picker is non-native. Closed, it is a button — no <select>, no
     <option>, nothing for the OS to draw — and Provider/Mode are still the two
     native selects on the card. */
  assertEq(ui.triggerTag, "button", "the Target trigger must not be a <select>");
  assertEq(ui.triggerPopup, "listbox", "trigger must advertise its popup");
  assertEq(ui.triggerExpanded, "false", "trigger starts collapsed");
  assertEq(ui.nativeSelects, ["provider", "mode"], "the only native selects left are Provider and Mode");
  assert(ui.panelHidden, "the dropdown panel is hidden until opened");
  assertEq(ui.optionsWhileClosed, 0, "no option rows exist while the dropdown is closed");
  assert(ui.trigger.includes("brawny-dodo"), `trigger shows the committed candidate: ${ui.trigger}`);

  /* Open it and read the real rows. */
  const cands = await readCandidates(page, { close: false });
  assertEq(cands.options.length, 4, "expected 4 candidates (exact, stack, project, create)");
  assert(cands.options[0].includes("brawny-dodo") && cands.options[0].includes("exact match"), `option 0: ${cands.options[0]}`);
  assert(cands.options[1].includes("stack #949"), `option 1 should be the rank-2 stack entry, got: ${cands.options[1]}`);
  assert(cands.options[3].includes("Create worktree for PR #942"), `option 3: ${cands.options[3]}`);
  assertEq(cands.selectedIndex, 0, "defaultCandidateIndex must be honoured");
  assertEq(cands.activeIndex, 0, "the dropdown opens on the committed option, not on the top row");
  /* ARIA wiring, since nothing native supplies it here. */
  assertEq(cands.inputRole, "combobox", "the search input carries role=combobox");
  assertEq(cands.listRole, "listbox", "the popup is a listbox");
  assertEq(cands.optionRoles, ["option"], "every row is role=option");
  assertEq(cands.inputControls, cands.listId, "aria-controls must point at the listbox");
  assertEq(cands.activeDescendant, cands.activeRowId, "aria-activedescendant must name the active row");
  assertEq(cands.triggerExpanded, "true", "aria-expanded flips when open");
  await shot(page, "popover-candidate-combobox-open-light", POPOVER_CLIP);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "popover-candidate-combobox-open-dark", POPOVER_CLIP);
  await page.emulateMedia({ colorScheme: "light" });
  await closeCandidates(page);

  assertEq(ui.providers.length, 3, "provider list from resolve");
  assert(ui.providers[0].includes("(default)"), "the default provider is marked");
  assertEq(ui.providerValue, "claude/claude-opus-5", "provider pre-set to the bridge default");
  assert(ui.promptFocused, "textarea must be autofocused");
  assert(ui.sendDisabled, "Send is disabled until something is typed");

  // Footer keycaps: symbol-only caps are optically size-matched to lettered ones.
  const keys = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    return [...root.querySelectorAll("footer kbd")].map((k) => ({
      text: k.textContent,
      sym: k.classList.contains("sym"),
      px: Number.parseFloat(getComputedStyle(k).fontSize),
    }));
  });
  const symKeys = keys.filter((k) => k.sym);
  const wordKeys = keys.filter((k) => !k.sym);
  assert(symKeys.length >= 1, `expected symbol keycaps, got ${JSON.stringify(keys)}`);
  assert(wordKeys.some((k) => k.text === "Esc"), "Esc should be a lettered keycap");
  for (const k of symKeys) {
    assert(
      k.px > Math.max(...wordKeys.map((w) => w.px)),
      `symbol keycap "${k.text}" (${k.px}px) must render larger than lettered caps to look even`,
    );
  }
  note(`keycaps: ${keys.map((k) => `${k.text}${k.sym ? "(sym)" : ""}=${k.px}px`).join(" ")}`);

  note(`resolve origin: ${req.origin}`);
  await shot(page, "popover-open-candidates-light", POPOVER_CLIP);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "popover-open-candidates-dark", POPOVER_CLIP);
  await page.emulateMedia({ colorScheme: "light" });

  // Candidate dropdown genuinely switches the summary — driven through the real
  // widget (open, click the row), not by assigning a value.
  await pickCandidate(page, 3);
  const createSummary = await page.evaluate(() =>
    document
      .querySelector("send-to-paseo-popover")
      .shadowRoot.querySelector("[data-stp-target-summary]")
      .textContent.replace(/\s+/g, " ")
      .trim(),
  );
  assert(
    createSummary.includes("will create worktree for PR #942"),
    `picking the create candidate must update the summary, got: ${createSummary}`,
  );
  await shot(page, "popover-candidate-create-selected", POPOVER_CLIP);

  return [
    `POST /v1/resolve body: ${JSON.stringify(req.body)}`,
    `candidates: ${cands.options.join(" | ")}`,
    `summary: ${ui.summary}`,
    `footer keycaps: ${keys.map((k) => `${k.text}=${k.px}px`).join(" ")}`,
  ];
});

await test("5. Stack PR numbers scraped from hrefs, current PR (942) excluded", async () => {
  const req = await lastRequest("/v1/resolve");
  assert(req, "need a resolve request");
  const stack = req.body.stackPrNumbers;
  assert(Array.isArray(stack), "stackPrNumbers must be an array");
  assertEq(stack, [949, 948, 947, 946, 945, 943, 941], "exact stack list from the fixture hrefs");
  assert(!stack.includes(942), "the current PR must be filtered out");

  // The fixture really does contain a link to 942 — otherwise this proves nothing.
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('a[href^="/github/pr/acmegizmos/gizmo-poc/"]')].map((a) =>
      a.getAttribute("href"),
    ),
  );
  assertEq(hrefs.length, 8, "fixture should expose 8 stack links (including self)");
  assert(hrefs.some((h) => h.includes("/942/")), "fixture must include a self link for this test to mean anything");

  return [
    `page hrefs (${hrefs.length}): includes /942/ = true`,
    `sent stackPrNumbers: ${JSON.stringify(stack)}`,
    "belt and braces: the bridge also tolerates+filters a self-inclusive list (asserted in test 12)",
  ];
});

/* ---- 6. send ------------------------------------------------------------ */
await test("6. Send posts a correctly-shaped /v1/send body; success shows the deep link", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  const prompt = "Fix merge conflicts with graphite-base/942";
  await page.locator("[data-stp-prompt]").fill(prompt);
  await shot(page, "popover-text-typed", POPOVER_CLIP);

  await page.locator("[data-stp-send]").click();
  await waitForPhase(page, "sent");

  const req = await lastRequest("/v1/send");
  assert(req, "expected a POST /v1/send");
  assert(req.hasAuth, "send must carry the bearer token (added by the service worker)");
  assertEq(req.body.forge, "github", "forge");
  assertEq(req.body.owner, "acmegizmos", "owner");
  assertEq(req.body.repo, "gizmo-poc", "repo");
  assertEq(req.body.number, 942, "number");
  assertEq(req.body.prompt, prompt, "prompt is passed through verbatim");
  assertEq(req.body.target, { kind: "existing", workspaceId: "wks_4d1a8b7c2e0f9351" }, "target");
  assertEq(req.body.provider, "claude/claude-opus-5", "provider");
  // The bridge's resolvedModeId, preselected and sent back verbatim.
  assertEq(req.body.modeId, "auto", "modeId");
  assert(
    req.body.pageUrl?.includes("/github/pr/acmegizmos/gizmo-poc/942/"),
    `pageUrl should be the Graphite page URL, got ${req.body.pageUrl}`,
  );
  assertEq(Object.keys(req.body).sort(), ["forge", "modeId", "number", "owner", "pageUrl", "prompt", "provider", "repo", "target"], "send body keys");

  const ui = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    const link = root.querySelector("[data-stp-deeplink]");
    return {
      success: root.querySelector("[data-stp-success]").textContent.trim(),
      dryRunAttr: document.querySelector("send-to-paseo-popover").getAttribute("data-stp-dryrun"),
      badge: root.querySelector("[data-stp-dryrun]")?.textContent ?? null,
      linkText: link.textContent.trim(),
      href: link.getAttribute("href"),
      detail: root.querySelector(".sdetail").textContent.replace(/\s+/g, " ").trim(),
    };
  });

  assertEq(ui.success, "Agent started", "success headline");
  assertEq(ui.dryRunAttr, "false", "a real send must be marked dryRun=false at the host level");
  assertEq(ui.badge, null, "no DRY RUN badge on a real send");
  assertEq(ui.linkText, "Open in Paseo", "deep link label");
  // deepLink is opaque; assert the documented SHAPE, never an exact string.
  assert(
    /^paseo:\/\/h\/[^/]+\/agent\/[^/]+$/.test(ui.href),
    `deep link must match paseo://h/<serverId>/agent/<agentId>, got: ${ui.href}`,
  );
  assert(ui.detail.includes("PR #942"), `success detail should name the PR, got: ${ui.detail}`);

  note(`deepLink: ${ui.href}`);
  await shot(page, "popover-success-deep-link", POPOVER_CLIP);
  return [
    `POST /v1/send body: ${JSON.stringify(req.body)}`,
    `deepLink rendered: ${ui.href} (matches paseo://h/<serverId>/agent/<agentId>)`,
  ];
});

/* ---- 7. keyboard ------------------------------------------------------- */
await test("7. Cmd/Ctrl+Enter sends; Esc closes", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);

  /* Esc */
  await openPopover(page);
  await waitForPhase(page, "ready");
  await page.keyboard.press("Escape");
  await page.waitForSelector(POPOVER, { state: "detached", timeout: 4000 });
  const gone = await page.evaluate((sel) => document.querySelectorAll(sel).length, POPOVER);
  assertEq(gone, 0, "Escape must remove the popover from the DOM");
  const expanded = await page.evaluate(
    () => document.querySelector("send-to-paseo-button").shadowRoot.querySelector("button").getAttribute("aria-expanded"),
  );
  assertEq(expanded, "false", "aria-expanded resets when the popover closes");
  note("Esc closed the popover and reset aria-expanded");

  /* Cmd+Enter */
  await openPopover(page);
  await waitForPhase(page, "ready");
  await page.locator("[data-stp-prompt]").fill("Rebase onto main");
  const combo = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
  await page.locator("[data-stp-prompt]").press(combo);
  await waitForPhase(page, "sent", 8000);
  const req = await lastRequest("/v1/send");
  assertEq(req.body.prompt, "Rebase onto main", `${combo} must submit the typed prompt`);
  note(`${combo} sent the prompt`);
  return [`Esc detached the popover`, `${combo} produced POST /v1/send with the typed prompt`];
});

/* ---- 8. SPA navigation re-targets ------------------------------------- */
await test("8. SPA navigation to another PR re-targets the button", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  assertEq(
    await page.evaluate((s) => document.querySelector(s).getAttribute("data-stp-pr"), BUTTON),
    "942",
    "starts on 942",
  );

  // Client-side navigation, exactly as Graphite's router does it — from the
  // page's MAIN world. This is why the extension patches history there and not
  // in the isolated content-script world.
  await page.evaluate(() => {
    history.pushState({}, "", "/github/pr/acmegizmos/gizmo-poc/948/GIZ-1132-extract-widget-status-seam");
  });

  await page.waitForFunction(
    (s) => document.querySelector(s)?.getAttribute("data-stp-pr") === "948",
    BUTTON,
    { timeout: 6000 },
  );
  const info = await page.evaluate((s) => {
    const hosts = document.querySelectorAll(s);
    return {
      count: hosts.length,
      pr: hosts[0]?.getAttribute("data-stp-pr"),
      mode: hosts[0]?.getAttribute("data-stp-mode"),
      insideHeader: Boolean(hosts[0]?.closest('[class*="PullRequestPageHeader_prPageHeader"]')),
    };
  }, BUTTON);
  assertEq(info.count, 1, "exactly one button after navigation (no leak)");
  assertEq(info.pr, "948", "button re-targeted to the new PR");
  assertEq(info.mode, "anchored", "still anchored in the header");
  assert(info.insideHeader, "still inside the header");

  await openPopover(page);
  await waitForPhase(page, "ready");
  const req = await lastRequest("/v1/resolve");
  assertEq(req.body.number, 948, "the next /v1/resolve must use the NEW PR number");
  assert(!req.body.stackPrNumbers.includes(948), "self-filter must follow the new PR number");
  assert(req.body.stackPrNumbers.includes(942), "the previous PR is now a stack sibling");

  const ui = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    return {
      prref: root.querySelector("[data-stp-prref]").textContent.trim(),
      summary: root.querySelector("[data-stp-target-summary]").textContent.replace(/\s+/g, " ").trim(),
      // The closed combobox trigger shows the committed candidate's label.
      selected: root.querySelector("[data-stp-candidates]").textContent.trim(),
    };
  });
  assertEq(ui.prref, "acmegizmos/gizmo-poc #948", "popover header follows the new PR");
  // PR 948 has no exact workspace but does have stack siblings, so the default
  // is the stack workspace rather than "create". Test 20 covers that rule.
  assert(
    ui.summary.includes("workspace candid-otter"),
    `PR 948 has no exact workspace but is in a stack, so the default is the stack workspace: ${ui.summary}`,
  );
  await shot(page, "popover-after-spa-nav-948-stack-default", POPOVER_CLIP);

  return [
    `stackPrNumbers for 948: ${JSON.stringify(req.body.stackPrNumbers)}`,
    `default candidate: ${ui.selected}`,
  ];
});

/* ---- 9. error paths ---------------------------------------------------- */
await test("9a. Error path: bridge down -> bridge_unreachable", async () => {
  await bridge.close();
  try {
    await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
    await waitForButton(page);
    await openPopover(page);
    await waitForPhase(page, "error", 20000);
    const ui = await readError(page);
    assertEq(ui.code, "bridge_unreachable", "expected the local bridge_unreachable code");
    assert(ui.title.includes("Can't reach the Paseo bridge"), `title: ${ui.title}`);
    assert(ui.hint.includes("send-to-paseo plugin is running"), `hint: ${ui.hint}`);
    assert(ui.hasOptionsLink, "bridge_unreachable should offer the options link");
    await shot(page, "error-bridge-down", POPOVER_CLIP);
    return [`code=${ui.code}`, `title=${ui.title}`, `hint=${ui.hint}`];
  } finally {
    bridge = createMockBridge({ port: BRIDGE_PORT, token: DEFAULT_TOKEN, quiet: true });
    await bridge.listen();
  }
});

async function readError(p) {
  return p.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    const box = root.querySelector("[data-stp-error]");
    return {
      code: box.getAttribute("data-stp-error"),
      title: root.querySelector("[data-stp-error-title]").textContent.trim(),
      message: box.querySelector(".emsg")?.textContent.trim() ?? "",
      hint: root.querySelector("[data-stp-error-hint]").textContent.trim(),
      hasOptionsLink: Boolean(root.querySelector("[data-stp-open-options]")),
      bare: /^failed$/i.test(root.querySelector("[data-stp-error-title]").textContent.trim()),
    };
  });
}

await test("9b. Error path: unauthorized -> 'Not paired with Paseo' + options link", async () => {
  await bridgeReset();
  await seedSettings(context, extId, { token: "definitely-the-wrong-token" });
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "error");
  const ui = await readError(page);
  assertEq(ui.code, "unauthorized", "code");
  assertEq(ui.title, "Not paired with Paseo", "title");
  assert(ui.hasOptionsLink, "must link to the options page");
  assert(!ui.bare, "never a bare 'failed'");
  // With ping's auth now optional, a bad token is caught by the contract/auth
  // preflight — so /v1/resolve is never attempted at all.
  const pingReq = await lastRequest("/v1/ping");
  assert(pingReq, "the preflight ping must have been attempted");
  assertEq(pingReq.authState, "bad", "the bridge saw a present-but-wrong token on ping");
  const log = await bridgeLog();
  assertEq(
    log.filter((r) => r.path === "/v1/resolve").length,
    0,
    "a rejected token must short-circuit before /v1/resolve",
  );
  await shot(page, "error-unauthorized", POPOVER_CLIP);
  await seedSettings(context, extId, {});
  return [
    `code=${ui.code}`,
    `title=${ui.title}`,
    "caught by the ping preflight; /v1/resolve never attempted",
  ];
});

await test("9c. Error path: project_not_found names the repo", async () => {
  await bridgeReset();
  await forceFail("project_not_found");
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "error");
  const ui = await readError(page);
  assertEq(ui.code, "project_not_found", "code");
  assertEq(ui.title, "This repo isn't a Paseo project", "title");
  assert(ui.message.includes("gizmo-poc"), `message must name the repo, got: ${ui.message}`);
  assert(ui.hint.includes("Add the repository as a project"), `hint: ${ui.hint}`);
  await shot(page, "error-project-not-found", POPOVER_CLIP);
  await forceFail(null);
  return [`code=${ui.code}`, `message=${ui.message}`, `hint=${ui.hint}`];
});

await test("9d. Error path: forge_unauthenticated hints `gh auth login`", async () => {
  await bridgeReset();
  await forceFail("forge_unauthenticated");
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "error");
  const ui = await readError(page);
  assertEq(ui.code, "forge_unauthenticated", "code");
  assertEq(ui.title, "GitHub CLI isn't authenticated", "title");
  assert(/gh auth login/.test(ui.hint), `hint must contain the command, got: ${ui.hint}`);
  const renderedCode = await page.evaluate(
    () =>
      document
        .querySelector("send-to-paseo-popover")
        .shadowRoot.querySelector("[data-stp-error-hint] code")?.textContent ?? null,
  );
  assertEq(renderedCode, "gh auth login", "backticked hint renders as a <code> element, not raw markup");
  await shot(page, "error-forge-unauthenticated", POPOVER_CLIP);
  await forceFail(null);
  return [`code=${ui.code}`, `hint=${ui.hint}`, "backticks rendered as <code>"];
});

await test("9e. Every CONTRACT.md error code renders a specific message", async () => {
  await bridgeReset();
  const codes = [
    "unauthorized",
    "forbidden_origin",
    "forbidden_host",
    "bad_request",
    "payload_too_large",
    "rate_limited",
    "project_not_found",
    "pr_not_found",
    "forge_unauthenticated",
    "workspace_create_failed",
    "agent_create_failed",
    "daemon_unreachable",
    "internal",
  ];
  const seen = [];
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);

  for (const code of codes) {
    await forceFail(code);
    // Fresh popover per code.
    await page.evaluate(() => document.querySelector("send-to-paseo-popover")?.remove());
    await openPopover(page);
    await waitForPhase(page, "error", 10000);
    const ui = await readError(page);
    assertEq(ui.code, code, `rendered code for ${code}`);
    assert(ui.title.length > 3 && !/^(failed|error)$/i.test(ui.title), `${code} needs a real title, got "${ui.title}"`);
    assert(ui.hint.length > 3, `${code} needs an actionable hint, got "${ui.hint}"`);
    seen.push(`${code} -> "${ui.title}" / "${ui.hint}"`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(POPOVER, { state: "detached", timeout: 4000 });
    // Stay under the bridge's 60 req / 10 s limit (CONTRACT.md item 6): this loop
    // walks every error code, and the contract gate spends 2 requests per open.
    await bridgeReset();
  }
  await forceFail(null);
  for (const line of seen) note(line);
  return seen;
});

await test("9f. First-run path: no token stored -> not_configured, no request sent", async () => {
  await bridgeReset();
  await seedSettings(context, extId, { token: "" });
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "error");
  const ui = await readError(page);
  assertEq(ui.code, "not_configured", "code");
  assertEq(ui.title, "Not paired with Paseo", "title");
  assert(ui.hasOptionsLink, "must link to the options page");
  const log = await bridgeLog();
  assertEq(
    log.filter((r) => r.path === "/v1/resolve").length,
    0,
    "with no token the extension must not send an unauthenticated request at all",
  );
  await shot(page, "error-not-paired", POPOVER_CLIP);
  await seedSettings(context, extId, {});
  return [`code=${ui.code}`, "no HTTP request is made when unpaired"];
});

/* ---- 10. options page: three Test-connection outcomes + providers ------- */

const optionsUrl = () => `chrome-extension://${extId}/options.html`;

async function readOptionsStatus(opt) {
  return opt.evaluate(() => ({
    tone: document.querySelector("#status").dataset.tone,
    title: document.querySelector("#status .st").textContent.trim(),
    detail: document.querySelector("#status .sd")?.textContent.trim() ?? "",
    hint: document.querySelector("#status .sh")?.textContent.trim() ?? "",
    providerOptions: [...document.querySelectorAll("#defaultProvider option")].map((o) => o.textContent),
    providerHelp: document.querySelector("#providerHelp").textContent.trim(),
  }));
}

async function runTestConnection(opt) {
  await opt.evaluate(() => {
    document.querySelector("#status").dataset.tone = "pending";
  });
  await opt.locator("#test").click();
  await opt.waitForFunction(
    () => {
      const t = document.querySelector("#status").dataset.tone;
      return t !== "pending" && t !== "idle";
    },
    null,
    { timeout: 20000 },
  );
  return readOptionsStatus(opt);
}

await test("10a. Options page: paired token -> ok, and providers come from /v1/ping", async () => {
  await bridgeReset();
  await seedSettings(context, extId, { token: DEFAULT_TOKEN, defaultProvider: "" });
  const opt = await context.newPage();
  await opt.goto(optionsUrl());
  const st = await runTestConnection(opt);

  assertEq(st.tone, "ok", `expected ok tone, got ${st.tone} / ${st.title}`);
  assertEq(st.title, "Paired with Paseo", "headline");
  assert(st.detail.includes("contract v1"), `detail must report the contract version: ${st.detail}`);
  assert(st.detail.includes("srv_"), `detail must report the daemon serverId: ${st.detail}`);
  assert(st.detail.includes("3 providers"), `detail must report the provider count: ${st.detail}`);

  // The picker is populated from ping — no <datalist> workaround any more.
  assertEq(st.providerOptions.length, 4, "placeholder + 3 providers");
  assertEq(st.providerOptions[0], "(use the plugin's default)", "placeholder option");
  assert(
    st.providerOptions[1].includes("Opus 5") && st.providerOptions[1].includes("(plugin default)"),
    `the bridge's isDefault provider must be marked: ${st.providerOptions[1]}`,
  );
  assert(st.providerHelp.includes("3 providers"), `provider help: ${st.providerHelp}`);

  // And selecting one persists.
  await opt.selectOption("#defaultProvider", "codex/gpt-5-codex");
  await opt.waitForTimeout(250);
  const stored = await readStoredSettings(context);
  assertEq(stored.defaultProvider, "codex/gpt-5-codex", "provider choice persists to storage");

  const pingReq = await lastRequest("/v1/ping");
  assertEq(pingReq.authState, "valid", "the options page pinged WITH the token");

  await opt.screenshot({ path: join(shots, "options-page-paired.png") });
  await opt.emulateMedia({ colorScheme: "dark" });
  await opt.screenshot({ path: join(shots, "options-page-dark.png") });
  await opt.emulateMedia({ colorScheme: "light" });
  await opt.close();
  await seedSettings(context, extId, {});
  note(`ok: ${st.title} — ${st.detail}`);
  return [
    `ok: ${st.title} — ${st.detail}`,
    `provider picker: ${st.providerOptions.join(" | ")}`,
    "authenticated ping (authState=valid) is what populated it",
  ];
});

await test("10b. Options page: no token -> warn 'not paired', empty provider list", async () => {
  await bridgeReset();
  await seedSettings(context, extId, { token: "", defaultProvider: "" });
  // Clear the cached provider list so this genuinely reflects an unpaired ping.
  await clearCachedProviders(context);

  const opt = await context.newPage();
  await opt.goto(optionsUrl());
  const st = await runTestConnection(opt);

  assertEq(st.tone, "warn", `expected warn tone, got ${st.tone} / ${st.title}`);
  assertEq(st.title, "Bridge reachable, not paired yet", "headline");
  assert(st.detail.includes("0 providers"), `unauthenticated ping returns no providers: ${st.detail}`);
  assertEq(st.providerOptions.length, 1, "provider picker holds only the placeholder");

  const pingReq = await lastRequest("/v1/ping");
  assertEq(pingReq.authState, "none", "with no token the page pings WITHOUT an Authorization header");
  assertEq(pingReq.body?.paired, undefined, "sanity: request log has no response fields");

  await opt.screenshot({ path: join(shots, "options-page-not-paired.png") });
  await opt.close();
  note(`warn: ${st.title} — ${st.detail}`);
  return [`warn: ${st.title} — ${st.detail}`, "ping sent with authState=none, providers: []"];
});

await test("10c. Options page: bad token -> bad 'Token rejected' (distinct from bridge down)", async () => {
  await bridgeReset();
  await seedSettings(context, extId, { token: "not-the-real-token" });
  const opt = await context.newPage();
  await opt.goto(optionsUrl());
  const st = await runTestConnection(opt);

  assertEq(st.tone, "bad", `expected bad tone, got ${st.tone}`);
  assertEq(st.title, "Token rejected", "headline must distinguish a bad token from an unreachable bridge");
  assert(
    st.hint.includes("copy it again") || st.hint.includes("Copy it again"),
    `hint should tell the user to re-copy the token: ${st.hint}`,
  );
  const pingReq = await lastRequest("/v1/ping");
  assertEq(pingReq.authState, "bad", "the bridge saw an invalid token and returned 401");

  await opt.screenshot({ path: join(shots, "options-page-token-rejected.png") });
  await opt.close();
  await seedSettings(context, extId, {});
  note(`bad: ${st.title} — ${st.hint}`);
  return [`bad: ${st.title}`, "401 from an authenticated ping, reported as 'Token rejected'"];
});

await test("10d. Options page: bridge down -> bad, names the URL tried", async () => {
  await bridgeReset();
  await seedSettings(context, extId, {});
  const opt = await context.newPage();
  await opt.goto(optionsUrl());
  await bridge.close();
  let st;
  try {
    st = await runTestConnection(opt);
    await opt.screenshot({ path: join(shots, "options-page-bridge-down.png") });
  } finally {
    bridge = createMockBridge({ port: BRIDGE_PORT, token: DEFAULT_TOKEN, quiet: true });
    await bridge.listen();
  }
  assertEq(st.tone, "bad", "bridge-down must be a bad tone");
  assertEq(st.title, "Can't reach the Paseo bridge", "headline");
  assert(st.detail.includes(BRIDGE_URL), `message should name the URL tried: ${st.detail}`);
  await opt.close();
  note(`down: ${st.title} — ${st.detail}`);
  return [`down: ${st.title} — ${st.detail}`, "distinct from 10c's 'Token rejected'"];
});

await test("10e. Options page: contract mismatch -> bad 'Update required'", async () => {
  await bridgeReset();
  await bridgeConfig({ contract: 2 });
  try {
    const opt = await context.newPage();
    await opt.goto(optionsUrl());
    const st = await runTestConnection(opt);
    assertEq(st.tone, "bad", "mismatch must be a bad tone");
    assertEq(st.title, "Update required", "headline");
    assert(st.detail.includes("v2") && st.detail.includes("v1"), `detail must name both versions: ${st.detail}`);
    assert(st.hint.includes("Sends are blocked"), `hint must say sends are blocked: ${st.hint}`);
    await opt.screenshot({ path: join(shots, "options-page-contract-mismatch.png") });
    await opt.close();
    note(`mismatch: ${st.title} — ${st.detail}`);
    return [`bad: ${st.title} — ${st.detail}`];
  } finally {
    await bridgeConfig({ contract: 1 });
  }
});

await test("10f. Options page fresh state: masked token, hidden grant row", async () => {
  const opt = await context.newPage();
  await opt.goto(optionsUrl());
  await clearCachedProviders(context);
  await seedSettings(context, extId, { bridgeUrl: "http://127.0.0.1:7788", token: "" });
  await opt.reload();
  await opt.waitForTimeout(400);
  await opt.screenshot({ path: join(shots, "options-page.png") });
  const ui = await opt.evaluate(() => ({
    tokenType: document.querySelector("#token").type,
    grantRowVisible: document.querySelector("#grantRow").getBoundingClientRect().height > 0,
    statusTone: document.querySelector("#status").dataset.tone,
  }));
  assertEq(ui.tokenType, "password", "the token field must be masked by default");
  assert(
    !ui.grantRowVisible,
    "the 'Grant access' row must stay hidden when the bridge URL is already covered by host_permissions",
  );
  assertEq(ui.statusTone, "idle", "with no token stored the page must not auto-ping");
  await opt.close();
  await seedSettings(context, extId, {});
  return [
    "token input is type=password by default",
    "'Grant access to this address' row hidden for an already-permitted bridge URL",
    "no automatic ping when unpaired",
  ];
});

/* ---- 11. token containment -------------------------------------------- */
await test("11. Bearer token is not reachable from the page", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");
  await page.locator("[data-stp-prompt]").fill("Fix merge conflicts");
  await page.locator("[data-stp-send]").click();
  await waitForPhase(page, "sent");

  // Positive control: the token really IS stored, in the extension's own world.
  const stored = await readStoredSettings(context);
  assertEq(stored.token, DEFAULT_TOKEN, "sanity: the token is in extension storage");

  const scan = await page.evaluate((token) => {
    const hits = [];

    // 1. serialized document
    if (document.documentElement.outerHTML.includes(token)) hits.push("document.outerHTML");

    // 2. every open shadow root, recursively
    const walkShadow = (node, path) => {
      for (const child of node.querySelectorAll("*")) {
        if (child.shadowRoot) {
          if (child.shadowRoot.innerHTML.includes(token)) hits.push(`shadowRoot ${path}>${child.tagName}`);
          walkShadow(child.shadowRoot, `${path}>${child.tagName}`);
        }
      }
    };
    walkShadow(document, "doc");

    // 3. attributes anywhere
    for (const elem of document.querySelectorAll("*")) {
      for (const a of elem.attributes) if (a.value.includes(token)) hits.push(`attr ${elem.tagName}[${a.name}]`);
    }

    // 4. window own properties (shallow) + localStorage/sessionStorage
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (typeof v === "string" && v.includes(token)) hits.push(`window.${k}`);
      } catch { /* cross-origin getter */ }
    }
    for (const store of ["localStorage", "sessionStorage"]) {
      try {
        const s = window[store];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if ((s.getItem(k) ?? "").includes(token) || k.includes(token)) hits.push(`${store}.${k}`);
        }
      } catch { /* ignore */ }
    }

    // 5. the page world cannot see chrome.runtime/storage at all
    const chromeVisible = typeof window.chrome?.storage !== "undefined";

    return { hits, chromeVisible };
  }, DEFAULT_TOKEN);

  assertEq(scan.hits, [], "token must not appear anywhere reachable from the page");
  assert(!scan.chromeVisible, "the page world must not see chrome.storage");

  // Static check on the shipped bundles: the page-adjacent scripts contain no
  // credential handling at all.
  const contentJs = readFileSync(join(distTest, "content.js"), "utf8");
  const mainworldJs = readFileSync(join(distTest, "mainworld.js"), "utf8");
  const backgroundJs = readFileSync(join(distTest, "background.js"), "utf8");

  for (const [name, src] of [["content.js", contentJs], ["mainworld.js", mainworldJs]]) {
    for (const needle of ["Bearer", "chrome.storage", "authorization", "Authorization", DEFAULT_TOKEN]) {
      assert(!src.includes(needle), `${name} must not contain "${needle}"`);
    }
  }
  assert(backgroundJs.includes("Bearer "), "sanity: the service worker IS the thing that sends Bearer");
  assert(backgroundJs.includes("chrome.storage"), "sanity: the service worker owns storage");

  note("content.js / mainworld.js contain no Bearer, no chrome.storage, no token");
  return [
    "no token in DOM, shadow DOM, attributes, window, localStorage or sessionStorage",
    "page world cannot see chrome.storage",
    "content.js + mainworld.js: no Bearer / Authorization / chrome.storage references",
    "background.js: contains both (the credential lives only there)",
  ];
});

/* ---- extra: contract conformance of the mock bridge itself -------------- */
await test("12. Bridge security rules (Origin / Host / body cap / rate limit)", async () => {
  await bridgeReset();
  const j = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

  // Origin from a web page -> forbidden_origin, on the real request...
  const pageOrigin = await j(
    await fetch(`${BRIDGE_URL}/v1/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.graphite.com",
        Authorization: `Bearer ${DEFAULT_TOKEN}`,
      },
      body: JSON.stringify({ forge: "github", owner: "o", repo: "r", number: 1 }),
    }),
  );
  assertEq([pageOrigin.status, pageOrigin.body.error.code], [403, "forbidden_origin"], "web origin rejected");

  // ...and on the preflight.
  const preflight = await fetch(`${BRIDGE_URL}/v1/resolve`, {
    method: "OPTIONS",
    headers: { Origin: "https://app.graphite.com", "Access-Control-Request-Method": "POST" },
  });
  assertEq(preflight.status, 403, "preflight from a web origin rejected");

  // An extension origin is allowed and gets CORS echoed without credentials.
  const extRes = await fetch(`${BRIDGE_URL}/v1/ping`, {
    headers: { Origin: `chrome-extension://${extId}` },
  });
  assertEq(extRes.status, 200, "extension origin allowed");
  assertEq(
    extRes.headers.get("access-control-allow-origin"),
    `chrome-extension://${extId}`,
    "CORS origin echoed",
  );
  assertEq(extRes.headers.get("vary"), "Origin", "Vary: Origin present");
  assertEq(extRes.headers.get("access-control-allow-credentials"), null, "no ACAC header");

  // Host check (DNS rebinding). fetch() refuses to override the Host header, so
  // this has to go over a raw socket — which is also closer to what a hostile
  // page's DNS-rebinding attempt actually looks like.
  const badHost = await (async () => {
    const { connect } = await import("node:net");
    return new Promise((resolve, reject) => {
      const sock = connect(BRIDGE_PORT, "127.0.0.1", () => {
        sock.write("GET /v1/ping HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n");
      });
      let buf = "";
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error("raw socket timeout")); });
      sock.on("data", (d) => (buf += d));
      sock.on("error", reject);
      sock.on("end", () => {
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0);
        let body = null;
        try { body = JSON.parse(buf.slice(buf.indexOf("\r\n\r\n") + 4)); } catch { /* not json */ }
        resolve({ status, body, raw: buf.split("\r\n")[0] });
      });
    });
  })();
  note(`raw socket with Host: evil.example.com -> ${badHost.raw}`);
  assertEq([badHost.status, badHost.body?.error?.code], [403, "forbidden_host"], "bad Host rejected");

  // 64 KiB cap.
  const big = await j(
    await fetch(`${BRIDGE_URL}/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEFAULT_TOKEN}` },
      body: JSON.stringify({
        forge: "github",
        owner: "acmegizmos",
        repo: "gizmo-poc",
        number: 942,
        prompt: "x".repeat(70 * 1024),
        target: { kind: "create" },
      }),
    }),
  );
  assertEq([big.status, big.body.error.code], [413, "payload_too_large"], "64 KiB cap enforced");

  /* Rate limit: 60 requests / 10 s (CONTRACT.md item 6, raised from 30 because
     the uncached contract gate costs 4 requests per completed send), keyed on
     the Origin header when present and on the remote address otherwise. */
  await bridgeReset();
  const BURST = 70;
  let allowed = 0;
  let limited = 0;
  const burstStart = Date.now();
  for (let i = 0; i < BURST; i++) {
    // No Origin header -> keyed on the remote address.
    const r = await fetch(`${BRIDGE_URL}/v1/ping`);
    if (r.status === 429) limited++;
    else if (r.status === 200) allowed++;
  }
  const burstMs = Date.now() - burstStart;
  // The exact counts below only hold inside one 10 s window; fail legibly rather
  // than confusingly if a slow machine straddles it.
  assert(burstMs < 6000, `burst took ${burstMs}ms — too slow to assert exact counts in a 10s window`);
  assertEq(allowed, 60, `exactly 60 of ${BURST} no-Origin requests should be allowed`);
  assertEq(limited, BURST - 60, `the remaining ${BURST - 60} must be 429 rate_limited`);

  // The bucket really is exhausted...
  const stillLimited = await fetch(`${BRIDGE_URL}/v1/ping`);
  assertEq(stillLimited.status, 429, "the remote-address bucket is still exhausted");

  // ...but the extension's own origin has a SEPARATE bucket, which is the whole
  // point of the keying rule: "a curl flood can't consume the extension's
  // budget". Same 10 s window, same remote address, different key.
  const extOrigin = await fetch(`${BRIDGE_URL}/v1/ping`, {
    headers: { Origin: `chrome-extension://${extId}` },
  });
  assertEq(
    extOrigin.status,
    200,
    "a chrome-extension origin must NOT be rate-limited by a no-Origin flood",
  );

  // And that origin's own bucket is enforced too (it just started fresh).
  let extLimited = 0;
  for (let i = 0; i < BURST; i++) {
    const r = await fetch(`${BRIDGE_URL}/v1/ping`, {
      headers: { Origin: `chrome-extension://${extId}` },
    });
    if (r.status === 429) extLimited++;
  }
  assert(
    extLimited >= BURST - 60,
    `the extension origin's own bucket must also cap at 60, saw ${extLimited} refusals`,
  );
  note(`no-Origin: ${allowed} allowed / ${limited} refused of ${BURST} in ${burstMs}ms; extension origin unaffected, then capped`);
  await bridgeReset();

  // CONTRACT.md: the bridge MUST tolerate a self-inclusive stackPrNumbers list
  // and filter it, not reject it.
  await bridgeReset();
  const selfInclusive = await j(
    await fetch(`${BRIDGE_URL}/v1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEFAULT_TOKEN}` },
      body: JSON.stringify({
        forge: "github",
        owner: "acmegizmos",
        repo: "gizmo-poc",
        number: 942,
        stackPrNumbers: [949, 942, 948],
      }),
    }),
  );
  assertEq(selfInclusive.status, 200, "a self-inclusive stack list must be tolerated, not rejected");
  const stackCandidate = selfInclusive.body.candidates.find((c) => c.reason === "stack");
  assertEq(stackCandidate?.stackPrNumber, 949, "the self entry must be filtered out, not used");
  await bridgeReset();

  return [
    "forbidden_origin on real request and on preflight",
    "chrome-extension origin echoed, no Access-Control-Allow-Credentials, Vary: Origin",
    "forbidden_host via raw socket with a spoofed Host header",
    "payload_too_large at >64 KiB",
    `rate_limited at 60/10s: exactly ${allowed} of ${BURST} no-Origin requests allowed, ${limited} refused`,
    "Origin-vs-remote-address keying: a chrome-extension origin got 200 while the no-Origin bucket was exhausted, then hit its own cap",
    "self-inclusive stackPrNumbers tolerated and filtered (200, stack candidate #949)",
  ];
});

/* ---- 15. ping three-way auth (raw contract conformance) ---------------- */
await test("15. GET /v1/ping: optional auth has three distinct outcomes", async () => {
  await bridgeReset();
  const get = async (headers) => {
    const r = await fetch(`${BRIDGE_URL}/v1/ping`, { headers });
    return { status: r.status, body: await r.json() };
  };

  const anon = await get({});
  assertEq(anon.status, 200, "no Authorization must still be 200 (liveness check)");
  assertEq(anon.body.paired, false, "unauthenticated ping reports paired: false");
  assertEq(anon.body.providers, [], "unauthenticated ping returns providers: []");
  assertEq(anon.body.contract, 1, "contract");

  const good = await get({ Authorization: `Bearer ${DEFAULT_TOKEN}` });
  assertEq(good.status, 200, "valid token -> 200");
  assertEq(good.body.paired, true, "valid token reports paired: true");
  assertEq(good.body.providers.length, 3, "valid token returns the full provider list");
  assertEq(
    good.body.providers.filter((p) => p.isDefault).map((p) => p.id),
    ["claude/claude-opus-5"],
    "exactly one provider is flagged isDefault",
  );

  const bad = await get({ Authorization: "Bearer wrong" });
  assertEq(bad.status, 401, "invalid token -> 401");
  assertEq(bad.body.error.code, "unauthorized", "invalid token -> unauthorized");

  return [
    "no auth      -> 200 paired:false providers:[]",
    "valid auth   -> 200 paired:true  providers:3 (one isDefault)",
    "invalid auth -> 401 unauthorized",
  ];
});

/* ---- 16. contract mismatch refuses to send ---------------------------- */
await test("16. contract mismatch: popover refuses, and Send never reaches the bridge", async () => {
  await bridgeReset();
  await seedSettings(context, extId, {});

  /* (a) mismatch already present when the popover opens: caught before typing. */
  await bridgeConfig({ contract: 2 });
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "error", 15000);

  const ui = await readError(page);
  assertEq(ui.code, "contract_mismatch", "code");
  assertEq(ui.title, "Update required", "title");
  assert(ui.message.includes("v2") && ui.message.includes("v1"), `message must name both versions: ${ui.message}`);
  assert(ui.hasOptionsLink, "should offer the options link");

  let log = await bridgeLog();
  assertEq(log.filter((r) => r.path === "/v1/resolve").length, 0, "must not even resolve on a mismatch");
  assertEq(log.filter((r) => r.path === "/v1/send").length, 0, "must not send on a mismatch");
  assert(log.some((r) => r.path === "/v1/ping"), "the gate is a /v1/ping");
  await shot(page, "error-contract-mismatch", POPOVER_CLIP);
  await page.keyboard.press("Escape");
  await page.waitForSelector(POPOVER, { state: "detached", timeout: 4000 });

  /* (b) the harder case: composer already open and ready on a good contract,
         then the plugin is swapped underneath. Send must still refuse. */
  await bridgeConfig({ contract: 1 });
  await bridgeReset();
  await openPopover(page);
  await waitForPhase(page, "ready", 15000);
  await page.locator("[data-stp-prompt]").fill("This must never be sent");

  // No cache to invalidate: the gate re-pings on every send by design, so
  // swapping the plugin underneath an open composer is caught immediately.
  await bridgeConfig({ contract: 2 });
  await page.locator("[data-stp-send]").click();
  await waitForPhase(page, "error", 15000);

  const ui2 = await readError(page);
  assertEq(ui2.code, "contract_mismatch", "Send must refuse on a mismatch, not guess");
  log = await bridgeLog();
  assertEq(
    log.filter((r) => r.path === "/v1/send").length,
    0,
    "POST /v1/send must never have been issued",
  );
  note("composer was ready, plugin flipped to contract v2, Send refused with zero /v1/send requests");

  await bridgeConfig({ contract: 1 });
  return [
    "mismatch at popover-open time: no /v1/resolve, no /v1/send",
    "mismatch after the composer was ready: Send refused, no /v1/send",
    `rendered: ${ui.title} — ${ui.message}`,
  ];
});

/* ---- 17. dryRun surfaced distinctly ---------------------------------- */
await test("17. dryRun: true is surfaced distinctly from a real send", async () => {
  await bridgeReset();
  await bridgeConfig({ dryRun: true });
  try {
    await seedSettings(context, extId, {});
    await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
    await waitForButton(page);
    await openPopover(page);
    await waitForPhase(page, "ready");
    await page.locator("[data-stp-prompt]").fill("Dry run check");
    await page.locator("[data-stp-send]").click();
    await waitForPhase(page, "sent");

    const req = await lastRequest("/v1/send");
    assert(req, "send happened");

    const ui = await page.evaluate(() => {
      const host = document.querySelector("send-to-paseo-popover");
      const root = host.shadowRoot;
      return {
        hostAttr: host.getAttribute("data-stp-dryrun"),
        headline: root.querySelector("[data-stp-success]").textContent.trim(),
        badge: root.querySelector("[data-stp-dryrun]")?.textContent.trim() ?? null,
        note: root.querySelector(".dry-note")?.textContent.trim() ?? "",
        linkText: root.querySelector("[data-stp-deeplink]").textContent.trim(),
      };
    });

    assertEq(ui.hostAttr, "true", "host must be marked dryRun=true");
    assert(/dry run/i.test(ui.headline), `headline must say dry run, got: ${ui.headline}`);
    assert(/no agent created/i.test(ui.headline), `headline must say nothing was created: ${ui.headline}`);
    assertEq(ui.badge, "DRY RUN", "an explicit DRY RUN badge");
    assert(ui.note.includes("SEND_TO_PASEO_DRY_RUN=1"), `note must name the flag: ${ui.note}`);
    assert(ui.note.includes("synthetic"), `note must say the ids are synthetic: ${ui.note}`);
    assert(/synthetic id/i.test(ui.linkText), `the deep link must be labelled synthetic: ${ui.linkText}`);

    await shot(page, "popover-success-dry-run", POPOVER_CLIP);
    note(`headline: ${ui.headline}`);
    return [
      `headline: "${ui.headline}" + badge "${ui.badge}"`,
      "note names SEND_TO_PASEO_DRY_RUN=1 and the synthetic ids",
      "deep link relabelled 'Open in Paseo (synthetic id)'",
      "test 6 asserts the real-send case renders dryRun=false with no badge",
    ];
  } finally {
    await bridgeConfig({ dryRun: false });
  }
});

/* ---- 18. shipping build hygiene -------------------------------------- */
await test("18. Shipping build contains no test host or test bridge port", async () => {
  const dist = join(extDir, "dist");
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

  // The single most dangerous footgun: a stray localhost host permission in a
  // published extension. host_permissions must be EXACTLY the real bridge.
  assertEq(
    manifest.host_permissions,
    ["http://127.0.0.1:7788/*"],
    "shipping host_permissions must be exactly the real bridge origin",
  );
  // Other localhost ports are user-consented only, never pre-granted.
  assertEq(
    manifest.optional_host_permissions,
    ["http://127.0.0.1/*", "http://localhost/*"],
    "localhost breadth is optional_host_permissions only, and exactly these two",
  );
  assert(!manifest.name.includes("test build"), `shipping name must not be the test build: ${manifest.name}`);

  const expectedMatches = [
    "https://app.graphite.com/github/pr/*",
    "https://app.graphite.dev/github/pr/*",
    "https://github.com/*/*/pull/*",
  ];
  for (const cs of manifest.content_scripts) {
    assertEq(
      cs.matches,
      expectedMatches,
      "content-script matches must be exactly the two Graphite hosts plus github.com",
    );
  }
  // Both content scripts, not just one: the MAIN-world SPA shim at
  // document_start is as load-bearing on GitHub (Turbo) as on Graphite.
  assertEq(
    manifest.content_scripts.map((cs) => `${cs.js.join(",")}@${cs.run_at}/${cs.world ?? "ISOLATED"}`),
    ["mainworld.js@document_start/MAIN", "content.js@document_idle/ISOLATED"],
    "both content scripts must be declared, with the MAIN-world shim at document_start",
  );

  const forbidden = [String(FIXTURE_PORT), String(BRIDGE_PORT), "dist-test"];
  const files = ["manifest.json", "content.js", "mainworld.js", "background.js", "options.js", "options.html"];
  const hits = [];
  for (const f of files) {
    const src = readFileSync(join(dist, f), "utf8");
    for (const needle of forbidden) if (src.includes(needle)) hits.push(`${f}: "${needle}"`);
  }
  assertEq(hits, [], "no test-only host, port or directory may appear in the shipping build");

  // And the injected host allowlist really is empty.
  const contentJs = readFileSync(join(dist, "content.js"), "utf8");
  assert(
    /define_STP_EXTRA_HOSTS_default = \[\]/.test(contentJs),
    "the shipping build's injected extra-host list must be empty",
  );

  /* No localhost ORIGIN may reach a shipping artifact. Stated as "no
     host:port form anywhere", which is the thing that would actually be
     dangerous, plus an exact allowlist of the two remaining bare `localhost`
     substrings so a third one cannot appear unnoticed.

     Those two are deliberate and are NOT hosts the extension talks to:
       manifest.json  "http://localhost/*" under optional_host_permissions —
                      breadth the user must grant explicitly, asserted above.
       content.js     an error HINT string telling the user what a valid bridge
                      URL looks like (src/shared/errors.ts). */
  const originForms = /(?:localhost|127\.0\.0\.1):\d+/g;
  const originHits = [];
  const bareLocalhost = [];
  for (const f of files) {
    const src = readFileSync(join(dist, f), "utf8");
    for (const m of src.matchAll(originForms)) {
      // The real bridge origin is the one legitimate host:port in a shipping build.
      if (m[0] === "127.0.0.1:7788") continue;
      originHits.push(`${f}: ${m[0]}`);
    }
    for (const line of src.split("\n")) {
      if (!line.includes("localhost")) continue;
      // Collapse the one known prose string so this assertion is about WHICH
      // files carry a localhost substring, not about the wording of a hint.
      const HINT = 'The bridge URL must be http://127.0.0.1:<port> or http://localhost:<port>.';
      bareLocalhost.push(line.includes(HINT) ? `${f}: BRIDGE-URL HINT` : `${f}: ${line.trim()}`);
    }
  }
  assertEq(originHits, [], "no localhost/127.0.0.1 origin other than the real bridge may ship");
  assertEq(
    bareLocalhost,
    [
      'manifest.json: "http://localhost/*"',
      "content.js: BRIDGE-URL HINT",
      "options.js: BRIDGE-URL HINT",
    ],
    "the only `localhost` substrings in a shipping build are the optional permission and the error hint",
  );

  // Sanity: the TEST build is the one that carries them, so this test can fail.
  const testManifest = JSON.parse(readFileSync(join(distTest, "manifest.json"), "utf8"));
  assert(
    testManifest.host_permissions.includes(`http://127.0.0.1:${BRIDGE_PORT}/*`),
    "sanity: the test build IS the one with the mock bridge permission",
  );
  assert(testManifest.name.includes("test build"), "sanity: the test build is labelled");

  return [
    `shipping host_permissions: ${JSON.stringify(manifest.host_permissions)}`,
    `shipping optional_host_permissions: ${JSON.stringify(manifest.optional_host_permissions)}`,
    `no occurrence of ${forbidden.join(", ")} in any shipping file`,
    "the only localhost/127.0.0.1 origin in the shipping build is 127.0.0.1:7788",
    `the only bare \`localhost\` substrings are the optional permission + the error hint (${bareLocalhost.length})`,
    "__STP_EXTRA_HOSTS__ compiles to [] in the shipping bundle",
    `test build (for contrast): ${JSON.stringify(testManifest.host_permissions)}`,
  ];
});

/* ---- 14. compact viewport, light + dark ------------------------------- */
await test("14. Compact window: popover stays on-screen, button still anchored", async () => {
  await bridgeReset();
  await page.setViewportSize({ width: 860, height: 620 });
  try {
    await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
    await waitForButton(page);
    const mode = await page.evaluate((s) => document.querySelector(s).getAttribute("data-stp-mode"), BUTTON);
    assertEq(mode, "anchored", "still anchored in a narrow window");

    await openPopover(page);
    await waitForPhase(page, "ready");
    await page.locator("[data-stp-prompt]").fill("Split this PR into two");

    const box = await page.evaluate(() => {
      const host = document.querySelector("send-to-paseo-popover");
      const r = host.shadowRoot.querySelector(".card").getBoundingClientRect();
      return {
        left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    });
    assert(box.left >= 0, `popover overflows left: ${box.left}`);
    assert(box.top >= 0, `popover overflows top: ${box.top}`);
    assert(box.right <= box.vw + 1, `popover overflows right: ${box.right} > ${box.vw}`);
    assert(box.bottom <= box.vh + 1, `popover overflows bottom: ${box.bottom} > ${box.vh}`);
    note(`card ${Math.round(box.right - box.left)}x${Math.round(box.bottom - box.top)} inside ${box.vw}x${box.vh}`);

    await shot(page, "compact-window-popover-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "compact-window-popover-dark");
    await page.emulateMedia({ colorScheme: "light" });

    /* The Target dropdown opens in normal flow, so it GROWS the card — which is
       exactly the input position() measures. In a 620px-tall window that is the
       case most likely to push the card off-screen, so assert it explicitly:
       the card, and the dropdown list inside it, both stay in the viewport. */
    await openCandidates(page);
    const open = await page.evaluate(() => {
      const host = document.querySelector("send-to-paseo-popover");
      const root = host.shadowRoot;
      const card = root.querySelector(".card").getBoundingClientRect();
      const list = root.querySelector("[data-stp-combo-list]").getBoundingClientRect();
      return {
        card: { left: card.left, top: card.top, right: card.right, bottom: card.bottom },
        list: { top: list.top, bottom: list.bottom, height: list.height },
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    assert(open.card.top >= 0, `card overflows top with the dropdown open: ${open.card.top}`);
    assert(open.card.left >= 0, `card overflows left with the dropdown open: ${open.card.left}`);
    assert(
      open.card.bottom <= open.vh + 1,
      `card overflows bottom with the dropdown open: ${open.card.bottom} > ${open.vh}`,
    );
    assert(
      open.card.right <= open.vw + 1,
      `card overflows right with the dropdown open: ${open.card.right} > ${open.vw}`,
    );
    assert(open.list.top >= 0 && open.list.bottom <= open.vh + 1, `option list off-screen: ${JSON.stringify(open.list)}`);
    assert(open.list.height > 0 && open.list.height <= 0.34 * open.vh + 1, `list must be capped, got ${open.list.height} in ${open.vh}`);
    note(
      `dropdown open: card ${Math.round(open.card.bottom - open.card.top)}px tall, ` +
        `list ${Math.round(open.list.height)}px, viewport ${open.vw}x${open.vh}`,
    );
    await shot(page, "compact-window-combobox-open-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "compact-window-combobox-open-dark");
    await page.emulateMedia({ colorScheme: "light" });

    return [
      `860x620 viewport: card fits at (${Math.round(box.left)},${Math.round(box.top)})-(${Math.round(box.right)},${Math.round(box.bottom)})`,
      "button still on the primary anchor rung",
      `with the Target dropdown open: card ${Math.round(open.card.top)}..${Math.round(open.card.bottom)}`
        + ` of ${open.vh}px, option list ${Math.round(open.list.height)}px (capped at 34vh)`,
    ];
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

/* ---- 13. live integration against the REAL plugin bridge (read-only) ---- */
/*
 * This case talks to the plugin that is actually installed in Paseo, over real
 * HTTP, with the real pairing token. It is read-only by construction: it calls
 * `/v1/ping` and `/v1/resolve` and never `/v1/send`, because a real send would
 * start a real agent on the user's machine.
 *
 * It deliberately does NOT assert a populated candidate list. Candidates come
 * from the operator's own Paseo workspaces and would put their branch names and
 * workspace labels into a committed screenshot. Instead the fixture's repo
 * (`acmegizmos/gizmo-poc`, which is fictional and is a Paseo project on nobody's
 * machine) is resolved against the live plugin and the contract error it returns
 * is asserted — which still exercises the whole path: extension -> real HTTP ->
 * real plugin subprocess -> real `gh` / real daemon -> contract error -> render.
 *
 * Set STP_LIVE_PR="owner/repo#number" to additionally exercise the happy path
 * against a repo you have registered in Paseo. That branch takes no screenshot.
 */
{
  const LIVE_PORT = 7788;
  const settingsPath = join(homedir(), ".paseo", "plugin-data", "send-to-paseo", "settings.json");
  let liveToken = null;
  let liveUp = false;
  let livePing = null;
  try {
    liveToken = JSON.parse(readFileSync(settingsPath, "utf8")).token;
  } catch { /* plugin not installed / not readable */ }
  try {
    const r = await fetch(`http://127.0.0.1:${LIVE_PORT}/v1/ping`, { signal: AbortSignal.timeout(2000) });
    liveUp = r.ok;
    if (r.ok) livePing = await r.json();
  } catch { /* not running */ }

  const name = "13. Live integration: real plugin bridge on 7788 (/v1/ping + /v1/resolve only)";
  if (!liveUp || !liveToken) {
    skip(name, `real bridge not available (listening=${liveUp}, token=${Boolean(liveToken)})`);
  } else {
    await test(name, async () => {
      /* a. /v1/ping, straight off the real bridge. No repo involved.
         Auth is optional on /v1/ping, but the provider and mode lists are only
         returned to a PAIRED caller, so send the real token. */
      const pingRes = await fetch(`http://127.0.0.1:${LIVE_PORT}/v1/ping`, {
        headers: { Authorization: `Bearer ${liveToken}` },
        signal: AbortSignal.timeout(5000),
      });
      assertEq(pingRes.status, 200, "live authenticated /v1/ping status");
      livePing = await pingRes.json();
      assertEq(livePing.paired, true, "live /v1/ping must report paired for a real token");
      assertEq(livePing.contract, 1, "live /v1/ping contract version");
      assertEq(livePing.name, "send-to-paseo", "live /v1/ping plugin name");
      assert(livePing.daemon?.reachable === true, "live daemon must be reachable");
      assert(
        /^srv_[A-Za-z0-9]+$/.test(livePing.daemon?.serverId ?? ""),
        `live daemon serverId shape, got: ${livePing.daemon?.serverId}`,
      );
      assert(livePing.providers?.length > 1, `live provider list, got ${livePing.providers?.length}`);
      assert(livePing.modes?.length > 1, `live mode list, got ${livePing.modes?.length}`);

      /* b. /v1/resolve through the extension, against the live bridge. */
      await seedSettings(context, extId, {
        bridgeUrl: `http://127.0.0.1:${LIVE_PORT}`,
        token: liveToken,
      });
      const out = [
        `live /v1/ping: contract ${livePing.contract}, daemon ${livePing.daemon.version},`
          + ` ${livePing.providers.length} providers, ${livePing.modes.length} modes`,
        "/v1/send intentionally NOT exercised against the live bridge",
      ];
      try {
        await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
        await waitForButton(page);
        await openPopover(page);
        await waitForPhase(page, "error", 25000);

        const err = await readError(page);
        /* Whichever of these the operator's `gh` and Paseo produce for a repo
           that does not exist, it must be a CONTRACT code rendered with a real
           title — never a bare "Failed" and never a local/synthesised code. */
        const expected = ["project_not_found", "pr_not_found", "forge_unauthenticated", "forge_no_repo_access"];
        assert(
          expected.includes(err.code),
          `live resolve of a non-existent repo should return a contract code, got: ${err.code}`,
        );
        assert(!err.bare, `live error must render a specific title, got: ${err.title}`);
        assert(err.title.length > 3, `live error title, got: ${err.title}`);
        note(`live resolve error: ${err.code} — ${err.title}`);
        await shot(page, "live-bridge-popover-real-candidates", POPOVER_CLIP);
        out.push(`live /v1/resolve of the (fictional) fixture repo -> ${err.code}: ${err.title}`);

        /* c. Optional: the happy path, against a repo the operator supplies. */
        const livePr = process.env.STP_LIVE_PR;
        const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(livePr ?? "");
        if (m) {
          const [, owner, repo, number] = m;
          await page.goto(fixtures.url({ owner, repo, number: Number(number) }), {
            waitUntil: "domcontentloaded",
          });
          await waitForButton(page);
          await openPopover(page);
          await waitForPhase(page, "ready", 25000);
          const liveCands = await readCandidates(page);
          const live = {
            candidateCount: liveCands.options.length,
            providerCount: await page.evaluate(
              () =>
                document.querySelector("send-to-paseo-popover").shadowRoot.querySelector(
                  "[data-stp-provider]",
                ).options.length,
            ),
          };
          assert(live.candidateCount > 1, `STP_LIVE_PR: candidates, got ${live.candidateCount}`);
          assert(live.providerCount > 1, `STP_LIVE_PR: providers, got ${live.providerCount}`);
          /* No screenshot here on purpose: candidate labels are the operator's
             own workspace names and branch names. */
          out.push(
            `STP_LIVE_PR=${livePr} resolved: ${live.candidateCount} candidates,`
              + ` ${live.providerCount} providers (not screenshotted — private data)`,
          );
        } else {
          out.push("STP_LIVE_PR not set — happy-path candidate list not exercised");
        }
        return out;
      } finally {
        await seedSettings(context, extId, {});
      }
    });
  }
}


/**
 * A faithful stand-in for Graphite's shortcut layer, as measured on the live
 * app on 2026-09-01: keydown listeners on window, document and body in BOTH
 * phases, deciding "is the user typing?" from event.target.
 *
 * Shadow-DOM retargeting is what makes this hostile: a listener outside our
 * shadow root sees event.target === <send-to-paseo-popover>, not our
 * <textarea>, so the guard concludes "not a text field" and treats real
 * typing as shortcuts. On live Graphite that stole focus on nearly every
 * keystroke and typing this exact prompt produced the literal value "x ".
 *
 * Only the BUBBLE handlers act here, which mirrors the measurement: the
 * capture-phase handlers on live Graphite do fire but take no action. See
 * extension/src/content/ui/keyboard.ts.
 */
async function installHostileGraphiteShortcuts(page) {
  await page.evaluate(() => {
    const state = { bubble: [], capture: [], targets: [] };
    window.__hostile = state;
    const thief = document.createElement("input");
    thief.id = "__hostile_thief";
    document.body.appendChild(thief);

    const isEditable = (node) =>
      !!node &&
      (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable === true);

    const handler = (phase, destructive) => (ev) => {
      const t = ev.target;
      state.targets.push(t && t.tagName ? t.tagName.toLowerCase() : String(t));
      if (isEditable(t)) return; // a real text field: a good citizen backs off
      state[phase].push(ev.key); // ... otherwise it is "a shortcut"
      if (destructive) {
        ev.preventDefault();
        thief.focus();
      }
    };

    for (const target of [window, document, document.body]) {
      target.addEventListener("keydown", handler("capture", false), true);
      target.addEventListener("keydown", handler("bubble", true), false);
    }
  });
}

/** Every character here is a plausible single-key Graphite shortcut. */
const GRAPHITE_HOSTILE_KEYS = "Fix merge conflicts? c/j k n p a g r";

await test("19. Host-page keyboard shortcuts cannot reach the popover (regression)", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");
  await installHostileGraphiteShortcuts(page);

  const prompt = GRAPHITE_HOSTILE_KEYS;
  await page.locator("[data-stp-prompt]").click();
  await page.keyboard.type(prompt, { delay: 5 });

  const observed = await page.evaluate(() => {
    const host = document.querySelector("send-to-paseo-popover");
    const ta = host?.shadowRoot?.querySelector("[data-stp-prompt]");
    return {
      value: ta ? ta.value : null,
      focusInPopover: !!ta && document.activeElement === host && host.shadowRoot.activeElement === ta,
      focusStolen: document.activeElement?.id === "__hostile_thief",
      bubbleShortcuts: window.__hostile.bubble.length,
      captureShortcuts: window.__hostile.capture.length,
      sawRetargetedHost: window.__hostile.targets.includes("send-to-paseo-popover"),
      popoverStillOpen: !!host,
    };
  });

  // The premise: the hostile listeners really were reached and really did see
  // the retargeted host. Without this the rest of the test could pass vacuously.
  assert(
    observed.sawRetargetedHost,
    "test is vacuous: the hostile listeners never saw the retargeted shadow host",
  );

  assertEq(observed.value, prompt, "keystrokes must reach the textarea byte-for-byte");
  assert(observed.popoverStillOpen, "popover must survive typing");
  assert(observed.focusInPopover, "focus must stay on the textarea while typing");
  assert(!observed.focusStolen, "the host page must not be able to steal focus mid-prompt");
  assertEq(
    observed.bubbleShortcuts,
    0,
    "no keystroke may reach a bubble-phase page listener (this is the bug being regression-tested)",
  );

  // Documented ceiling, not a defect: capture on window/document precedes any
  // listener we can register from a document_idle content script, so these
  // necessarily fire. keyboard.ts explains why that is tolerable and what the
  // fix would be if Graphite ever moved a shortcut there.
  note(
    `capture-phase page listeners still observed ${observed.captureShortcuts} keystrokes ` +
      `(expected and unavoidable); bubble-phase: ${observed.bubbleShortcuts}`,
  );

  await shot(page, "keyboard-containment-typed", POPOVER_CLIP);
});

await test("19b. Graphite: the Target SEARCH BOX is contained too (real keystrokes)", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");
  await installHostileGraphiteShortcuts(page);

  // The Target search box is a NEW text input, and containment is not automatic
  // for new surfaces — it holds here only because the dropdown renders inside
  // the popover's existing shadow root instead of being portalled into a host
  // of its own. That is a design constraint, so it gets the same regression
  // test as the textarea, with the same shortcut-shaped string.
  await openCandidates(page);
  await page.keyboard.type(GRAPHITE_HOSTILE_KEYS, { delay: 5 });

  const observed = await page.evaluate(() => {
    const host = document.querySelector("send-to-paseo-popover");
    const root = host?.shadowRoot;
    const input = root?.querySelector("[data-stp-combo-search]");
    return {
      value: input ? input.value : null,
      focusInSearch: !!input && document.activeElement === host && root.activeElement === input,
      focusStolen: document.activeElement?.id === "__hostile_thief",
      bubbleShortcuts: window.__hostile.bubble.length,
      captureShortcuts: window.__hostile.capture.length,
      sawRetargetedHost: window.__hostile.targets.includes("send-to-paseo-popover"),
      popoverStillOpen: !!host,
      dropdownStillOpen:
        root?.querySelector("[data-stp-combobox]")?.getAttribute("data-stp-combo-open") === "true",
      emptyShown: !root?.querySelector("[data-stp-combo-empty]").hasAttribute("hidden"),
    };
  });

  assert(
    observed.sawRetargetedHost,
    "test is vacuous: the hostile listeners never saw the retargeted shadow host",
  );
  assertEq(observed.value, GRAPHITE_HOSTILE_KEYS, "keystrokes must reach the search box byte-for-byte");
  assert(observed.popoverStillOpen, "popover must survive typing in the search box");
  assert(observed.dropdownStillOpen, "the dropdown must survive a barrage of shortcut keys");
  assert(observed.focusInSearch, "focus must stay in the search box while typing");
  assert(!observed.focusStolen, "the host page must not be able to steal focus mid-search");
  assertEq(observed.bubbleShortcuts, 0, "no keystroke may reach a bubble-phase page listener");
  assert(observed.emptyShown, "that string matches no workspace, so the empty row must show");

  note(
    `capture-phase page listeners still observed ${observed.captureShortcuts} keystrokes ` +
      `(expected and unavoidable); bubble-phase: ${observed.bubbleShortcuts}`,
  );
  await shot(page, "keyboard-containment-combobox-search", POPOVER_CLIP);
  return [
    `typed "${GRAPHITE_HOSTILE_KEYS}" into the Target search box with real keystrokes; value byte-exact`,
    `bubble-phase hits: ${observed.bubbleShortcuts} · capture-phase hits: ${observed.captureShortcuts}`,
  ];
});


await test("20. One workspace per stack: a stack sibling is the default, not 'create'", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);

  // PR 947 is in the fixture's stack but has no workspace on its own branch —
  // the reported case: "I want to Send to Paseo PR #4 but the workspace is at
  // another PR in the stack." This used to resolve to "create a new workspace".
  await page.evaluate(() => {
    history.pushState({}, "", "/github/pr/acmegizmos/gizmo-poc/947/GIZ-1132-retire-legacy-era-levers");
  });
  await page.waitForFunction(
    (s) => document.querySelector(s)?.getAttribute("data-stp-pr") === "947",
    BUTTON,
    { timeout: 6000 },
  );

  await openPopover(page);
  await waitForPhase(page, "ready");

  const resolved = await lastRequest("/v1/resolve");
  assertEq(resolved.body.number, 947, "resolve is for the navigated PR");

  const cands = await readCandidates(page);
  const ui = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    return {
      summary: root.querySelector("[data-stp-target-summary]").textContent.replace(/\s+/g, " ").trim(),
      mismatch: root.querySelector("[data-stp-branch-mismatch]")?.textContent.trim() ?? null,
      selected: root.querySelector("[data-stp-candidates]").textContent.trim(),
    };
  });
  ui.optionCount = cands.options.length;
  ui.createOfferedButNotDefault =
    cands.options.some((o) => /Create worktree/i.test(o)) &&
    !/Create worktree/i.test(ui.selected);

  assert(
    ui.summary.includes("workspace candid-otter"),
    `the stack workspace must be the resolved target, not a new worktree: ${ui.summary}`,
  );
  assert(ui.summary.includes("stack #"), `the summary must say which stack PR it matched: ${ui.summary}`);
  assert(
    !/will create worktree/i.test(ui.summary),
    `must not default to creating a workspace: ${ui.summary}`,
  );
  // The branch shown belongs to a sibling PR, so the popover has to say so
  // rather than let it read as this PR's branch.
  assertEq(
    ui.mismatch,
    "worktree is on another branch of this stack",
    "a sibling-branch target must be labelled as such",
  );
  assert(
    ui.createOfferedButNotDefault,
    "creating a worktree must still be offered, just not as the default",
  );

  await shot(page, "popover-stack-default", POPOVER_CLIP);

  // And a send goes to that existing workspace, not to a create.
  await page.locator("[data-stp-prompt]").fill("Fix merge conflicts");
  await page.locator("[data-stp-send]").click();
  await waitForPhase(page, "sent");
  const sent = await lastRequest("/v1/send");
  assertEq(sent.body.target.kind, "existing", "target must be the existing stack workspace");
  assertEq(
    sent.body.target.workspaceId,
    "wks_7b3e5c9a1d8f6042",
    "target must be the stack workspace's id",
  );
  assertEq(sent.body.number, 947, "the send must carry the PR the user was looking at");

  return [
    `default candidate: ${ui.selected}`,
    `candidates offered: ${ui.optionCount}`,
    `send target: ${JSON.stringify(sent.body.target)}`,
  ];
});

/* ---- 20a-20c. permission modes + the degraded-headBranch guard ---------- */

/** Every option of the popover's Mode select, with its danger marking. */
async function readModeSelect(page) {
  return page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    const sel = root.querySelector("[data-stp-mode]");
    if (!sel) return null;
    // Resolve --stp-warn through a throwaway probe rather than hard-coding a
    // hex value, so this asserts "the danger token", not "#92500e".
    const probe = document.createElement("span");
    probe.style.color = "var(--stp-warn)";
    root.querySelector(".card").append(probe);
    const warn = getComputedStyle(probe).color;
    probe.remove();
    return {
      warn,
      value: sel.value,
      options: [...sel.options].map((o) => ({
        value: o.value,
        text: o.textContent,
        danger: o.getAttribute("data-stp-mode-danger"),
        color: getComputedStyle(o).color,
      })),
      warning: root.querySelector("[data-stp-mode-warning]")?.textContent.trim() ?? null,
      providerValue: root.querySelector("[data-stp-provider]").value,
    };
  });
}

async function setSelect(page, attr, value) {
  await page.evaluate(
    ([a, v]) => {
      const root = document.querySelector("send-to-paseo-popover").shadowRoot;
      const sel = root.querySelector(`[${a}]`);
      sel.value = v;
      sel.dispatchEvent(new Event("change"));
    },
    [attr, value],
  );
}

await test("20a. Mode select: filtered by provider, resolved default preselected, danger marked", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  const claude = await readModeSelect(page);
  assert(claude, "a Mode select must render when the bridge advertises modes");

  // Filtered: Claude's five ids and nothing from Codex. Mode ids are
  // per-provider, so a Codex id appearing here would be a real bug.
  assertEq(
    claude.options.map((o) => o.value),
    ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
    "Mode options must be exactly the selected provider's modes",
  );
  assertEq(claude.providerValue, "claude/claude-opus-5", "provider under test");
  // resolvedModeId from /v1/resolve, not the first option and not "default".
  assertEq(claude.value, "auto", "the bridge's resolvedModeId must be preselected");
  assert(
    claude.options.find((o) => o.value === "auto").text.includes("(default)"),
    "the provider's own default must be labelled",
  );

  const bypass = claude.options.find((o) => o.value === "bypassPermissions");
  const safe = claude.options.find((o) => o.value === "default");
  assertEq(bypass.danger, "true", "the unattended mode must be marked in the DOM");
  assertEq(safe.danger, null, "a safe mode must not be marked");
  assert(bypass.text.startsWith("⚠"), `unattended option needs a glyph marker, got: ${bypass.text}`);
  assertEq(bypass.color, claude.warn, "the unattended option must use the --stp-warn token");
  assert(bypass.color !== safe.color, "the marking must actually differ from a safe mode");
  assertEq(claude.warning, null, "no inline warning while a safe-ish mode is selected");

  // Selecting it surfaces the consequence in prose, and still does not hide it.
  await setSelect(page, "data-stp-mode", "bypassPermissions");
  const picked = await readModeSelect(page);
  assertEq(picked.value, "bypassPermissions", "the dangerous mode is selectable, not hidden");
  assert(
    picked.warning?.includes("will not ask for permission"),
    `selecting an unattended mode must say so: ${picked.warning}`,
  );
  await shot(page, "popover-mode-unattended-light", POPOVER_CLIP);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "popover-mode-unattended-dark", POPOVER_CLIP);
  await page.emulateMedia({ colorScheme: "light" });

  // Switching provider must refilter and re-preselect: Codex's ids are
  // completely different, and its default is auto-review, not auto.
  await setSelect(page, "data-stp-provider", "codex/gpt-5-codex");
  const codex = await readModeSelect(page);
  assertEq(
    codex.options.map((o) => o.value),
    ["auto", "auto-review", "full-access"],
    "changing provider must refilter the Mode select",
  );
  assertEq(codex.value, "auto-review", "changing provider must re-preselect that provider's default");
  assertEq(codex.warning, null, "the stale bypassPermissions warning must not survive the switch");
  assertEq(
    codex.options.find((o) => o.value === "full-access").danger,
    "true",
    "Codex's unattended mode is marked too",
  );

  return [
    `claude modes: ${claude.options.map((o) => o.value).join(", ")} (preselected ${claude.value})`,
    `codex modes: ${codex.options.map((o) => o.value).join(", ")} (preselected ${codex.value})`,
    `unattended option colour ${bypass.color} == --stp-warn ${claude.warn}; safe option ${safe.color}`,
  ];
});

await test("20b. /v1/send carries the chosen modeId", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  await setSelect(page, "data-stp-mode", "acceptEdits");
  await page.locator("[data-stp-prompt]").fill("Rebase onto main");
  await page.locator("[data-stp-send]").click();
  await waitForPhase(page, "sent");

  const req = await lastRequest("/v1/send");
  assert(req, "expected a POST /v1/send");
  assertEq(req.body.modeId, "acceptEdits", "the mode picked in the popover must reach the bridge");
  assertEq(req.body.provider, "claude/claude-opus-5", "provider unchanged");

  // And the explicitly-picked mode is what is sent, not the resolved default.
  assert(req.body.modeId !== "auto", "the explicit choice must beat resolvedModeId");
  return [`POST /v1/send body: ${JSON.stringify(req.body)}`];
});

await test("20c. Degraded resolve: an empty pr.headBranch is UNKNOWN, not 'a different branch'", async () => {
  await bridgeReset();

  /* Control: with gh available, a rank-3 workspace on main really is a
     different branch, and the note fires. Without this the test is vacuous. */
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");
  const control = await readCandidates(page);
  const projectIndex = control.indices[control.options.findIndex((o) => o.includes("same project"))];
  assert(projectIndex >= 0, "fixture must offer a rank-3 project candidate");
  await pickCandidate(page, projectIndex);
  const withGh = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    return {
      mismatch: root.querySelector("[data-stp-branch-mismatch]")?.textContent.trim() ?? null,
      summary: root.querySelector("[data-stp-target-summary]").textContent.replace(/\s+/g, " ").trim(),
    };
  });
  assertEq(
    withGh.mismatch,
    "worktree is on a different branch",
    // Deliberately NOT "another branch of this stack": this control candidate is
    // rank 3 (`same project`) sitting on `main`, which is not in the stack at
    // all. The note used to make that claim about every existing candidate.
    "control: a genuinely different branch must still be called out, without claiming it is in the stack",
  );
  await page.keyboard.press("Escape");

  /* The regression: gh unavailable, so the bridge sends headBranch: "" — it
     deliberately never guesses. "" is not a branch this candidate differs
     from, and claiming otherwise asserts a mismatch nothing can know about. */
  await bridgeConfig({ noGh: true });
  try {
    await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
    await waitForButton(page);
    await openPopover(page);
    await waitForPhase(page, "ready");

    const degradedList = await readCandidates(page);
    const degradedIndex =
      degradedList.indices[degradedList.options.findIndex((o) => o.includes("same project"))];
    assert(degradedIndex >= 0, "the project candidate must survive a degraded resolve");
    await pickCandidate(page, degradedIndex);

    const degraded = await page.evaluate(() => {
      const root = document.querySelector("send-to-paseo-popover").shadowRoot;
      return {
        mismatch: root.querySelector("[data-stp-branch-mismatch]")?.textContent.trim() ?? null,
        summary: root
          .querySelector("[data-stp-target-summary]")
          .textContent.replace(/\s+/g, " ")
          .trim(),
        selected: root.querySelector("[data-stp-candidates]").textContent.trim(),
      };
    });

    // Anti-vacuity: the bridge really did answer with an empty headBranch, and
    // the candidate really does have a branch of its own.
    const raw = await (
      await fetch(`${BRIDGE_URL}/v1/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEFAULT_TOKEN}`,
        },
        body: JSON.stringify({ forge: "github", owner: "acmegizmos", repo: "gizmo-poc", number: 942 }),
      })
    ).json();
    assertEq(raw.pr.headBranch, "", "the degraded bridge must send an EMPTY headBranch, not a guess");
    assert(
      degraded.selected.includes("main"),
      `the selected candidate must carry a branch of its own: ${degraded.selected}`,
    );
    assertEq(
      degraded.mismatch,
      null,
      "with pr.headBranch empty nothing knows the branches differ, so the note must not render",
    );
    await shot(page, "popover-degraded-no-branch-claim", POPOVER_CLIP);
    return [
      `control (gh present): "${withGh.mismatch}"`,
      `degraded (headBranch ""): mismatch note = ${degraded.mismatch}`,
      `degraded summary: ${degraded.summary}`,
    ];
  } finally {
    await bridgeConfig({ noGh: false });
  }
});

/* ========================================================================== */
/* GitHub adapter (PLAN.md phase 6)                                           */
/*                                                                            */
/* Fixtures: test/fixtures/github-pr*.html, reproduced from the live DOM       */
/* measured in test/fixtures/github-dom-notes.md on 2026-09-01. Served by the  */
/* fixture server at GitHub's own URL shape, /{owner}/{repo}/pull/{n}[/{tab}], */
/* so these tests exercise the adapter's real URL parsing.                    */
/* ========================================================================== */

/** The measured primary anchor. Hash-suffix-tolerant, as the adapter must be. */
const GH_ACTIONS = '[class*="prc-PageHeader-Actions"]';
const GH_TITLE_AREA = '[class*="prc-PageHeader-TitleArea"]';

await test("21. GitHub: button injects into the PR header action row", async () => {
  await bridgeReset();
  await page.goto(fixtures.githubUrl(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);

  const info = await page.evaluate(
    ([sel, actionsSel]) => {
      const host = document.querySelector(sel);
      const btn = host.shadowRoot?.querySelector("button");
      const cs = btn ? getComputedStyle(btn) : null;
      return {
        mode: host.getAttribute("data-stp-mode"),
        pr: host.getAttribute("data-stp-pr"),
        style: host.getAttribute("data-stp-style"),
        marker: host.getAttribute("data-send-to-paseo"),
        parentIsActionRow: host.parentElement?.matches(actionsSel) ?? false,
        parentClass: host.parentElement?.className ?? null,
        isLastChild: host.parentElement?.lastElementChild === host,
        // The measured row is <Actions><div.d-flex.gap-2>[View status][Code]</div></Actions>,
        // so appending must land us immediately after that wrapper.
        prevText: host.previousElementSibling?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        shadowButtonText: btn?.textContent?.trim() ?? null,
        count: document.querySelectorAll(sel).length,
        css: cs
          ? {
              height: cs.height,
              borderRadius: cs.borderRadius,
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              padding: cs.padding,
              gap: cs.gap,
              background: cs.backgroundColor,
              color: cs.color,
              borderColor: cs.borderColor,
            }
          : null,
      };
    },
    [BUTTON, GH_ACTIONS],
  );

  assertEq(info.marker, "button", "marker attribute must be present");
  assertEq(info.mode, "anchored", "expected the primary (action row) anchor rung");
  assertEq(info.style, "github", "styleHint() must reach the button host");
  assertEq(info.pr, "942", "button must carry the PR number from the URL");
  assert(info.parentIsActionRow, `button must live inside ${GH_ACTIONS}, parent was ${info.parentClass}`);
  assert(info.isLastChild, "appending must put the button last in the action row");
  assert(
    info.prevText?.includes("Code"),
    `expected to sit after GitHub's Code button, previous sibling text was: ${info.prevText}`,
  );
  assertEq(info.shadowButtonText, "Send to Paseo", "shadow button label");
  assertEq(info.count, 1, "exactly one button host");

  // Metrics measured from the real "Code" button on live github.com,
  // 2026-09-01: 32px / 0 12px / gap 8px / radius 6px / 500 14px.
  assertEq(info.css.height, "32px", "GitHub branch button height");
  assertEq(info.css.borderRadius, "6px", "GitHub branch border radius");
  assertEq(info.css.fontSize, "14px", "GitHub branch font size (NOT the 12px the skeleton guessed)");
  assertEq(info.css.fontWeight, "500", "GitHub branch font weight (NOT 600)");
  assertEq(info.css.padding, "0px 12px", "GitHub branch padding");
  assertEq(info.css.gap, "8px", "GitHub branch icon gap");
  note(`button css: ${JSON.stringify(info.css)}`);

  // The button carries `transition: background 90ms ease`, so a screenshot taken
  // immediately after a colour-scheme flip catches it mid-interpolation and the
  // "dark" shot comes out a washed-out grey. Let it land first.
  const settleTheme = () => new Promise((r) => setTimeout(r, 250));
  const header = page.locator(GH_ACTIONS);
  await settleTheme();
  await shotOf(header, page, "github-injected-button-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await settleTheme();
  await shotOf(header, page, "github-injected-button-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await settleTheme();

  return [
    `appended into ${info.parentClass}, immediately after GitHub's Code button`,
    `imitates Primer's default button: ${info.css.height} / ${info.css.borderRadius} / ${info.css.fontWeight} ${info.css.fontSize}`,
  ];
});

await test("21a. GitHub: the button's colours come from GitHub's own Primer tokens", async () => {
  // The load-bearing claim in ui/styles.ts: CSS custom properties are inherited
  // properties, so GitHub's theme tokens cross our shadow boundary and the
  // button re-themes with no JS. Proven by overriding a token to a sentinel
  // value the extension's own fallback could not produce.
  //
  // settle() matters: the button carries `transition: background 90ms ease`, so
  // reading a colour immediately after a colour-scheme flip samples the
  // interpolated mid-transition value. Test 21 leaves the page having just
  // flipped dark -> light, and without this the first read came back
  // rgb(89, 94, 101) — 26% of the way from #212830 to #f6f8fa.
  const settle = () => new Promise((r) => setTimeout(r, 250));
  await settle();
  const before = await page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel).shadowRoot.querySelector("button")).backgroundColor,
    BUTTON,
  );
  assertEq(before, "rgb(246, 248, 250)", "light theme: Primer --button-default-bgColor-rest #f6f8fa");

  await page.evaluate(() => {
    document.documentElement.style.setProperty("--button-default-bgColor-rest", "rgb(1, 2, 3)");
    document.documentElement.style.setProperty("--button-default-fgColor-rest", "rgb(4, 5, 6)");
  });
  await settle();
  const after = await page.evaluate((sel) => {
    const cs = getComputedStyle(document.querySelector(sel).shadowRoot.querySelector("button"));
    return { background: cs.backgroundColor, color: cs.color };
  }, BUTTON);
  assertEq(after.background, "rgb(1, 2, 3)", "shadow button must follow GitHub's --button-default-bgColor-rest");
  assertEq(after.color, "rgb(4, 5, 6)", "shadow button must follow GitHub's --button-default-fgColor-rest");

  // Dark theme, via the media query, after clearing the sentinel.
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--button-default-bgColor-rest");
    document.documentElement.style.removeProperty("--button-default-fgColor-rest");
  });
  await settle();
  const restored = await page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel).shadowRoot.querySelector("button")).backgroundColor,
    BUTTON,
  );
  assertEq(restored, "rgb(246, 248, 250)", "sentinel cleared, back to the light token");

  await page.emulateMedia({ colorScheme: "dark" });
  await settle();
  const darkBg = await page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel).shadowRoot.querySelector("button")).backgroundColor,
    BUTTON,
  );
  await page.emulateMedia({ colorScheme: "light" });
  await settle();
  assertEq(darkBg, "rgb(33, 40, 48)", "dark theme: Primer --button-default-bgColor-rest #212830");

  return [
    "sentinel token rgb(1,2,3) on <html> reached the shadow button -> tokens really do inherit",
    "light #f6f8fa -> dark #212830 with no JS and no :host-context()",
  ];
});

await test("21b. GitHub: still injects when every Primer hash rotates", async () => {
  const read = (f) => readFileSync(join(here, "fixtures", f), "utf8");
  const normalHash = /prc-PageHeader-Actions-([A-Za-z0-9_-]{5})/.exec(read("github-pr.html"))[1];
  const rotatedHash = /prc-PageHeader-Actions-([A-Za-z0-9_-]{5})/.exec(read("github-pr-rotated.html"))[1];
  assert(normalHash !== rotatedHash, "the rotated fixture must actually have different hashes");
  note(`action-row hash ${normalHash} -> ${rotatedHash}`);

  await page.goto(fixtures.githubUrl({ fixture: "rotated" }), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  const info = await page.evaluate(
    ([sel, actionsSel]) => {
      const host = document.querySelector(sel);
      return {
        mode: host.getAttribute("data-stp-mode"),
        parentIsActionRow: host.parentElement?.matches(actionsSel) ?? false,
        parentClass: host.parentElement?.className ?? null,
        prevText: host.previousElementSibling?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      };
    },
    [BUTTON, GH_ACTIONS],
  );
  assertEq(info.mode, "anchored", "rotated fixture must still hit the primary rung");
  assert(info.parentIsActionRow, "must still find the action row after hash rotation");
  assert(
    info.parentClass.includes(rotatedHash),
    `sanity: the matched row should carry the NEW hash (${rotatedHash}), got ${info.parentClass}`,
  );
  assert(info.prevText?.includes("Code"), "still lands after the Code button");

  await shotOf(page.locator(GH_ACTIONS), page, "github-injected-button-hash-rotated");
  return [`matched prc-PageHeader-Actions-${rotatedHash} (was -${normalHash})`];
});

await test("22. GitHub: PrRef is parsed from the URL (owner / repo / number)", async () => {
  await bridgeReset();
  // A different owner and repo from every other test, so a hardcoded PrRef
  // anywhere in the pipeline would fail here.
  await page.goto(
    fixtures.githubUrl({ owner: "acme-labs", repo: "widget.factory", number: 5150 }),
    { waitUntil: "domcontentloaded" },
  );
  await waitForButton(page);
  assertEq(
    await page.evaluate((s) => document.querySelector(s).getAttribute("data-stp-pr"), BUTTON),
    "5150",
    "PR number from the URL, not from the fixture DOM (which says #942)",
  );

  await openPopover(page);
  await waitForPhase(page, "ready");
  const req = await lastRequest("/v1/resolve");
  assert(req, "expected a POST /v1/resolve");
  assertEq(req.body.forge, "github", "forge");
  assertEq(req.body.owner, "acme-labs", "owner from the URL");
  assertEq(req.body.repo, "widget.factory", "repo from the URL (dots and all)");
  assertEq(req.body.number, 5150, "number from the URL");
  assertEq(req.body.stackPrNumbers, [], "GitHub renders no stack: stackPrNumbers must be []");

  const prref = await page.evaluate(() =>
    document.querySelector("send-to-paseo-popover").shadowRoot.querySelector("[data-stp-prref]").textContent.trim(),
  );
  assertEq(prref, "acme-labs/widget.factory #5150", "popover header shows the parsed PrRef");
  await page.keyboard.press("Escape");

  return [
    `POST /v1/resolve body: ${JSON.stringify(req.body)}`,
    "the fixture DOM says #942 throughout; identity came from the URL",
  ];
});

await test("23. GitHub: the button appears on every PR sub-route", async () => {
  // Measured tab routes: "" (Conversation), /commits, /checks and /changes.
  // /files is the legacy name for /changes and still resolves, so it is here
  // too — the adapter's PR_PATH must accept any trailing segment.
  const seen = [];
  for (const tab of ["", "commits", "checks", "changes", "files"]) {
    await page.goto(fixtures.githubUrl({ tab }), { waitUntil: "domcontentloaded" });
    await waitForButton(page);
    const info = await page.evaluate(
      ([sel, actionsSel]) => {
        const host = document.querySelector(sel);
        return {
          path: location.pathname,
          mode: host.getAttribute("data-stp-mode"),
          pr: host.getAttribute("data-stp-pr"),
          inRow: host.parentElement?.matches(actionsSel) ?? false,
          count: document.querySelectorAll(sel).length,
        };
      },
      [BUTTON, GH_ACTIONS],
    );
    assertEq(info.mode, "anchored", `${info.path}: expected the primary rung`);
    assertEq(info.pr, "942", `${info.path}: PR number`);
    assert(info.inRow, `${info.path}: must be inside the action row`);
    assertEq(info.count, 1, `${info.path}: exactly one button`);
    seen.push(info.path);
  }
  note(`sub-routes covered: ${seen.join(" ")}`);
  return [`button anchored on all ${seen.length} sub-routes: ${seen.join(", ")}`];
});

await test("24. GitHub: Turbo soft navigation between PRs re-targets the button", async () => {
  await bridgeReset();
  await page.goto(fixtures.githubUrl({ number: 942 }), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  assertEq(
    await page.evaluate((s) => document.querySelector(s).getAttribute("data-stp-pr"), BUTTON),
    "942",
    "starts on 942",
  );

  // Exactly how GitHub's Turbo navigates, verified on the live site: a
  // history.pushState from the page's MAIN world. (Turbo also fires
  // soft-nav:end / turbo:load, which mainworld.ts now listens for as well; the
  // pushState alone is what makes this work, which is why this is the test.)
  await page.evaluate(() => {
    history.pushState({}, "", "/acmegizmos/gizmo-poc/pull/948");
  });

  await page.waitForFunction(
    (s) => document.querySelector(s)?.getAttribute("data-stp-pr") === "948",
    BUTTON,
    { timeout: 6000 },
  );
  const info = await page.evaluate(
    ([sel, actionsSel]) => {
      const hosts = document.querySelectorAll(sel);
      return {
        count: hosts.length,
        pr: hosts[0]?.getAttribute("data-stp-pr"),
        mode: hosts[0]?.getAttribute("data-stp-mode"),
        style: hosts[0]?.getAttribute("data-stp-style"),
        inRow: hosts[0]?.parentElement?.matches(actionsSel) ?? false,
      };
    },
    [BUTTON, GH_ACTIONS],
  );
  assertEq(info.count, 1, "exactly one button after navigation (no leak)");
  assertEq(info.pr, "948", "button re-targeted to the new PR");
  assertEq(info.mode, "anchored", "still on the primary rung");
  assertEq(info.style, "github", "still the GitHub style branch");
  assert(info.inRow, "still inside the action row");

  await openPopover(page);
  await waitForPhase(page, "ready");
  const req = await lastRequest("/v1/resolve");
  assertEq(req.body.number, 948, "the next /v1/resolve must use the NEW PR number");
  assertEq(req.body.owner, "acmegizmos", "owner unchanged");
  assertEq(req.body.stackPrNumbers, [], "still []");
  const prref = await page.evaluate(() =>
    document.querySelector("send-to-paseo-popover").shadowRoot.querySelector("[data-stp-prref]").textContent.trim(),
  );
  assertEq(prref, "acmegizmos/gizmo-poc #948", "popover header follows the new PR");
  await page.keyboard.press("Escape");

  return ["pushState 942 -> 948 re-targeted the button and the next resolve"];
});

await test("25. GitHub: fallback rung when the action row is missing", async () => {
  await page.goto(fixtures.githubUrl({ fixture: "no-actions" }), { waitUntil: "domcontentloaded" });
  await waitForButton(page);

  const fb = await page.evaluate(
    ([sel, actionsSel, titleSel]) => {
      const host = document.querySelector(sel);
      const titleAreas = [...document.querySelectorAll(titleSel)];
      return {
        mode: host.getAttribute("data-stp-mode"),
        pr: host.getAttribute("data-stp-pr"),
        noActionRow: document.querySelectorAll(actionsSel).length,
        noLegacyActions: document.querySelectorAll(".gh-header-actions").length,
        titleAreaCount: titleAreas.length,
        parentIsTitleArea: host.parentElement === titleAreas[0],
        parentClass: host.parentElement?.className ?? null,
      };
    },
    [BUTTON, GH_ACTIONS, GH_TITLE_AREA],
  );

  assertEq(
    [fb.noActionRow, fb.noLegacyActions],
    [0, 0],
    "fixture must genuinely lack BOTH primary rungs",
  );
  assertEq(fb.mode, "anchored-fallback", "expected the fallback rung, not floating");
  assertEq(fb.pr, "942", "still parses the PR from the URL");
  assert(fb.parentIsTitleArea, `expected the title area, got ${fb.parentClass}`);
  await shotOf(page.locator(GH_TITLE_AREA).first(), page, "github-anchored-fallback");
  note(`fallback anchor: ${fb.parentClass}`);

  // And the legacy Rails action row, if it ever comes back, out-ranks the
  // fallback: inserting one must promote the button to the primary rung. This
  // is the only exercise of rung 2, which was never observed on live github.com
  // in 2026-09 — see test/fixtures/github-dom-notes.md.
  await page.evaluate(() => {
    const frame = document.querySelector("#repo-content-turbo-frame");
    const legacy = document.createElement("div");
    legacy.id = "partial-discussion-header";
    legacy.innerHTML = '<div class="gh-header-actions"><button>Edit</button></div>';
    frame.prepend(legacy);
  });
  await page.waitForFunction(
    (s) => document.querySelector(s)?.getAttribute("data-stp-mode") === "anchored",
    BUTTON,
    { timeout: 6000 },
  );
  const promoted = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    return {
      mode: host.getAttribute("data-stp-mode"),
      parentClass: host.parentElement?.className ?? null,
      count: document.querySelectorAll(sel).length,
    };
  }, BUTTON);
  assertEq(promoted.mode, "anchored", "legacy .gh-header-actions is a primary rung");
  assertEq(promoted.parentClass, "gh-header-actions", "button relocated into the legacy action row");
  assertEq(promoted.count, 1, "relocation must move the button, not clone it");

  return [
    `no-actions fixture -> anchored-fallback on ${fb.parentClass}`,
    "injecting a legacy .gh-header-actions promotes the button back to the primary rung (1 host, relocated)",
  ];
});

await test("26. GitHub: floating fallback, and no stack is invented from PR hrefs", async () => {
  await bridgeReset();
  await page.goto(fixtures.githubUrl({ fixture: "no-anchor" }), { waitUntil: "domcontentloaded" });
  await waitForButton(page);

  const info = await page.evaluate(
    ([sel, actionsSel, titleSel]) => {
      const host = document.querySelector(sel);
      const cs = getComputedStyle(host);
      return {
        mode: host.getAttribute("data-stp-mode"),
        style: host.getAttribute("data-stp-style"),
        floating: host.getAttribute("data-stp-floating"),
        parentIsBody: host.parentElement === document.body,
        position: cs.position,
        right: cs.right,
        bottom: cs.bottom,
        pr: host.getAttribute("data-stp-pr"),
        rungsGone: [
          document.querySelectorAll(actionsSel).length,
          document.querySelectorAll(".gh-header-actions").length,
          document.querySelectorAll(titleSel).length,
          document.querySelectorAll('nav[aria-label="Pull request navigation"]').length,
          document.querySelectorAll("#partial-discussion-header").length,
        ],
        pullLinks: [...document.querySelectorAll('a[href*="/pull/"]')].map((a) => a.getAttribute("href")),
      };
    },
    [BUTTON, GH_ACTIONS, GH_TITLE_AREA],
  );

  assertEq(info.rungsGone, [0, 0, 0, 0, 0], "fixture must genuinely lack every rung of the ladder");
  assertEq(info.mode, "floating", "expected the floating fallback mode");
  assertEq(info.style, "github", "the GitHub style branch still applies when floating");
  assertEq(info.floating, "true", "floating attribute");
  assert(info.parentIsBody, "floating button attaches to <body>");
  assertEq(info.position, "fixed", "floating button must be position:fixed");
  assertEq(info.pr, "942", "still parses the PR from the URL");

  // The anti-scrape guard. This fixture deliberately contains PR links; a
  // GitHub adapter that copied Graphite's href scrape would report a stack.
  assert(info.pullLinks.length >= 3, `fixture must contain PR links, found ${info.pullLinks.length}`);
  await openPopover(page);
  await waitForPhase(page, "ready");
  const req = await lastRequest("/v1/resolve");
  assertEq(
    req.body.stackPrNumbers,
    [],
    `stackPrNumbers must stay [] despite ${info.pullLinks.length} /pull/ links on the page`,
  );
  await page.keyboard.press("Escape");

  await shot(page, "github-floating-fallback");
  return [
    `position:${info.position} right:${info.right} bottom:${info.bottom}`,
    `page hrefs present (${info.pullLinks.join(", ")}) but stackPrNumbers = []`,
  ];
});

await test("27. GitHub: popover resolves and sends with the right payload", async () => {
  await bridgeReset();
  await page.goto(fixtures.githubUrl(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  const resolve = await lastRequest("/v1/resolve");
  assert(resolve, "expected a POST /v1/resolve");
  assert(resolve.hasAuth, "resolve must carry the bearer token (added by the service worker)");
  assertEq(
    resolve.body,
    { forge: "github", owner: "acmegizmos", repo: "gizmo-poc", number: 942, stackPrNumbers: [] },
    "resolve body for a GitHub PR page",
  );

  const ghCands = await readCandidates(page);
  const ui = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    return {
      prref: root.querySelector("[data-stp-prref]").textContent.trim(),
      summary: root.querySelector("[data-stp-target-summary]").textContent.replace(/\s+/g, " ").trim(),
      selected: root.querySelector("[data-stp-candidates]").textContent.trim(),
    };
  });
  ui.options = ghCands.options;
  assertEq(ui.prref, "acmegizmos/gizmo-poc #942", "PR reference");
  assert(ui.summary.includes("brawny-dodo"), `PR 942 has an exact workspace match: ${ui.summary}`);
  // With stackPrNumbers: [] the mock offers no rank-2 candidate, which is
  // exactly the documented consequence of not scraping on GitHub.
  assert(
    !ui.options.some((o) => o.includes("stack")),
    `no rank-2 stack candidate is expected when stackPrNumbers is []: ${ui.options.join(" | ")}`,
  );
  await shot(page, "github-popover-open", POPOVER_CLIP);

  const prompt = "Rebase this onto main and fix the flaky diff test";
  await page.locator("[data-stp-prompt]").fill(prompt);
  await page.locator("[data-stp-send]").click();
  await waitForPhase(page, "sent");

  const send = await lastRequest("/v1/send");
  assert(send, "expected a POST /v1/send");
  assert(send.hasAuth, "send must carry the bearer token");
  assertEq(send.body.forge, "github", "forge");
  assertEq(send.body.owner, "acmegizmos", "owner");
  assertEq(send.body.repo, "gizmo-poc", "repo");
  assertEq(send.body.number, 942, "number");
  assertEq(send.body.prompt, prompt, "prompt is passed through verbatim");
  assertEq(send.body.target, { kind: "existing", workspaceId: "wks_4d1a8b7c2e0f9351" }, "target");
  assert(
    send.body.pageUrl?.includes("/acmegizmos/gizmo-poc/pull/942"),
    `pageUrl should be the GitHub page URL, got ${send.body.pageUrl}`,
  );
  assertEq(send.body.modeId, "auto", "modeId (the bridge's resolvedModeId, preselected)");
  assertEq(
    Object.keys(send.body).sort(),
    ["forge", "modeId", "number", "owner", "pageUrl", "prompt", "provider", "repo", "target"],
    "send body keys",
  );

  const href = await page.evaluate(() =>
    document.querySelector("send-to-paseo-popover").shadowRoot.querySelector("[data-stp-deeplink]").getAttribute("href"),
  );
  assert(
    /^paseo:\/\/h\/[^/]+\/agent\/[^/]+$/.test(href),
    `deep link must match paseo://h/<serverId>/agent/<agentId>, got: ${href}`,
  );

  return [
    `POST /v1/resolve body: ${JSON.stringify(resolve.body)}`,
    `POST /v1/send body: ${JSON.stringify(send.body)}`,
  ];
});

/**
 * A faithful stand-in for GitHub's shortcut layer, as measured on live
 * github.com on 2026-09-01 by instrumenting addEventListener from
 * document_start (390 key-listener registrations in total):
 *
 *   keydown on document CAPTURE  45
 *   keydown on document bubble   20
 *   keydown on window  CAPTURE    2
 *   keydown on window  bubble     0     <- none, unlike Graphite
 *   keydown on body    either      0
 *
 * Registered by, among others, @github/hotkey (hotkey.js) — the global
 * single-key layer behind `s`, `/`, `c`, `t`, `g c`, `j`/`k` — plus
 * primer-react.js, catalyst.js and behaviors.js.
 *
 * The `isFormField` guard below mirrors @github/hotkey's own: it asks the
 * event target whether it is a text field. Shadow-DOM retargeting is what
 * makes that hostile — a listener outside our shadow root sees
 * event.target === <send-to-paseo-popover>, an unknown custom element, so the
 * guard answers "no" and every real keystroke is treated as a shortcut.
 *
 * Only the BUBBLE handlers act, mirroring the measurement: the capture-phase
 * handlers on the live site fire and take no action. See
 * extension/src/content/ui/keyboard.ts for why capture is unreachable.
 */
async function installHostileGithubShortcuts(page) {
  await page.evaluate(() => {
    const state = { bubble: [], capture: [], targets: [] };
    window.__hostileGh = state;
    const thief = document.createElement("input");
    thief.id = "__hostile_thief_gh";
    document.body.appendChild(thief);

    // @github/hotkey's isFormField, near enough.
    const isFormField = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const name = node.nodeName.toLowerCase();
      const type = (node.getAttribute?.("type") ?? "").toLowerCase();
      return (
        name === "select" ||
        name === "textarea" ||
        (name === "input" && type !== "submit" && type !== "reset" && type !== "checkbox" && type !== "radio") ||
        node.isContentEditable === true ||
        node.getAttribute?.("role") === "textbox"
      );
    };

    const handler = (phase, destructive) => (ev) => {
      const t = ev.target;
      state.targets.push(t && t.tagName ? t.tagName.toLowerCase() : String(t));
      if (isFormField(t)) return; // a real text field: hotkey backs off
      state[phase].push(ev.key); // ... otherwise it is "a shortcut"
      if (destructive) {
        ev.preventDefault();
        thief.focus();
      }
    };

    document.addEventListener("keydown", handler("capture", false), true);
    document.addEventListener("keydown", handler("bubble", true), false);
    window.addEventListener("keydown", handler("capture", false), true);
  });
}

/**
 * Every token here is a live GitHub single-key shortcut: s (search),
 * / (search), c (create), g (prefix, e.g. g c / g p), p, t (file finder),
 * r (quote reply), j / k (list navigation).
 */
const GITHUB_HOSTILE_KEYS = "Fix flaky test? s / c g p t r j k";

await test("28. GitHub: host-page keyboard shortcuts cannot reach the popover (regression)", async () => {
  await bridgeReset();
  await page.goto(fixtures.githubUrl(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");
  await installHostileGithubShortcuts(page);

  const prompt = GITHUB_HOSTILE_KEYS;
  await page.locator("[data-stp-prompt]").click();
  // REAL keystrokes. locator.fill() assigns .value and dispatches no key events
  // at all, which is precisely why the original containment bug reached a user.
  await page.keyboard.type(prompt, { delay: 5 });

  const observed = await page.evaluate(() => {
    const host = document.querySelector("send-to-paseo-popover");
    const ta = host?.shadowRoot?.querySelector("[data-stp-prompt]");
    return {
      value: ta ? ta.value : null,
      focusInPopover: !!ta && document.activeElement === host && host.shadowRoot.activeElement === ta,
      focusStolen: document.activeElement?.id === "__hostile_thief_gh",
      bubbleShortcuts: window.__hostileGh.bubble.length,
      captureShortcuts: window.__hostileGh.capture.length,
      sawRetargetedHost: window.__hostileGh.targets.includes("send-to-paseo-popover"),
      popoverStillOpen: !!host,
    };
  });

  // Anti-vacuity guard 1: the hostile listeners really were reached and really
  // did see the retargeted shadow host.
  assert(
    observed.sawRetargetedHost,
    "test is vacuous: the hostile listeners never saw the retargeted shadow host",
  );

  assertEq(observed.value, prompt, "keystrokes must reach the textarea byte-for-byte");
  assert(observed.popoverStillOpen, "popover must survive typing");
  assert(observed.focusInPopover, "focus must stay on the textarea while typing");
  assert(!observed.focusStolen, "GitHub must not be able to steal focus mid-prompt");
  assertEq(
    observed.bubbleShortcuts,
    0,
    "no keystroke may reach a bubble-phase page listener (this is the bug being regression-tested)",
  );

  // Documented ceiling, not a defect.
  note(
    `capture-phase page listeners still observed ${observed.captureShortcuts} keystrokes ` +
      `(expected and unavoidable); bubble-phase: ${observed.bubbleShortcuts}`,
  );

  await shot(page, "github-keyboard-containment-typed", POPOVER_CLIP);
  return [
    `typed "${prompt}" with real keystrokes; value byte-exact, focus retained`,
    `bubble-phase hits: ${observed.bubbleShortcuts} · capture-phase hits: ${observed.captureShortcuts}`,
  ];
});

await test("28b. GitHub: the Target SEARCH BOX is contained too (real keystrokes)", async () => {
  await bridgeReset();
  await page.goto(fixtures.githubUrl(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");
  await installHostileGithubShortcuts(page);

  // Same argument as 19b, against @github/hotkey's guard instead of Graphite's.
  // `/` and `s` are the two that hurt most here: both focus GitHub's search.
  await openCandidates(page);
  await page.keyboard.type(GITHUB_HOSTILE_KEYS, { delay: 5 });

  const observed = await page.evaluate(() => {
    const host = document.querySelector("send-to-paseo-popover");
    const root = host?.shadowRoot;
    const input = root?.querySelector("[data-stp-combo-search]");
    return {
      value: input ? input.value : null,
      focusInSearch: !!input && document.activeElement === host && root.activeElement === input,
      focusStolen: document.activeElement?.id === "__hostile_thief_gh",
      bubbleShortcuts: window.__hostileGh.bubble.length,
      captureShortcuts: window.__hostileGh.capture.length,
      sawRetargetedHost: window.__hostileGh.targets.includes("send-to-paseo-popover"),
      popoverStillOpen: !!host,
      dropdownStillOpen:
        root?.querySelector("[data-stp-combobox]")?.getAttribute("data-stp-combo-open") === "true",
    };
  });

  assert(
    observed.sawRetargetedHost,
    "test is vacuous: the hostile listeners never saw the retargeted shadow host",
  );
  assertEq(observed.value, GITHUB_HOSTILE_KEYS, "keystrokes must reach the search box byte-for-byte");
  assert(observed.popoverStillOpen, "popover must survive typing in the search box");
  assert(observed.dropdownStillOpen, "the dropdown must survive a barrage of shortcut keys");
  assert(observed.focusInSearch, "focus must stay in the search box while typing");
  assert(!observed.focusStolen, "GitHub must not be able to steal focus mid-search");
  assertEq(observed.bubbleShortcuts, 0, "no keystroke may reach a bubble-phase page listener");

  // The dropdown is drawn from the same --stp-* tokens on both sites, so this
  // is also the GitHub half of the light/dark visual check.
  await searchCandidates(page, "dodo");
  await shot(page, "github-popover-combobox-open-light", POPOVER_CLIP);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "github-popover-combobox-open-dark", POPOVER_CLIP);
  await page.emulateMedia({ colorScheme: "light" });

  note(
    `capture-phase page listeners still observed ${observed.captureShortcuts} keystrokes ` +
      `(expected and unavoidable); bubble-phase: ${observed.bubbleShortcuts}`,
  );
  return [
    `typed "${GITHUB_HOSTILE_KEYS}" into the Target search box with real keystrokes; value byte-exact`,
    `bubble-phase hits: ${observed.bubbleShortcuts} · capture-phase hits: ${observed.captureShortcuts}`,
  ];
});

/* ---- 29-32. the searchable Target combobox ------------------------------ */
/*
 * The Target picker used to be a native <select>: 4 rows here, but dozens in a
 * real Paseo install, with no way to type at it. These four cases are the ones
 * that could not pass on that widget at all.
 *
 * Fixture candidate indices for PR 942 (test/mock-bridge.mjs):
 *   0  brawny-dodo             giz-1133-widget-backed-inventory-audit-rule  exact match
 *   1  candid-otter            giz-1132-stack-sibling-949                   stack #949
 *   2  gizmo-poc (main checkout)  main                                     same project
 *   3  Create worktree for PR #942
 */

await test("29. Target combobox: searching by WORKSPACE NAME narrows, commits, and reaches /v1/send", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  const before = await candidateTrigger(page);
  assert(before.includes("brawny-dodo"), `the default target must be the rank-1 workspace: ${before}`);

  // "otter" appears in no branch, no reason tag and no PR number — only in the
  // workspace label `candid-otter`. Searching by workspace name is the thing
  // that was asked for, so it gets the unambiguous probe.
  await searchCandidates(page, "otter");
  const filtered = await readCandidates(page, { close: false });
  assertEq(
    filtered.options.length,
    1,
    `"otter" must narrow to one row, got: ${filtered.options.join(" | ")}`,
  );
  assert(filtered.options[0].includes("candid-otter"), `surviving row: ${filtered.options[0]}`);
  assertEq(filtered.indices, [1], "a filtered row keeps its own candidate index");
  assertEq(filtered.selectedIndex, -1, "the committed candidate is filtered out, so nothing is aria-selected");
  assertEq(filtered.activeIndex, 1, "the only match becomes active, so Enter commits it");
  await shot(page, "popover-candidate-search-by-name", POPOVER_CLIP);

  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document
        .querySelector("send-to-paseo-popover")
        .shadowRoot.querySelector("[data-stp-candidates]")
        .textContent.includes("candid-otter"),
    undefined,
    { timeout: 4000 },
  );
  assertEq(await candidatesOpen(page), false, "committing closes the dropdown");

  const after = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    return {
      summary: root.querySelector("[data-stp-target-summary]").textContent.replace(/\s+/g, " ").trim(),
      promptFocused: root.activeElement?.hasAttribute("data-stp-prompt") === true,
    };
  });
  assert(
    after.summary.includes("workspace candid-otter"),
    `the target summary must follow the commit: ${after.summary}`,
  );
  assert(after.summary.includes("stack #949"), `and keep saying which stack PR it matched: ${after.summary}`);
  assert(after.promptFocused, "committing hands focus to the instruction box");

  await page.locator("[data-stp-prompt]").fill("Rebase this sibling onto main");
  await page.locator("[data-stp-send]").click();
  await waitForPhase(page, "sent");
  const send = await lastRequest("/v1/send");
  assertEq(
    send.body.target,
    { kind: "existing", workspaceId: "wks_7b3e5c9a1d8f6042" },
    "the searched-for workspace must be the send target, not the default one",
  );

  return [
    `typed "otter" -> 1 row (${filtered.options[0]})`,
    `summary after commit: ${after.summary}`,
    `POST /v1/send target: ${JSON.stringify(send.body.target)}`,
  ];
});

await test("30. Target combobox: branch fragment, bare PR number, multi-word, and no match", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  /* Each query must narrow to exactly the listed candidate indices. */
  const cases = [
    ["sibling", [1], "a branch fragment (giz-1132-stack-sibling-949)"],
    ["1133", [0, 3], "a branch fragment shared by two candidates"],
    ["949", [1], "a bare PR number, no hash"],
    ["#949", [1], "the same PR number with a hash"],
    ["942", [3], "the create row's PR number, bare"],
    ["#942", [3], "and with a hash"],
    ["exact", [0], "the reason tag"],
    ["same project", [2], "a two-word reason tag"],
    ["main", [2], "a branch name"],
    ["create", [3], "the create row by intent, not by its wording"],
    ["DODO", [0], "case-insensitive"],
    ["otter stack", [1], "two tokens: one from the label, one from the tag"],
    ["stack otter", [1], "the same two tokens in the other order"],
  ];

  const observed = [];
  for (const [query, want, why] of cases) {
    await searchCandidates(page, query);
    const got = await readCandidates(page, { close: false });
    assertEq(got.indices, want, `"${query}" (${why}) -> ${got.options.join(" | ") || "<no rows>"}`);
    assert(!got.emptyShown, `"${query}" matched, so the empty row must be hidden`);
    observed.push(`"${query}" -> [${got.indices.join(",")}]`);
  }

  /* A query that matches nothing: visible empty row, and the selection stands. */
  await searchCandidates(page, "zzzznope");
  const none = await readCandidates(page, { close: false });
  assertEq(none.options.length, 0, "no rows may survive a query that matches nothing");
  assert(none.emptyShown, "the empty row must be visible");
  assertEq(none.emptyText, "No workspace matches", "the empty row's wording");
  assertEq(none.activeIndex, -1, "nothing can be active when nothing matches");
  assertEq(none.activeDescendant, null, "aria-activedescendant must be dropped, not left stale");
  await shot(page, "popover-candidate-search-no-match", POPOVER_CLIP);

  // Enter here must do nothing at all — not commit, not close, not blank the
  // target. Committing "the first row" when there is no first row was the easy
  // bug to write.
  await page.keyboard.press("Enter");
  assert(await candidatesOpen(page), "Enter on an empty result set must not close the dropdown");
  const unchanged = await candidateTrigger(page);
  assert(
    unchanged.includes("brawny-dodo"),
    `a query matching nothing must not change the selection: ${unchanged}`,
  );
  await closeCandidates(page);

  return [...observed, `"zzzznope" -> empty row "${none.emptyText}", selection still ${unchanged}`];
});

await test("31. Target combobox: keyboard-only path — reach, filter, arrow, Enter, then Cmd/Ctrl+Enter", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  /* From here on: no mouse. The textarea is autofocused, so type the
     instruction first and then walk BACKWARD into the Target field, which sits
     above it in the card. */
  const prompt = "Fix the merge conflict";
  await page.keyboard.type(prompt, { delay: 5 });
  await page.keyboard.press("Shift+Tab");
  const onTrigger = await page.evaluate(
    () =>
      document.querySelector("send-to-paseo-popover").shadowRoot.activeElement?.hasAttribute(
        "data-stp-candidates",
      ) === true,
  );
  assert(onTrigger, "Shift+Tab from the instruction box must land on the Target trigger");

  /* ArrowDown opens the list on the committed option, and the list wraps. */
  await page.keyboard.press("ArrowDown");
  assertEq((await readCandidates(page, { close: false })).activeIndex, 0, "opens active on the committed candidate");
  await page.keyboard.press("ArrowUp");
  assertEq((await readCandidates(page, { close: false })).activeIndex, 3, "ArrowUp from the first row wraps to the last");
  await page.keyboard.press("ArrowDown");
  assertEq((await readCandidates(page, { close: false })).activeIndex, 0, "ArrowDown from the last row wraps to the first");
  await page.keyboard.press("End");
  assertEq((await readCandidates(page, { close: false })).activeIndex, 3, "End jumps to the last row");
  await page.keyboard.press("Home");
  const home = await readCandidates(page, { close: false });
  assertEq(home.activeIndex, 0, "Home jumps to the first row");
  assertEq(home.activeDescendant, home.activeRowId, "aria-activedescendant tracks every move");

  /* Filter to two rows, arrow onto the second, commit it. Two rows so the
     ArrowDown genuinely decides something. */
  await page.keyboard.type("1133", { delay: 5 });
  const two = await readCandidates(page, { close: false });
  assertEq(two.indices, [0, 3], `"1133" should leave the two candidates on that branch: ${two.options.join(" | ")}`);
  assertEq(two.activeIndex, 0, "the first match is active after typing");
  await page.keyboard.press("ArrowDown");
  assertEq((await readCandidates(page, { close: false })).activeIndex, 3, "ArrowDown moves within the FILTERED rows");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document
        .querySelector("send-to-paseo-popover")
        .shadowRoot.querySelector("[data-stp-candidates]")
        .textContent.includes("Create worktree"),
    undefined,
    { timeout: 4000 },
  );

  /* Focus is back on the instruction box, which is what lets the same hand
     finish with Cmd/Ctrl+Enter and no click anywhere. */
  const state = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    return {
      promptFocused: root.activeElement?.hasAttribute("data-stp-prompt") === true,
      draft: root.querySelector("[data-stp-prompt]").value,
      summary: root.querySelector("[data-stp-target-summary]").textContent.replace(/\s+/g, " ").trim(),
    };
  });
  assert(state.promptFocused, "after a keyboard commit, focus must be on the instruction box");
  assertEq(state.draft, prompt, "the draft must survive the re-render a commit causes");
  assert(
    state.summary.includes("will create worktree for PR #942"),
    `the keyboard-picked candidate must be the live target: ${state.summary}`,
  );

  const chord = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
  await page.keyboard.press(chord);
  await waitForPhase(page, "sent", 8000);
  const send = await lastRequest("/v1/send");
  assertEq(send.body.prompt, prompt, `${chord} must submit the typed prompt`);
  assertEq(send.body.target, { kind: "create" }, "and the target picked with the keyboard");

  return [
    "no mouse after the button click: Shift+Tab -> ArrowDown/ArrowUp/End/Home -> type -> ArrowDown -> Enter",
    `wrapping asserted at both ends; filtered arrowing stays inside the 2 matching rows`,
    `${chord} produced POST /v1/send ${JSON.stringify({ prompt: send.body.prompt, target: send.body.target })}`,
  ];
});

await test("32. Target combobox: Esc and click-outside dismiss the dropdown BEFORE the popover", async () => {
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  /* Esc, layer 1: the dropdown only. The popover's Esc listener is
     document-level and capturing, so it sees the key first and has to defer. */
  await openCandidates(page);
  await page.keyboard.press("Escape");
  assertEq(await candidatesOpen(page), false, "the first Escape must close the dropdown");
  assertEq(
    await page.evaluate((s) => document.querySelectorAll(s).length, POPOVER),
    1,
    "...and must leave the popover open",
  );
  const refocused = await page.evaluate(
    () =>
      document.querySelector("send-to-paseo-popover").shadowRoot.activeElement?.hasAttribute(
        "data-stp-candidates",
      ) === true,
  );
  assert(refocused, "closing the dropdown returns focus to the trigger, not to nothing");

  /* Esc, layer 2: the popover. */
  await page.keyboard.press("Escape");
  await page.waitForSelector(POPOVER, { state: "detached", timeout: 4000 });
  note("Escape, Escape: dropdown then popover");

  /* Click-outside layers the same way. A pointerdown inside the card is inside
     the shadow host, so the popover survives — but anywhere outside the
     dropdown still dismisses the dropdown. */
  await openPopover(page);
  await waitForPhase(page, "ready");
  await openCandidates(page);
  await page.locator("[data-stp-prompt]").click();
  assertEq(await candidatesOpen(page), false, "a pointerdown elsewhere in the card closes the dropdown");
  assertEq(
    await page.evaluate((s) => document.querySelectorAll(s).length, POPOVER),
    1,
    "...and the popover survives it, because the click was inside the host",
  );

  /* And a pointerdown inside the dropdown closes neither. */
  await openCandidates(page);
  await page.locator("[data-stp-combo-search]").click();
  assertEq(await candidatesOpen(page), true, "clicking the search box must not close the dropdown");
  assertEq(
    await page.evaluate((s) => document.querySelectorAll(s).length, POPOVER),
    1,
    "nor the popover",
  );

  /* Outside everything: the whole popover goes, dropdown and all. */
  await page.mouse.click(60, 700);
  await page.waitForSelector(POPOVER, { state: "detached", timeout: 4000 });

  return [
    "Esc #1 closed the dropdown and refocused the trigger; Esc #2 detached the popover",
    "pointerdown on the textarea closed the dropdown only; pointerdown in the dropdown closed nothing",
    "pointerdown outside the card detached the popover with the dropdown open",
  ];
});

await test("33. A stack workspace on a MERGED branch is the default, and says it has landed", async () => {
  // The reported field bug, from the popover's side. The user opened a PR in a
  // stack whose only workspace was parked on a branch that had already been
  // merged; the bridge could not see it as a stack member, so it ranked as
  // "same project" and the default fell through to "create a worktree".
  //
  // The bridge fix is plugin-side (merged/closed PRs in the stack graph, plus a
  // local ancestry test). What this case pins is the half the extension owns:
  // a rank-2 candidate carrying `stackPrState: "merged"` must be the DEFAULT,
  // must be findable by typing "merged", and must not be described as a live
  // sibling — "another branch of this stack" reads as still-open work.
  await bridgeReset();
  await bridgeConfig({ mergedStack: true });
  try {
    await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
    await waitForButton(page);
    await openPopover(page);
    await waitForPhase(page, "ready");

    const trigger = await candidateTrigger(page);
    assert(
      /candid-otter/.test(trigger) && !/Create worktree/i.test(trigger),
      `the merged stack workspace must be the default, not a new worktree: ${trigger}`,
    );
    assert(
      /,\s*merged/.test(trigger),
      `the committed label must say the stack PR has merged: ${trigger}`,
    );

    const ui = await page.evaluate(() => {
      const root = document.querySelector("send-to-paseo-popover").shadowRoot;
      return {
        summary: root
          .querySelector("[data-stp-target-summary]")
          .textContent.replace(/\s+/g, " ")
          .trim(),
        mismatch: root.querySelector("[data-stp-branch-mismatch]")?.textContent.trim() ?? null,
      };
    });
    assert(
      /stack #\d+, merged/.test(ui.summary),
      `the resolved-target line must name the merged stack PR: ${ui.summary}`,
    );
    assertEq(
      ui.mismatch,
      "worktree is on a branch of this stack whose PR is merged",
      "a landed branch must not be described as another (live) branch of the stack",
    );

    // The state reaches the search haystack through the reason tag, so a user
    // who knows the worktree is parked on merged work can type that word.
    const hit = await searchCandidates(page, "merged");
    assert(hit !== null, "search box must accept the query");
    const found = await readCandidates(page, { close: false });
    assertEq(found.options.length, 1, `"merged" must narrow to one candidate: ${found.options}`);
    assert(
      /candid-otter/.test(found.options[0]),
      `"merged" must find the merged stack workspace: ${found.options[0]}`,
    );
    await shot(page, "popover-stack-merged-default");
    await closeCandidates(page);

    // Still offered, still not the default — the product rule is unchanged.
    const all = await readCandidates(page);
    assert(
      all.options.some((o) => /Create worktree/i.test(o)),
      "creating a worktree must still be offered",
    );

    await page.keyboard.press("Escape");
    return [
      `default target: ${trigger}`,
      `summary: ${ui.summary}`,
      `note: ${ui.mismatch}`,
      `search "merged" -> ${found.options.length} candidate`,
    ];
  } finally {
    await bridgeConfig({ mergedStack: false });
  }
});

await test("34. Header cog opens the options page, in every phase, without closing the popover", async () => {
  // Until now the options page was reachable only from the browser's own
  // extensions menu, or from the error state's link — i.e. exactly when the
  // user had already hit a wall. The cog is in the header in every phase.
  await bridgeReset();
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");

  const cog = await page.evaluate(() => {
    const root = document.querySelector("send-to-paseo-popover").shadowRoot;
    const btn = root.querySelector("[data-stp-open-settings]");
    if (!btn) return null;
    const svg = btn.querySelector("svg");
    const box = btn.getBoundingClientRect();
    const header = root.querySelector("header").getBoundingClientRect();
    return {
      tag: btn.tagName.toLowerCase(),
      type: btn.getAttribute("type"),
      label: btn.getAttribute("aria-label"),
      title: btn.getAttribute("title"),
      // An icon-only control with no accessible name is unusable; and a decorative
      // glyph left in the accessibility tree would read out as noise beside it.
      svgNamespace: svg?.namespaceURI ?? null,
      svgHidden: svg?.getAttribute("aria-hidden") ?? null,
      // Built as nodes, never as markup: github.com enforces Trusted Types and a
      // content script shares its document with the page.
      usesMarkup: /[<>]/.test(btn.innerHTML.replace(/<\/?(svg|circle|path)\b[^>]*>/g, "")),
      width: Math.round(box.width),
      height: Math.round(box.height),
      insideHeader: box.top >= header.top - 0.5 && box.bottom <= header.bottom + 0.5,
    };
  });
  assert(cog !== null, "the header must carry a settings cog");
  assertEq(cog.tag, "button", "the cog must be a real button, so Enter and Space work for free");
  assertEq(cog.type, "button", "a bare <button> in a form context would submit");
  assertEq(cog.label, "Extension settings", "an icon-only control needs an accessible name");
  assertEq(cog.title, "Extension settings", "and a tooltip, since the glyph alone is ambiguous");
  assertEq(cog.svgNamespace, "http://www.w3.org/2000/svg", "the glyph must be a real SVG node");
  assertEq(cog.svgHidden, "true", "a decorative glyph must be out of the accessibility tree");
  assert(!cog.usesMarkup, "the glyph must be built as nodes, not assigned as markup");
  assert(
    cog.insideHeader && cog.height <= 24,
    `the cog must sit inside the header without growing it: ${JSON.stringify(cog)}`,
  );

  /* It is present in every phase, not just `ready` — the header is rendered by
     the same code path in all of them, and that is worth pinning. */
  const phases = {};
  phases.ready = true;
  await bridgeConfig({ contract: 2 });
  try {
    await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
    await waitForButton(page);
    await openPopover(page);
    await waitForPhase(page, "error");
    phases.error = await page.evaluate(() =>
      Boolean(
        document
          .querySelector("send-to-paseo-popover")
          .shadowRoot.querySelector("[data-stp-open-settings]"),
      ),
    );
    await page.keyboard.press("Escape");
  } finally {
    await bridgeConfig({ contract: 1 });
  }
  assert(phases.error, "the cog must be there in the error phase too");

  /* The real assertion: clicking it actually opens the options page, and the
     popover survives — `openOptionsPage()` opens a new tab, so closing would
     only discard a typed instruction. */
  await page.goto(fixtures.url(), { waitUntil: "domcontentloaded" });
  await waitForButton(page);
  await openPopover(page);
  await waitForPhase(page, "ready");
  await page.locator("[data-stp-prompt]").fill("Draft that must survive");
  const before = context.pages().length;
  const opened = context.waitForEvent("page", { timeout: 8000 });
  await page.locator("[data-stp-open-settings]").click();
  const optionsPage = await opened;
  await optionsPage.waitForLoadState("domcontentloaded");
  const openedUrl = optionsPage.url();
  const survived = await page.evaluate(() => {
    const host = document.querySelector("send-to-paseo-popover");
    return {
      present: Boolean(host),
      phase: host?.getAttribute("data-stp-phase") ?? null,
      draft: host?.shadowRoot?.querySelector("[data-stp-prompt]")?.value ?? null,
    };
  });
  await optionsPage.close();

  assertEq(openedUrl, optionsUrl(), "the cog must open the extension's own options page");
  assert(survived.present, "the popover must not close when the cog is pressed");
  assertEq(survived.phase, "ready", "and must stay in the phase it was in");
  assertEq(survived.draft, "Draft that must survive", "a typed instruction must survive");

  /* Keyboard: it is in the header, before the Target trigger in DOM order, so
     it must be reachable and activate on Enter like any button. */
  const openedByKey = context.waitForEvent("page", { timeout: 8000 });
  await page.locator("[data-stp-open-settings]").focus();
  const focused = await page.evaluate(() =>
    document
      .querySelector("send-to-paseo-popover")
      .shadowRoot.activeElement?.getAttribute("data-stp-open-settings") === "",
  );
  await page.keyboard.press("Enter");
  const byKey = await openedByKey;
  await byKey.waitForLoadState("domcontentloaded");
  const keyUrl = byKey.url();
  await byKey.close();
  assert(focused, "the cog must be focusable inside the shadow root");
  assertEq(keyUrl, optionsUrl(), "Enter on the focused cog must open the options page");

  await shot(page, "popover-header-settings-cog");
  await page.keyboard.press("Escape");
  return [
    `cog: <${cog.tag} type=${cog.type}> ${cog.width}x${cog.height}, aria-label "${cog.label}", SVG node aria-hidden`,
    `present in phases: ready + error`,
    `click -> new tab ${openedUrl} (pages ${before} -> ${before + 1}); popover still ready, draft intact`,
    `Enter on the focused cog -> ${keyUrl}`,
  ];
});

/* -------------------------------------------------------------------------- */
/* teardown + report                                                          */
/* -------------------------------------------------------------------------- */

if (!keepOpen) {
  await context.close();
  await bridge.close();
  await fixtures.close();
  rmSync(profile, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
const failed = results.filter((r) => !r.ok && !r.skipped).length;

console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped (of ${results.length}) ===`);
for (const r of results) {
  const tag = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
  console.log(`${tag}  ${r.name}${r.skipped ? `\n      ${r.reason}` : r.ok ? "" : `\n      ${r.error}`}`);
}

if (consoleErrors.length) {
  console.log(`\nBrowser console errors seen (${consoleErrors.length}):`);
  for (const e of [...new Set(consoleErrors)]) console.log(`  ! ${e}`);
}

writeFileSync(
  join(here, ".last-run.json"),
  JSON.stringify({ when: new Date().toISOString(), results, consoleErrors: [...new Set(consoleErrors)] }, null, 2),
);

process.exit(failed === 0 ? 0 : 1);
