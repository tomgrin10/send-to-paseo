/**
 * One held daemon connection, shared by every caller in this process
 * (one-held-daemon-connection, AGENTS.md).
 *
 * Concurrent callers join the open in flight. A real drop (the client's own
 * connection status, or a call that failed on a socket no longer `connected`)
 * retires it, and the next call opens one fresh connection. A failed open backs
 * off, and calls inside that window fail fast with the same error. A connection
 * older than `maxMs` is replaced once its in-flight calls finish. `close()` is
 * the plugin's teardown: nothing opens afterwards, so the subprocess can exit.
 *
 * With `keepWarm` the connection is also kept open between requests
 * (warm-daemon-connection, AGENTS.md), so the popover's click path never pays
 * for a connect: `warm()` opens it at plugin start, a drop or a failed open
 * reconnects in the background on the same backoff, and an aged connection
 * keeps serving until its replacement is connected. `run(work, { ifConnected:
 * true })` never waits on a connect: with no connected client it starts one and
 * fails at once with `code: "not_connected"`.
 */

export interface Closable {
  close(): Promise<void>;
}

type ConnectionStatus = { status: string };
type StatusSource = {
  getConnectionState?(): ConnectionStatus;
  subscribeConnectionStatus?(listener: (state: ConnectionStatus) => void): () => void;
};

export interface RunOptions {
  /** Fail at once (`code: "not_connected"`) instead of waiting for a connect. */
  ifConnected?: boolean;
}

export interface SharedDaemon<C extends Closable> {
  run<T>(work: (client: C) => Promise<T>, options?: RunOptions): Promise<T>;
  /** Opens the connection in the background if none is open or opening. Never throws. */
  warm(): void;
  close(): Promise<void>;
}

export const SHARED_CLIENT_MAX_MS = 30 * 60_000;
export const OPEN_BACKOFF_MS = 1_000;
export const OPEN_BACKOFF_MAX_MS = 30_000;

export class NotConnectedError extends Error {
  readonly code = "not_connected";
  constructor() { super("The Paseo daemon connection is not open yet."); }
}

export function sharedDaemon<C extends Closable>(
  open: () => Promise<C>,
  options: { maxMs?: number; now?: () => number; backoffMs?: number; backoffMaxMs?: number; stopping?: () => Error; keepWarm?: boolean } = {},
): SharedDaemon<C> {
  const maxMs = options.maxMs ?? SHARED_CLIENT_MAX_MS;
  const now = options.now ?? Date.now;
  const backoffMs = options.backoffMs ?? OPEN_BACKOFF_MS;
  const backoffMaxMs = options.backoffMaxMs ?? OPEN_BACKOFF_MAX_MS;
  const stopping = options.stopping ?? (() => new Error("Send to Paseo is stopping."));
  const keepWarm = options.keepWarm === true;
  type Entry = { client: Promise<C>; ready: C | null; opened: number; users: number; retired: boolean; unsubscribe?: () => void };
  let current: Entry | null = null;
  /** The replacement for an aged `current`, opening while `current` keeps serving. */
  let next: Entry | null = null;
  let stopped = false;
  let failures = 0;
  let retryAt = 0;
  let lastError: unknown = null;
  // A one-shot, unref'd timer for the background reconnect, cleared in close(): it never keeps
  // the subprocess alive and never outlives teardown (AGENTS.md forbids live timers here).
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const all = new Set<Entry>();

  const live = (client: C) => {
    const status = (client as unknown as StatusSource).getConnectionState?.().status;
    return status === undefined || status === "connected";
  };
  const shut = async (entry: Entry) => {
    all.delete(entry);
    if (current === entry) current = null;
    if (next === entry) next = null;
    entry.unsubscribe?.();
    const client = await entry.client.catch(() => null);
    if (client) await client.close().catch(() => undefined);
  };
  const scheduleWarm = () => {
    if (!keepWarm || stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; warm(); }, Math.max(0, retryAt - now()));
    retryTimer.unref?.();
  };
  const retire = (entry: Entry) => {
    if (entry.retired) return;
    entry.retired = true;
    if (current === entry) current = null;
    if (next === entry) next = null;
    if (entry.users === 0) void shut(entry);
    if (!current && !next) scheduleWarm();
  };

  const start = (): Entry => {
    const entry = { opened: now(), users: 0, retired: false, ready: null } as Entry;
    entry.client = open().then(
      (client) => {
        failures = 0;
        if (stopped) {
          void client.close().catch(() => undefined);
          throw stopping();
        }
        entry.ready = client;
        entry.unsubscribe = (client as unknown as StatusSource).subscribeConnectionStatus?.((state) => {
          if (state.status === "disconnected" || state.status === "disposed") retire(entry);
        });
        if (next === entry) {
          // The replacement is connected: it takes over, and the aged one closes once idle.
          next = null;
          const aged = current;
          current = entry;
          if (aged) retire(aged);
        }
        return client;
      },
      (error: unknown) => {
        failures++;
        lastError = error;
        retryAt = now() + Math.min(backoffMs * 2 ** (failures - 1), backoffMaxMs);
        all.delete(entry);
        if (current === entry) current = null;
        if (next === entry) next = null;
        if (!current) scheduleWarm();
        throw error;
      },
    );
    // A background open's failure is recorded above; nobody else awaits it.
    entry.client.catch(() => undefined);
    all.add(entry);
    return entry;
  };

  /** The entry a call should use now, opening or rotating as needed. Null inside the open backoff. */
  const select = (): Entry | null => {
    if (current && now() - current.opened >= maxMs) {
      if (keepWarm && current.ready && live(current.ready)) {
        // Rotate without a gap: keep serving on the aged connection until the new one is up.
        if (!next && !(failures > 0 && now() < retryAt)) next = start();
      } else {
        retire(current);
      }
    }
    if (!current) {
      if (failures > 0 && now() < retryAt) return null;
      current = start();
    }
    return current;
  };

  function warm(): void {
    if (stopped) return;
    try { select(); } catch { /* recorded by start() */ }
  }

  const run = async <T>(work: (client: C) => Promise<T>, runOptions: RunOptions = {}): Promise<T> => {
    if (stopped) throw stopping();
    const entry = select();
    if (!entry) {
      if (runOptions.ifConnected) throw new NotConnectedError();
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    if (runOptions.ifConnected && !(entry.ready && live(entry.ready))) throw new NotConnectedError();
    entry.users++;
    try {
      const client = await entry.client;
      try {
        return await work(client);
      } catch (error) {
        if (!live(client)) retire(entry);
        throw error;
      }
    } finally {
      entry.users--;
      if (entry.retired && entry.users === 0 && all.has(entry)) void shut(entry);
    }
  };

  const close = async () => {
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    await Promise.allSettled([...all].map((entry) => shut(entry)));
  };
  return { run, warm, close };
}
