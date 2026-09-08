/**
 * Merging several hosts' resolve answers into the one list the composer shows.
 *
 * Pure, and separate from the service worker on purpose: this is the only place
 * that decides which machine a send defaults to, and that decision needs to be
 * readable and testable without a browser.
 */

import type {
  HostSlice,
  MergedCandidate,
  MultiResolveResponse,
} from "./messages";

/** A rank a plugin never sends, so a malformed one sorts last instead of first. */
const UNRANKED = 99;

function rankOf(rank: unknown): number {
  return typeof rank === "number" && Number.isFinite(rank) ? rank : UNRANKED;
}

interface Entry {
  candidate: MergedCandidate;
  rank: number;
  /** Position among this host's candidates *of the same rank*. */
  positionInRank: number;
  hostIndex: number;
  sourceIndex: number;
}

/**
 * Flatten every host's candidates into one cross-host ranking.
 *
 * Sort key is `(rank, positionInRank, hostIndex)`:
 *
 *  - **rank** first, because it is the bridge's own verdict and it means the
 *    same thing on every host: 1 exact branch match, 2 same stack, 3 same
 *    project, 4 create. An exact match on the dev box must outrank a
 *    same-project workspace on the laptop, and it does.
 *  - **positionInRank** second, not `hostIndex`. Within a rank each bridge has
 *    already ordered its own candidates by nearness (nearest stack sibling
 *    first, open siblings ahead of merged ones), and that ordering is the only
 *    signal about *which* stack workspace is the right one. Interleaving by
 *    position preserves it across hosts; grouping by host would bury the dev
 *    box's nearest sibling behind the laptop's most distant one.
 *  - **hostIndex** last, purely so the order is total and stable — the list is
 *    rebuilt on every open and must not shuffle between them.
 *
 * Every host contributes its own `create` row (rank 4), which is correct rather
 * than duplicative: "make a worktree for this PR" is a different action on each
 * machine, and the label says which.
 */
export function mergeHostAnswers(hosts: HostSlice[]): MultiResolveResponse {
  const entries: Entry[] = [];

  hosts.forEach((slice, hostIndex) => {
    const resolved = slice.resolved;
    if (resolved === null) return;
    const seenPerRank = new Map<number, number>();
    resolved.candidates.forEach((candidate, sourceIndex) => {
      const rank = rankOf(candidate.rank);
      const positionInRank = seenPerRank.get(rank) ?? 0;
      seenPerRank.set(rank, positionInRank + 1);
      entries.push({
        candidate: { ...candidate, hostIndex },
        rank,
        positionInRank,
        hostIndex,
        sourceIndex,
      });
    });
  });

  entries.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.positionInRank - b.positionInRank ||
      a.hostIndex - b.hostIndex,
  );

  return {
    hosts,
    candidates: entries.map((e) => e.candidate),
    defaultCandidateIndex: pickDefault(hosts, entries),
  };
}

/**
 * Which merged row starts selected.
 *
 * Each host already told us the one it would pick, and those verdicts embody
 * ranking rules this side deliberately does not reimplement (open stack
 * siblings ahead of merged ones, nearest first). So the choice here is only
 * *between* hosts: take each host's own default, and keep the one with the best
 * rank, earliest host wins a tie.
 *
 * Consequence worth stating: a host that would create a worktree (rank 4) never
 * beats a host that already has one, which is the whole point of asking both.
 */
function pickDefault(hosts: HostSlice[], entries: Entry[]): number {
  let best: { hostIndex: number; sourceIndex: number; rank: number } | null = null;

  hosts.forEach((slice, hostIndex) => {
    const resolved = slice.resolved;
    if (resolved === null || resolved.candidates.length === 0) return;
    const sourceIndex = clampIndex(
      resolved.defaultCandidateIndex,
      resolved.candidates.length,
    );
    const rank = rankOf(resolved.candidates[sourceIndex]?.rank);
    if (best === null || rank < best.rank) best = { hostIndex, sourceIndex, rank };
  });

  if (best === null) return entries.length > 0 ? 0 : -1;
  const winner = best as { hostIndex: number; sourceIndex: number; rank: number };
  const found = entries.findIndex(
    (e) => e.hostIndex === winner.hostIndex && e.sourceIndex === winner.sourceIndex,
  );
  return found === -1 ? (entries.length > 0 ? 0 : -1) : found;
}

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  if (!Number.isFinite(i) || i < 0 || i >= len) return 0;
  return Math.trunc(i);
}

/**
 * The one error to show when *nothing* resolved.
 *
 * Preferring a host that answered at all over one that never replied: an
 * `unauthorized` or `project_not_found` names a fix the user can carry out,
 * whereas `bridge_unreachable` from a tunnel that is simply not up right now is
 * the least informative thing on the list.
 */
export function primaryFailure(hosts: HostSlice[]): HostSlice | null {
  const failed = hosts.filter((h) => h.error !== null);
  if (failed.length === 0) return null;
  const informative = failed.find(
    (h) => h.error!.code !== "bridge_unreachable" && h.error!.code !== "permission_required",
  );
  return informative ?? failed[0];
}
