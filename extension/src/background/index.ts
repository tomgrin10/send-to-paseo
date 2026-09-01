/**
 * Service worker. Owns the bearer token and performs every fetch.
 *
 * The content script can only ask for an *intent* to be carried out; it never
 * receives the token and never sees a bridge URL it could authenticate against.
 */

import {
  PROMPT_MAX,
  PROMPT_MIN,
  promptLength,
  type Provider,
  type SendRequest,
} from "../shared/contract";
import type { Intent, PublicSettings, Result } from "../shared/messages";
import { ping, requireCompatibleContract, resolve, send } from "./bridge-client";
import { readSettings } from "./settings";

async function publicSettings(): Promise<PublicSettings> {
  const s = await readSettings();
  return {
    bridgeUrl: s.bridgeUrl,
    defaultProvider: s.defaultProvider,
    hasToken: s.token.length > 0,
  };
}

/**
 * Cache the provider list so the options page has something to show before its
 * first ping, and so the popover can pre-select a default. Written from both
 * /v1/ping and /v1/resolve — they return the same shape.
 */
async function cacheProviders(providers: Provider[] | undefined): Promise<void> {
  if (!providers?.length) return;
  await chrome.storage.local.set({
    lastProviders: providers.map((p) => ({
      id: p.id,
      label: p.label,
      isDefault: p.isDefault,
    })),
  });
}

/**
 * Everything PR-scoped goes through the same preflight: token present, then the
 * contract version gate. Ordered so that an unpaired extension fires NO HTTP
 * request at all.
 */
async function preflight(): Promise<Result<true>> {
  const settings = await readSettings();
  if (!settings.token) {
    return {
      ok: false,
      error: {
        code: "not_configured",
        message: "No pairing token is stored for the Paseo bridge.",
      },
    };
  }
  const contract = await requireCompatibleContract();
  if (!contract.ok) return contract;
  return { ok: true, data: true };
}

async function handle(intent: Intent): Promise<Result<unknown>> {
  switch (intent.type) {
    case "ping": {
      const res = await ping({ authenticated: intent.authenticated ?? true });
      if (res.ok) await cacheProviders(res.data.providers);
      return res;
    }

    case "resolve": {
      const gate = await preflight();
      if (!gate.ok) return gate;

      const res = await resolve({
        forge: intent.pr.forge,
        owner: intent.pr.owner,
        repo: intent.pr.repo,
        number: intent.pr.number,
        stackPrNumbers: intent.stackPrNumbers,
      });
      if (res.ok) await cacheProviders(res.data.providers);
      return res;
    }

    case "send": {
      const prompt = intent.prompt.trim();
      const length = promptLength(prompt);
      if (length < PROMPT_MIN) {
        return {
          ok: false,
          error: {
            code: "bad_request",
            message: "Type an instruction before sending.",
          },
        };
      }
      if (length > PROMPT_MAX) {
        return {
          ok: false,
          error: {
            code: "payload_too_large",
            message: `The instruction is ${length} characters; the limit is ${PROMPT_MAX}.`,
          },
        };
      }

      // The contract requires refusing to send on a version mismatch. Re-checked
      // here and not only at resolve time, because the plugin can be updated
      // while the popover sits open.
      const gate = await preflight();
      if (!gate.ok) return gate;

      const body: SendRequest = {
        forge: intent.pr.forge,
        owner: intent.pr.owner,
        repo: intent.pr.repo,
        number: intent.pr.number,
        prompt,
        target: intent.target,
      };
      if (intent.provider) body.provider = intent.provider;
      if (intent.modeId) body.modeId = intent.modeId;
      if (intent.pageUrl) body.pageUrl = intent.pageUrl;
      return send(body);
    }

    case "getPublicSettings":
      return { ok: true, data: await publicSettings() };

    case "openOptions":
      await chrome.runtime.openOptionsPage();
      return { ok: true, data: { opened: true } };

    default:
      return {
        ok: false,
        error: {
          code: "extension_internal",
          message: `Unknown intent "${(intent as { type?: string })?.type}".`,
        },
      };
  }
}

// Toolbar icon is a shortcut to settings; there is no popup.
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message as Intent)
    .then(sendResponse)
    .catch((e: unknown) => {
      sendResponse({
        ok: false,
        error: {
          code: "extension_internal",
          message: e instanceof Error ? e.message : String(e),
        },
      });
    });
  return true; // keep the message channel open for the async reply
});
