/**
 * Service worker. Owns the bearer tokens and performs every fetch.
 *
 * The content script can only ask for an *intent* to be carried out; it never
 * receives a token and never sees a bridge URL it could authenticate against.
 *
 * With more than one Paseo machine paired, this is also the fan-out point: one
 * `resolve` intent becomes one request per host, in parallel, and the answers
 * are merged into a single ranked candidate list before the composer sees them.
 */

import {
  PROMPT_MAX,
  PROMPT_MIN,
  promptLength,
  type Provider,
  type ResolveRequest,
  type SendRequest,
} from "../shared/contract";
import type {
  HostSlice,
  Intent,
  MultiResolveResponse,
  PublicSettings,
  Result,
} from "../shared/messages";
import { mergeHostAnswers, primaryFailure } from "../shared/merge";
import { ping, requireCompatibleContract, resolve, send } from "./bridge-client";
import {
  authorityOf,
  enabledHosts,
  hostById,
  hostDisplayName,
  readSettings,
  writeHost,
  type HostConfig,
} from "./settings";

async function publicSettings(): Promise<PublicSettings> {
  const s = await readSettings();
  return {
    defaultProvider: s.defaultProvider,
    hosts: s.hosts.map((h) => ({
      id: h.id,
      label: hostDisplayName(h),
      bridgeUrl: h.bridgeUrl,
      enabled: h.enabled,
      hasToken: h.token.length > 0,
    })),
  };
}

/**
 * Cache the provider list so the options page has something to show before its
 * first ping, and so the popover can pre-select a default. Written from both
 * /v1/ping and /v1/resolve — they return the same shape.
 *
 * Keyed per host, because two machines can have entirely different models
 * configured and a picker offering one host's models for the other would send a
 * provider the bridge then has to reject or silently substitute.
 */
async function cacheProviders(hostId: string, providers: Provider[] | undefined): Promise<void> {
  if (!providers?.length) return;
  const got = await chrome.storage.local.get("lastProviders");
  const byHost = (got?.lastProviders ?? {}) as Record<string, unknown>;
  await chrome.storage.local.set({
    lastProviders: {
      ...byHost,
      [hostId]: providers.map((p) => ({ id: p.id, label: p.label, isDefault: p.isDefault })),
    },
  });
}

/**
 * Remember what a bridge called its machine, so the host list can read "devbox"
 * instead of "127.0.0.1:7789" — the URL is the least memorable thing about a
 * host when every one of them is a loopback tunnel.
 *
 * Only written when it actually changed: this runs on every ping, and a storage
 * write per PR opened would be pure churn.
 */
async function cacheMachineName(host: HostConfig, name: string | undefined): Promise<void> {
  const next = (name ?? "").trim();
  if (!next || next === host.machineName) return;
  await writeHost(host.id, { machineName: next });
}

/**
 * One host's resolve, as a slice that can never reject.
 *
 * Failure is data here, not an exception: with two machines paired, the dev box
 * being asleep must not stop the laptop's workspaces from being offered. The
 * contract gate runs per host for the same reason — one stale plugin blocks
 * sends to itself, not to the other machine.
 */
async function resolveOnHost(
  host: HostConfig,
  request: ResolveRequest,
): Promise<HostSlice> {
  const slice: HostSlice = {
    hostId: host.id,
    hostLabel: hostDisplayName(host),
    bridgeAuthority: authorityOf(host.bridgeUrl),
    resolved: null,
    error: null,
  };

  // An unpaired host is reported WITHOUT touching the network. A never-paired
  // extension must fire no request at all — the same guarantee the single-host
  // version made, now per host.
  if (!host.token) {
    slice.error = {
      code: "not_configured",
      message: `No pairing token is stored for ${hostDisplayName(host)}.`,
    };
    return slice;
  }

  const gate = await requireCompatibleContract(host);
  if (!gate.ok) {
    slice.error = gate.error;
    return slice;
  }
  await cacheMachineName(host, gate.data.machine?.name);
  // The label may have only just become knowable, so re-derive it.
  slice.hostLabel = hostDisplayName({ ...host, machineName: gate.data.machine?.name ?? host.machineName });

  const res = await resolve(host, request);
  if (!res.ok) {
    slice.error = res.error;
    return slice;
  }
  await cacheProviders(host.id, res.data.providers);
  slice.resolved = res.data;
  return slice;
}

async function handleResolve(request: ResolveRequest): Promise<Result<MultiResolveResponse>> {
  const hosts = await enabledHosts();
  if (hosts.length === 0) {
    const configured = (await readSettings()).hosts.length;
    return {
      ok: false,
      error: {
        code: "not_configured",
        message:
          configured === 0
            ? "No Paseo host is configured."
            : "Every configured Paseo host is disabled.",
      },
    };
  }

  // Parallel: the whole point of this being a fan-out is that two hosts cost
  // one host's latency, not two. Every slice settles, so one timeout does not
  // hold up a bridge that already answered.
  const slices = await Promise.all(hosts.map((h) => resolveOnHost(h, request)));
  const merged = mergeHostAnswers(slices);

  // Only a total failure is an error. If any host answered, the composer opens
  // and reports the others inline — a sleeping dev box is a footnote, not a
  // wall.
  if (merged.candidates.length === 0) {
    const worst = primaryFailure(slices);
    return {
      ok: false,
      error:
        worst?.error ??
        {
          code: "internal",
          message: "No Paseo host returned a target for this pull request.",
        },
    };
  }
  return { ok: true, data: merged };
}

async function handle(intent: Intent): Promise<Result<unknown>> {
  switch (intent.type) {
    case "ping": {
      const host = await hostById(intent.hostId);
      if (!host) {
        return {
          ok: false,
          error: { code: "not_configured", message: "That Paseo host is no longer configured." },
        };
      }
      const res = await ping(host, { authenticated: intent.authenticated ?? true });
      if (res.ok) {
        await cacheProviders(host.id, res.data.providers);
        await cacheMachineName(host, res.data.machine?.name);
      }
      return res;
    }

    case "resolve":
      return handleResolve({
        forge: intent.pr.forge,
        owner: intent.pr.owner,
        repo: intent.pr.repo,
        number: intent.pr.number,
        stackPrNumbers: intent.stackPrNumbers,
      });

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

      // The host is named by the intent and never re-derived. The composer's
      // chosen target belongs to exactly one machine, and quietly falling back
      // to a different one would start an agent somewhere the user did not look
      // at.
      const host = await hostById(intent.hostId);
      if (!host) {
        return {
          ok: false,
          error: {
            code: "not_configured",
            message:
              "The Paseo host this target belongs to is no longer configured. Reopen the composer.",
          },
        };
      }

      // The contract requires refusing to send on a version mismatch. Re-checked
      // here and not only at resolve time, because the plugin can be updated
      // while the popover sits open.
      const gate = await requireCompatibleContract(host);
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
      return send(host, body);
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
