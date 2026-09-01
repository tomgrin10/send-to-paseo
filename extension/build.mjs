#!/usr/bin/env node
/**
 * esbuild bundler for the extension.
 *
 * MV3 content scripts are classic scripts — they cannot use ESM `import`. So
 * every entry point is bundled to a self-contained IIFE. Sources stay
 * TypeScript; nothing is hand-written into dist/.
 *
 * Usage:
 *   node build.mjs                         -> dist/       (shipping build)
 *   node build.mjs --test --port 4173      -> dist-test/  (adds localhost:4173
 *                                             to the adapter host allowlist and
 *                                             to the content-script matches)
 *   node build.mjs --watch
 *
 * THE LOADED-UNPACKED ROOT IS `extension/dist` (or `extension/dist-test`).
 * It contains manifest.json at its top level and nothing else is loadable.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const isTest = argv.includes("--test");
const watch = argv.includes("--watch");
const portArg = argv[argv.indexOf("--port") + 1];
const testPort = argv.includes("--port") ? Number(portArg) : 4173;
// The e2e suite's mock bridge port. Defaults to the real 7788, but the suite
// overrides it because the actual Paseo plugin may already own that port.
const bridgePortArg = argv[argv.indexOf("--bridge-port") + 1];
const testBridgePort = argv.includes("--bridge-port") ? Number(bridgePortArg) : 7788;

const outdir = join(here, isTest ? "dist-test" : "dist");

/* -------------------------------------------------------------------------- */
/* host injection                                                             */
/* -------------------------------------------------------------------------- */

// Shipping builds get an EMPTY extra-host list: no localhost ever reaches a
// real artifact. The test build injects the fixture server's origin instead of
// the adapter hardcoding it.
const extraHosts = isTest
  ? [`localhost:${testPort}`, `127.0.0.1:${testPort}`]
  : [];

// One entry per (fixture host x site URL shape). The Graphite shape is
// /github/pr/{owner}/{repo}/{n}/{slug}; the GitHub shape is
// /{owner}/{repo}/pull/{n}[/{tab}] — see test/fixture-server.mjs. The two are
// disjoint, so registering both adapters against the same localhost origin is
// unambiguous.
const extraMatches = isTest
  ? [
      `http://localhost:${testPort}/github/pr/*`,
      `http://127.0.0.1:${testPort}/github/pr/*`,
      `http://localhost:${testPort}/*/*/pull/*`,
      `http://127.0.0.1:${testPort}/*/*/pull/*`,
    ]
  : [];

/* -------------------------------------------------------------------------- */
/* icons (generated, so no binaries live in the repo)                         */
/* -------------------------------------------------------------------------- */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGBA PNG encoder. */
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// The Paseo brand mark ("the butterfly"), as SVG path data — copied verbatim
// from the `d` attribute of the Paseo repo's
// packages/app/assets/images/butterfly-white.svg (also served live at
// https://paseo.sh/favicon.svg). Paseo is Apache-2.0, (c) 2025-present Mohamed
// Boudra; the mark is reproduced here only to identify Paseo. Storing it as
// path text rather than a PNG keeps this repo binary-free while reproducing the
// mark exactly. Absolute M/L/C/Z commands only, on a 700x700 viewBox, filled
// with the nonzero rule (subpaths 2 and 3 are counter-wound holes).
const PASEO_MARK =
  "M291.495 91.399C333.897 104.892 379.155 135.075 416.229 173.191C453.389 211.394 484.429 259.725 495.708 311.251C497.555 319.693 498.865 328.216 499.586 336.776C509.755 326.554 519.867 317.815 529.89 311.547C540.647 304.821 553.808 299.297 568.641 299.785C584.29 300.299 597.395 307.326 607.747 317.632C632.173 341.947 629.612 372.898 619.872 397.936C610.185 422.833 591.557 447.826 572.732 469.124C553.591 490.78 532.713 510.308 516.779 524.318C508.775 531.355 501.936 537.073 497.07 541.052C494.635 543.043 492.689 544.603 491.334 545.679C490.657 546.217 490.126 546.635 489.756 546.926C489.571 547.071 489.425 547.184 489.321 547.265C489.269 547.305 489.227 547.338 489.196 547.362C489.181 547.374 489.168 547.385 489.157 547.393C489.153 547.397 489.147 547.401 489.144 547.403C489.134 547.4 488.837 547.06 473.001 528.499L489.135 547.411C478.157 555.911 462.033 554.334 453.122 543.89C444.213 533.448 445.887 518.094 456.861 509.592C456.863 509.591 456.865 509.588 456.869 509.586C456.88 509.577 456.902 509.561 456.933 509.536C456.997 509.487 457.101 509.404 457.245 509.292C457.533 509.066 457.979 508.715 458.569 508.247C459.749 507.31 461.506 505.901 463.742 504.073C468.216 500.414 474.589 495.088 482.073 488.508C497.114 475.284 516.315 457.282 533.578 437.75C551.157 417.862 565.26 398.01 571.859 381.048C578.403 364.227 575.681 356.302 570.724 351.367C568.928 349.579 567.744 348.902 567.267 348.676C566.888 348.496 566.811 348.52 566.804 348.52C566.605 348.513 563.971 348.537 557.953 352.3C545.161 360.299 528.815 377.492 506.807 403.867C494.927 418.106 481.871 434.435 467.547 451.957C463.709 457.28 459.503 462.538 454.91 467.717L454.702 467.549C420.808 508.347 380.37 553.856 332.335 593.848C301.853 619.226 262.656 622.597 228.642 614.743C194.834 606.936 162.658 587.448 142.217 561.686C108.054 518.631 100.57 469.801 108.223 427.836C115.56 387.606 137.391 351.005 166.502 331.557C161.248 315.813 156.813 299.49 153.519 283.013C142.593 228.368 143.239 167.031 174.28 119.619C186.922 100.31 205.846 89.1535 227.387 85.2773C248.1 81.5504 270.278 84.648 291.495 91.399ZM378.642 206.356C345.773 172.563 307.463 147.917 275.208 137.654C259.096 132.527 246.171 131.514 236.828 133.195C228.314 134.727 222.227 138.497 217.721 145.38C196.712 177.468 193.858 224.004 203.82 273.827C206.532 287.394 210.127 300.834 214.345 313.817C236.45 310.276 260.156 311.463 281.22 317.11C319.621 327.403 357.501 355.419 357.501 405.654C357.501 435.255 339.111 465.136 307.278 473.815C273.211 483.103 238.854 464.822 213.105 427.541C203.716 413.947 194.443 397.766 185.947 379.89C174.028 392.223 163.08 411.953 158.673 436.118C153.128 466.518 158.514 501.286 183.085 532.253C195.993 548.522 217.742 562.031 240.771 567.349C263.594 572.619 284.147 569.24 298.664 557.154C349.383 514.927 390.709 466.547 426.366 422.952C448.879 390.86 453.195 356.06 445.578 321.265C436.703 280.718 411.425 240.06 378.642 206.356ZM306.296 405.722C306.296 384.769 292.223 370.736 267.284 364.051C256.012 361.03 244.156 360.087 233.095 360.771C240.361 375.935 248.168 389.513 255.897 400.704C275.647 429.298 289.989 427.822 293.247 426.934C298.737 425.437 306.296 418.161 306.296 405.722Z";

