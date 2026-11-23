/** Follow-up 2.x's plugin id. */
const FOLLOW_UP_PLUGIN_ID = "follow-up";

/** Paseo's answer when no plugin runs under the id (0.15: "Plugin is not available: <id>"). */
const absent = (error: unknown) => /plugin (?:is )?not (?:available|installed|configured)|unknown plugin/i.test(error instanceof Error ? error.message : String(error));

// Browser polls must not repeatedly probe a missing optional plugin.
const ABSENT_TTL_MS = 30_000;
let absentUntil = 0;
let absentError: unknown;

/** Calls Follow-up once; RPC errors and timeouts are propagated without caching them as absence. */
export async function invokeFollowUp(invoke: (pluginId: string, method: string, input: unknown) => Promise<unknown>, method: string, input: unknown, now: () => number = Date.now): Promise<unknown> {
  if (now() < absentUntil) throw absentError;
  try {
    return await invoke(FOLLOW_UP_PLUGIN_ID, method, input);
  } catch (error) {
    if (absent(error)) { absentError = error; absentUntil = now() + ABSENT_TTL_MS; }
    throw error;
  }
}
