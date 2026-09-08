/**
 * The content-script <-> service-worker protocol.
 *
 * SECURITY: no message in either direction ever carries a bearer token. The
 * content script posts *intents*; the service worker owns the credentials and
 * performs every fetch. See README "Security model".
 *
 * Everything PR-scoped is keyed on a `hostId`, because the extension can be
 * paired with several Paseo machines at once. A resolve fans out to all of them
 * and comes back as one merged list; a send names the single host that owns the
 * chosen target.
 */

import type {
  Candidate,
  PingResponse,
  PrRef,
  ResolveResponse,
  SendResponse,
  SendTarget,
} from "./contract";

export interface IntentPing {
  type: "ping";
  /** Which paired host to ping. */
  hostId: string;
  /**
   * Send the bearer token if one is stored (default). `false` forces the
   * unauthenticated form of GET /v1/ping, which is how the options page tells
   * "bridge down" apart from "bad token".
   */
  authenticated?: boolean;
}

export interface IntentResolve {
  type: "resolve";
  pr: PrRef;
  stackPrNumbers: number[];
}

export interface IntentSend {
  type: "send";
  /** The host that owns the chosen target. Never inferred. */
  hostId: string;
  pr: PrRef;
  prompt: string;
  target: SendTarget;
  provider?: string;
  modeId?: string;
  pageUrl?: string;
}

export interface IntentGetPublicSettings {
  type: "getPublicSettings";
}

export interface IntentOpenOptions {
  type: "openOptions";
}

export type Intent =
  | IntentPing
  | IntentResolve
  | IntentSend
  | IntentGetPublicSettings
  | IntentOpenOptions;

/* -------------------------------------------------------------------------- */
/* Multi-host resolve                                                         */
/* -------------------------------------------------------------------------- */

/** One host's answer to a fanned-out resolve. Exactly one of the last two is set. */
export interface HostSlice {
  hostId: string;
  /** Display name, resolved by the worker. Never empty. */
  hostLabel: string;
  /**
   * `127.0.0.1:7789`. Shown only to separate two hosts that display the same
   * name, which is easy to do by accident when both are unlabelled loopback
   * tunnels.
   */
  bridgeAuthority: string;
  resolved: ResolveResponse | null;
  error: FailurePayload | null;
}

/**
 * A candidate plus the host it belongs to. `hostIndex` indexes
 * `MultiResolveResponse.hosts`, which is where the PR, project, provider and
 * mode lists for this candidate live — all four are per-host and must not be
 * read off a different slice than the one being sent to.
 */
export interface MergedCandidate extends Candidate {
  hostIndex: number;
}

export interface MultiResolveResponse {
  hosts: HostSlice[];
  /** Every candidate from every host that answered, re-ranked across hosts. */
  candidates: MergedCandidate[];
  /** -1 when nothing resolved anywhere. */
  defaultCandidateIndex: number;
}

/* -------------------------------------------------------------------------- */

/** Everything the UI is allowed to know about configuration. Never a token. */
export interface PublicSettings {
  defaultProvider: string;
  /** One row per configured host, tokenless. */
  hosts: PublicHost[];
}

export interface PublicHost {
  id: string;
  /** Display name, never empty. */
  label: string;
  bridgeUrl: string;
  enabled: boolean;
  /** True when a non-empty token is stored. The value itself never leaves the worker. */
  hasToken: boolean;
}

export interface FailurePayload {
  code: string;
  /** Message from the bridge, or an extension-authored sentence. */
  message: string;
  /** `hint` from the bridge, if it sent one. */
  hint?: string;
  /** HTTP status, when there was a response at all. */
  status?: number;
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: FailurePayload };

export interface IntentResultMap {
  ping: PingResponse;
  resolve: MultiResolveResponse;
  send: SendResponse;
  getPublicSettings: PublicSettings;
  openOptions: { opened: true };
}

export type ResultFor<I extends Intent> = Result<IntentResultMap[I["type"]]>;
