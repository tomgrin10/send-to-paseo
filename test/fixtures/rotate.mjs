#!/usr/bin/env node
/**
 * Regenerates the "hash-rotated" fixtures by changing EVERY CSS-module hash
 * suffix — simulating a deploy of the site the fixture reproduces.
 *
 *   graphite-pr.html -> graphite-pr-rotated.html
 *   github-pr.html   -> github-pr-rotated.html
 *
 * Both sites ship hashed class names, in two different shapes:
 *
 *   Graphite   `PullRequestPageHeader_prPageHeader__NRgNb`   (`__` + hash)
 *   GitHub     `prc-PageHeader-Actions-wawWm`                (`-` + 5-char hash)
 *   GitHub     `PullRequestHeader-module__titleWithAction__ODY5f`  (also `__`)
 *
 * In every case the trailing hash rotates on each deploy, so any selector that
 * matches the full class name breaks and a `[class*="StablePrefix"]`
 * attribute-CONTAINS selector survives. The rotated fixtures are what prove the
 * extension picked the surviving strategy on BOTH sites.
 *
 * Run: node test/fixtures/rotate.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

/** Deterministic pseudo-random hash so the fixtures are reproducible in git. */
function rotateHash(seed, length = 5, alphabet = ALPHABET) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < length; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    out += alphabet[h % alphabet.length];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* token shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `Name__hash`, used by Graphite and by GitHub's non-Primer CSS modules.
 * The hash is the FINAL `__`-delimited segment; splitting on the LAST `__`
 * keeps compound local names intact (`styles_gap__s__zuWdb` -> local `gap__s`,
 * hash `zuWdb`) instead of eating part of the stable prefix.
 */
const UNDERSCORE_TOKEN = /\b[A-Za-z][A-Za-z0-9_-]*__[A-Za-z0-9_-]{4,8}\b/g;

function rotateUnderscore(full) {
  const split = full.lastIndexOf("__");
  const prefix = full.slice(0, split);
  const oldHash = full.slice(split + 2);
  if (!/^[A-Za-z0-9_-]{4,8}$/.test(oldHash)) return null;
  let next = rotateHash(full, oldHash.length);
  let salt = 0;
  while (next === oldHash) next = rotateHash(full + ++salt, oldHash.length);
  return { oldHash, next: `${prefix}__${next}` };
}

/**
 * Primer React: `prc-<Component>-<Part>-<hash>`, where the hash is always
 * exactly five characters from `[A-Za-z0-9_-]` and may itself begin with or
 * contain a dash. Verified against every such class on the live PR page:
 * `prc-PageHeader-Actions-wawWm`, `prc-Button-ButtonBase-9n-Xk`,
 * `prc-PageLayout-PageLayoutRoot--KH-d`, `prc-PageHeader-Description-w-ejP`.
 */
const PRIMER_TOKEN =
  /\bprc-[A-Za-z][A-Za-z0-9]*-[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9_-]{5}(?![A-Za-z0-9_-])/g;

/** Primer hashes never contain `_`, so keep the rotated ones in the same shape. */
const PRIMER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-";

function rotatePrimer(full) {
  const oldHash = full.slice(-5);
  const prefix = full.slice(0, -5);
  let next = rotateHash(full, 5, PRIMER_ALPHABET);
  let salt = 0;
  while (next === oldHash) next = rotateHash(full + ++salt, 5, PRIMER_ALPHABET);
  return { oldHash, next: `${prefix}${next}` };
}

/* -------------------------------------------------------------------------- */
/* the jobs                                                                   */
/* -------------------------------------------------------------------------- */

const JOBS = [
  {
    src: "graphite-pr.html",
    out: "graphite-pr-rotated.html",
    site: "Graphite",
    shapes: [[UNDERSCORE_TOKEN, rotateUnderscore]],
  },
  {
    src: "github-pr.html",
    out: "github-pr-rotated.html",
    site: "GitHub",
    // Both shapes: Primer's `prc-…-hash` AND GitHub's own `Name-module__…__hash`
    // CSS-module classes (PullRequestHeader-module__, PullRequestHeaderTabNav-module__).
    shapes: [
      [PRIMER_TOKEN, rotatePrimer],
      [UNDERSCORE_TOKEN, rotateUnderscore],
    ],
  },
];

let failed = false;

for (const job of JOBS) {
  const SRC = join(here, job.src);
  const OUT = join(here, job.out);
  const src = readFileSync(SRC, "utf8");

  /* Collect every hashed class token. Scans the raw text, not only class
     attributes, so the fixture's own <style> block rotates in lockstep. */
  const mapping = new Map();
  for (const [pattern, rotate] of job.shapes) {
    for (const m of src.matchAll(pattern)) {
      const full = m[0];
      if (mapping.has(full)) continue;
      const r = rotate(full);
      if (r) mapping.set(full, r.next);
    }
  }

  if (mapping.size === 0) {
    console.error(`rotate.mjs: ${job.src} — found no hashed class tokens; did the fixture change shape?`);
    failed = true;
    continue;
  }

  /* Replace longest tokens first so `styles_gap__s__zuWdb` is not clobbered by
     a shorter overlapping match. */
  let out = src;
  for (const [from, to] of [...mapping].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(from).join(to);
  }

  /* Sanity: no original hash may survive anywhere in the output. */
  for (const from of mapping.keys()) {
    if (out.includes(from)) {
      console.error(`rotate.mjs: ${job.src} — token survived rotation: ${from}`);
      failed = true;
    }
  }

  const banner = `<!--
  GENERATED by test/fixtures/rotate.mjs — do not edit by hand.

  This is ${job.src} with all ${mapping.size} CSS-module hash suffixes
  rotated, simulating a ${job.site} deploy. The extension must inject into the
  header action row here exactly as it does on the un-rotated fixture. If this
  file stops working, the attribute-CONTAINS selector strategy has regressed.
-->
`;

  out = out.replace(/^<!doctype html>\n/i, `<!doctype html>\n${banner}`);
  out = out.replace(
    /<title>([^<]*)<\/title>/,
    (_m, t) => `<title>${t} [hash-rotated fixture]</title>`,
  );

  writeFileSync(OUT, out);
  console.log(`rotate.mjs: rotated ${mapping.size} class tokens -> ${OUT}`);
  for (const [from, to] of mapping) console.log(`  ${from}  ->  ${to}`);
}

process.exit(failed ? 1 : 0);
