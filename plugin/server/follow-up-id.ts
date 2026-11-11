/**
 * Follow-up's plugin id. Follow-up 2.0 runs as `follow-up`; 1.x (and a 2.0 that hasn't finished moving to its new id)
 * still runs as `follow-through`. Callers try the new id first and fall back only when that plugin isn't there.
 */
export const FOLLOW_UP_PLUGIN_IDS = ["follow-up", "follow-through"] as const;

/** Paseo's answer when no plugin runs under the id (0.15: "Plugin is not available: <id>"). */
const absent = (error: unknown) => /plugin (?:is )?not (?:available|installed|configured)|unknown plugin/i.test(error instanceof Error ? error.message : String(error));

/**
 * The browser bridge polls every few seconds, and the daemon logs every absent-plugin answer at error level, so an id
 * is never re-probed per call. The id that answered goes first next time and is only abandoned when it comes back
 * absent (2.0 moved to a new id mid-process, or a rollback). When neither id is installed, that fact is cached for
 * `ABSENT_TTL_MS` so a host without Follow-up isn't probed on every poll either.
 */
const ABSENT_TTL_MS = 30_000;
let remembered: (typeof FOLLOW_UP_PLUGIN_IDS)[number] | undefined;
let neitherUntil = 0;
let neitherError: unknown;

/** Calls `method` on whichever Follow-up id answers. Any other failure (an RPC error, a timeout) is the answer. */
export async function invokeFollowUp(invoke: (pluginId: string, method: string, input: unknown) => Promise<unknown>, method: string, input: unknown, now: () => number = Date.now): Promise<unknown> {
  if (!remembered && now() < neitherUntil) throw neitherError;
  const order = remembered ? [remembered, ...FOLLOW_UP_PLUGIN_IDS.filter(id => id !== remembered)] : FOLLOW_UP_PLUGIN_IDS;
  let last: unknown;
  for (const id of order) {
    try { const answer = await invoke(id, method, input); remembered = id; return answer; }
    catch (error) { if (!absent(error)) throw error; last = error; }
  }
  remembered = undefined;
  neitherError = last; neitherUntil = now() + ABSENT_TTL_MS;
  throw last;
}
