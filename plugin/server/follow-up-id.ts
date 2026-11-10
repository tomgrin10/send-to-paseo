/**
 * Follow-up's plugin id. Follow-up 2.0 runs as `follow-up`; 1.x (and a 2.0 that hasn't finished moving to its new id)
 * still runs as `follow-through`. Callers try the new id first and fall back only when that plugin isn't there.
 */
export const FOLLOW_UP_PLUGIN_IDS = ["follow-up", "follow-through"] as const;

/** Paseo's answer when no plugin runs under the id (0.15: "Plugin is not available: <id>"). */
const absent = (error: unknown) => /plugin (?:is )?not (?:available|installed|configured)|unknown plugin/i.test(error instanceof Error ? error.message : String(error));

/** Calls `method` on whichever Follow-up id answers. Any other failure (an RPC error, a timeout) is the answer. */
export async function invokeFollowUp(invoke: (pluginId: string, method: string, input: unknown) => Promise<unknown>, method: string, input: unknown): Promise<unknown> {
  let last: unknown;
  for (const id of FOLLOW_UP_PLUGIN_IDS) {
    try { return await invoke(id, method, input); }
    catch (error) { if (!absent(error)) throw error; last = error; }
  }
  throw last;
}