const MARK_VIEWBOX = 700;
const MARK_SCALE = 0.98; // fraction of the tile the 700x700 viewBox maps onto
const SSAA = 8; // supersampling factor for the mark's scanline fill

// DO NOT "SIMPLIFY" THIS AWAY. The butterfly is a thin-stroke line drawing —
// its stroke is ~4.3% of the tile, so below ~48px it is sub-pixel and the mark
// downsamples into a grey smudge. Dilating the supersampled mask by this many
// supersampled pixels before the box downsample keeps it legible in the
// toolbar. The values are the measured maximum: at 16px a radius of 4+ closes
// the butterfly's inner loop into a blob.
const MARK_BOLD = { 16: 3, 32: 2, 48: 1, 128: 0 };

/** Flatten an absolute-only M/L/C/Z path into closed polygons. */
function flattenPath(d, steps = 24) {
  const toks = d.match(/[MLCZ]|-?\d*\.?\d+/g) ?? [];
  const subpaths = [];
  let cur = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = null;
  let i = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/^[MLCZ]$/.test(toks[i])) cmd = toks[i++];
    if (cmd === "Z") {
      if (cur?.length) subpaths.push(cur);
      cur = null;
      cx = sx;
      cy = sy;
      cmd = null;
      continue;
    }
    if (cmd === "M") {
      if (cur?.length) subpaths.push(cur);
      cx = num();
      cy = num();
      sx = cx;
      sy = cy;
      cur = [[cx, cy]];
      cmd = "L"; // a repeated M's trailing pairs are implicit lineto
      continue;
    }
    if (cmd === "L") {
      cx = num();
      cy = num();
      cur.push([cx, cy]);
      continue;
    }
    if (cmd === "C") {
      const x1 = num();
      const y1 = num();
      const x2 = num();
      const y2 = num();
      const x3 = num();
      const y3 = num();
      const x0 = cx;
      const y0 = cy;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const m = 1 - t;
        cur.push([
          m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
          m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3,
        ]);
      }
      cx = x3;
      cy = y3;
      continue;
    }
    i++; // unknown token (the source path has none) — skip
  }
  if (cur?.length) subpaths.push(cur);
  return subpaths;
}

const MARK_POLYS = flattenPath(PASEO_MARK);

