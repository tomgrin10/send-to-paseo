/**
 * Content-script side of the intent channel.
 *
 * This file is the closest the page-adjacent world ever gets to the bridge: it
 * posts an intent name and plain data. No token, no Authorization header, no
 * fetch. Grep the built content bundle for "Bearer" — it isn't there, and the
 * e2e suite asserts that.
 */

import type { Intent, IntentResultMap, Result } from "../shared/messages";

export async function sendIntent<I extends Intent>(
  intent: I,
): Promise<Result<IntentResultMap[I["type"]]>> {
  try {
    const res = (await chrome.runtime.sendMessage(intent)) as
      | Result<IntentResultMap[I["type"]]>
      | undefined;
    if (!res) {
      return {
        ok: false,
        error: {
          code: "extension_internal",
          message: "The extension's service worker didn't reply.",
        },
      };
    }
    return res;
  } catch (e) {
    // Typically "Extension context invalidated" after a reload.
    return {
      ok: false,
      error: {
        code: "extension_internal",
        message:
          e instanceof Error && /context invalidated/i.test(e.message)
            ? "The extension was reloaded. Refresh this page."
            : e instanceof Error
              ? e.message
              : String(e),
      },
    };
  }
}
