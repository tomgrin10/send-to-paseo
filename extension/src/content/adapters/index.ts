/**
 * Adapter registry. The content script asks this module which adapter owns the
 * current URL and knows nothing else about any specific site.
 */

import { GITHUB_HOSTS, createGithubAdapter } from "./github";
import { GRAPHITE_HOSTS, createGraphiteAdapter } from "./graphite";
import type { SiteAdapter } from "./types";

/**
 * Replaced at build time by esbuild `define`.
 *
 * Production build (`npm run build`)     -> []
 * Test build      (`npm run build:test`) -> ["localhost:<port>", "127.0.0.1:<port>"]
 *
 * This is how the e2e suite serves fixtures from a localhost origin without a
 * single localhost host name reaching a shipping artifact.
 */
declare const __STP_EXTRA_HOSTS__: string[];

export const EXTRA_HOSTS: string[] =
  typeof __STP_EXTRA_HOSTS__ === "undefined" ? [] : __STP_EXTRA_HOSTS__;

/**
 * Order matters only for disambiguation, and the two cannot collide on a real
 * host: Graphite owns `/github/pr/{owner}/{repo}/{n}` and GitHub owns
 * `/{owner}/{repo}/pull/{n}`. On the shared localhost fixture origin they are
 * still disjoint, because "github" would have to be an owner AND "pr" a repo
 * AND the third segment the literal "pull" for both to match.
 */
export const ADAPTERS: SiteAdapter[] = [
  createGraphiteAdapter({ hosts: [...GRAPHITE_HOSTS, ...EXTRA_HOSTS] }),
  createGithubAdapter({ hosts: [...GITHUB_HOSTS, ...EXTRA_HOSTS] }),
];

export function adapterFor(url: URL): SiteAdapter | null {
  for (const a of ADAPTERS) if (a.matches(url)) return a;
  return null;
}