/** Per-pixel coverage of the mark at `size`, via nonzero scanline fill + SSAA. */
function markCoverage(size) {
  const n = size * SSAA;
  const k = (n * MARK_SCALE) / MARK_VIEWBOX;
  const off = (n * (1 - MARK_SCALE)) / 2;
  const edges = [];
  for (const poly of MARK_POLYS) {
    for (let j = 0; j < poly.length; j++) {
      const a = poly[j];
      const b = poly[(j + 1) % poly.length];
      const y0 = a[1] * k + off;
      const y1 = b[1] * k + off;
      if (y0 !== y1) edges.push([a[0] * k + off, y0, b[0] * k + off, y1]);
    }
  }
  let hi = new Uint8Array(n * n);
  const xs = [];
  for (let sy = 0; sy < n; sy++) {
    const y = sy + 0.5;
    xs.length = 0;
    for (const [x0, y0, x1, y1] of edges) {
      if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) {
        xs.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a[0] - b[0]);
    let w = 0; // winding number: nonzero rule, so the two holes stay open
    for (let e = 0; e < xs.length - 1; e++) {
      w += xs[e][1];
      if (w === 0) continue;
      const from = Math.max(0, Math.ceil(xs[e][0] - 0.5));
      const to = Math.min(n - 1, Math.floor(xs[e + 1][0] - 0.5));
      for (let px = from; px <= to; px++) hi[sy * n + px] = 1;
    }
  }
  const bold = MARK_BOLD[size] ?? 0;
  if (bold > 0) {
    const disc = [];
    for (let dy = -bold; dy <= bold; dy++) {
      for (let dx = -bold; dx <= bold; dx++) {
        if (dx * dx + dy * dy <= bold * bold) disc.push([dx, dy]);
      }
    }
    const out = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!hi[y * n + x]) continue;
        for (const [dx, dy] of disc) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < n && ny >= 0 && ny < n) out[ny * n + nx] = 1;
        }
      }
    }
    hi = out;
  }
  const cov = new Float32Array(size * size);
  for (let y = 0; y < n; y++) {
    const py = (y / SSAA) | 0;
    for (let x = 0; x < n; x++) {
      if (hi[y * n + x]) cov[py * size + ((x / SSAA) | 0)]++;
    }
  }
  for (let i = 0; i < cov.length; i++) cov[i] /= SSAA * SSAA;
  return cov;
}

/**
 * Black rounded square (rx 156/700 = 0.2229, matching Paseo's own favicon) with
 * the white Paseo mark on it. `cov` is the mark coverage from markCoverage().
 */
function iconPixel(x, y, size, cov) {
  // rounded-square alpha, supersampled so the corners aren't jagged
  const r = size * 0.2229;
  let hits = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const px = x + (i + 0.5) / 4;
      const py = y + (j + 0.5) / 4;
      const dx = Math.min(px, size - px);
      const dy = Math.min(py, size - py);
      if (dx >= r || dy >= r) {
        hits++;
        continue;
      }
      if ((r - dx) ** 2 + (r - dy) ** 2 <= r * r) hits++;
    }
  }
  if (hits === 0) return [0, 0, 0, 0];

  const g = Math.round(255 * Math.min(1, cov[y * size + x]));
  return [g, g, g, Math.round((255 * hits) / 16)];
}

function writeIcons() {
  mkdirSync(join(outdir, "icons"), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    // The mark is rasterised once per size, then read back per pixel, so png()
    // keeps its plain (x, y, size) => [r,g,b,a] callback contract.
    const cov = markCoverage(size);
    const file = png(size, (x, y, s) => iconPixel(x, y, s, cov));
    writeFileSync(join(outdir, "icons", `icon-${size}.png`), file);
  }
}

/* -------------------------------------------------------------------------- */
/* static assets                                                              */
/* -------------------------------------------------------------------------- */

function writeStatic() {
  const manifest = JSON.parse(readFileSync(join(here, "public/manifest.json"), "utf8"));
  if (isTest) {
    for (const cs of manifest.content_scripts) {
      cs.matches = [...cs.matches, ...extraMatches];
    }
    const bridgePattern = `http://127.0.0.1:${testBridgePort}/*`;
    if (!manifest.host_permissions.includes(bridgePattern)) {
      manifest.host_permissions = [...manifest.host_permissions, bridgePattern];
    }
    manifest.name = `${manifest.name} (test build)`;
  }
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(
    join(outdir, "options.html"),
    readFileSync(join(here, "public/options.html"), "utf8"),
  );
  writeIcons();
}

/* -------------------------------------------------------------------------- */
/* bundle                                                                    */
/* -------------------------------------------------------------------------- */

const options = {
  entryPoints: {
    content: join(here, "src/content/index.ts"),
    mainworld: join(here, "src/content/mainworld.ts"),
    background: join(here, "src/background/index.ts"),
    options: join(here, "src/options/index.ts"),
  },
  outdir,
  bundle: true,
  format: "iife", // MV3 content scripts cannot use ESM imports
  target: ["chrome111"],
  platform: "browser",
  sourcemap: isTest ? "inline" : false,
  minify: false, // keep dist readable; this is a dev-loaded extension
  legalComments: "none",
  logLevel: "info",
  define: {
    __STP_EXTRA_HOSTS__: JSON.stringify(extraHosts),
  },
};

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  writeStatic();
  await ctx.watch();
  console.log(`[build] watching -> ${outdir}`);
} else {
  await esbuild.build(options);
  writeStatic();
  console.log(
    `[build] ${isTest ? "TEST" : "shipping"} build -> ${outdir}` +
      (isTest ? ` (extra hosts: ${extraHosts.join(", ")}; bridge port ${testBridgePort})` : ""),
  );
}
