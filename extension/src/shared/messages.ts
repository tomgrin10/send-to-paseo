/**
 * The content-script <-> service-worker protocol.
 *
 * SECURITY: no message in either direction ever carries the bearer token. The
 * content script posts *intents*; the service worker owns the credential and
 * performs every fetch. See README "Security model".
 */

import type {
  PingResponse,
  PrRef,
  ResolveResponse,
  SendResponse,
  SendTarget,
} from "./contract";

export interface IntentPing {
  type: "ping";
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

/** Everything the UI is allowed to know about configuration. Never the token. */
export interface PublicSettings {
  bridgeUrl: string;
  defaultProvider: string;
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
  resolve: ResolveResponse;
  send: SendResponse;
  getPublicSettings: PublicSettings;
  openOptions: { opened: true };
}

export type ResultFor<I extends Intent> = Result<IntentResultMap[I["type"]]>;
