#!/usr/bin/env node
/**
 * Serves the captured fixtures over HTTP at real, PR-shaped paths — one shape
 * per site, so the e2e suite exercises each adapter's actual URL parsing rather
 * than a stubbed PrRef:
 *
 *   Graphite  http://localhost:<port>/github/pr/acmegizmos/gizmo-poc/942/GIZ-1133-slug
 *   GitHub    http://localhost:<port>/acmegizmos/gizmo-poc/pull/942
 *             http://localhost:<port>/acmegizmos/gizmo-poc/pull/942/changes
 *
 * The two shapes are disjoint, which is what lets both adapters be registered
 * against the same localhost origin in the test build: for a path to match both,
 * the owner would have to be literally "github", the repo literally "pr", and
 * the third segment literally "pull".
 *
 * Which fixture is served is chosen with `?fixture=...` so the path stays
 * authentic:
 *
 *   Graphite  normal | rotated | no-anchor
 *   GitHub    normal | rotated | no-actions | no-anchor
 *
 * Run standalone: node test/fixture-server.mjs [--port 4173]
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = {
  normal: "fixtures/graphite-pr.html",
  rotated: "fixtures/graphite-pr-rotated.html",
  "no-anchor": "fixtures/graphite-pr-no-anchor.html",
};

export const GITHUB_FIXTURES = {
  normal: "fixtures/github-pr.html",
  rotated: "fixtures/github-pr-rotated.html",
  "no-actions": "fixtures/github-pr-no-actions.html",
  "no-anchor": "fixtures/github-pr-no-anchor.html",
};

const GRAPHITE_PR_PATH = /^\/github\/pr\/[^/]+\/[^/]+\/\d+(?:\/|$)/;
/** `/{owner}/{repo}/pull/{number}` + any sub-route, mirroring github.com. */
const GITHUB_PR_PATH = /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/;

/** Which fixture family a request path belongs to, or null for a 404. */
function routeFor(pathname) {
  // Graphite first: its shape is more specific, and on the real hosts the two
  // can never collide anyway.
  if (GRAPHITE_PR_PATH.test(pathname)) return { site: "graphite", set: FIXTURES };
  if (GITHUB_PR_PATH.test(pathname)) return { site: "github", set: GITHUB_FIXTURES };
  return null;
}

export function createFixtureServer({ port = 4173 } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // Chromium asks for this on every navigation; answering keeps the browser
    // console clean so a genuine extension error stands out in the e2e run.
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    const route = routeFor(url.pathname);
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(
        `fixture-server serves:\n` +
          `  /github/pr/{owner}/{repo}/{number}/{slug}   (Graphite)\n` +
          `  /{owner}/{repo}/pull/{number}[/{tab}]       (GitHub)\n` +
          `got: ${url.pathname}\n`,
      );
      return;
    }

    const name = url.searchParams.get("fixture") ?? "normal";
    const rel = route.set[name];
    if (!rel) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(
        `unknown ${route.site} fixture "${name}"; try one of ` +
          `${Object.keys(route.set).join(", ")}\n`,
      );
      return;
    }

    let html;
    try {
      html = readFileSync(join(here, rel), "utf8");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`could not read ${rel}: ${e.message}\n`);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  });

  return {
    server,
    port,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(port));
      });
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
    url(
      { owner = "acmegizmos", repo = "gizmo-poc", number = 942, slug = "GIZ-1133-legacy-tally-engine-retirement-3", fixture = "normal" } = {},
    ) {
      const q = fixture === "normal" ? "" : `?fixture=${fixture}`;
      return `http://localhost:${port}/github/pr/${owner}/${repo}/${number}/${slug}${q}`;
    },
    /**
     * GitHub's URL shape. `tab` is the sub-route ("", "commits", "changes",
     * "checks") — note the new diff experience uses /changes, not /files, but
     * both are matched by the adapter and both work here.
     */
    githubUrl(
      { owner = "acmegizmos", repo = "gizmo-poc", number = 942, tab = "", fixture = "normal" } = {},
    ) {
      const q = fixture === "normal" ? "" : `?fixture=${fixture}`;
      const suffix = tab ? `/${tab}` : "";
      return `http://localhost:${port}/${owner}/${repo}/pull/${number}${suffix}${q}`;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : 4173;
  const s = createFixtureServer({ port });
  await s.listen();
  for (const f of Object.keys(FIXTURES)) console.log(`[fixture-server] ${s.url({ fixture: f })}`);
  for (const f of Object.keys(GITHUB_FIXTURES)) {
    console.log(`[fixture-server] ${s.githubUrl({ fixture: f })}`);
  }
}
