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
 */

export interface Closable {
  close(): Promise<void>;
}

type ConnectionStatus = { status: string };
type StatusSource = {
  getConnectionState?(): ConnectionStatus;
  subscribeConnectionStatus?(listener: (state: ConnectionStatus) => void): () => void;
};

export interface SharedDaemon<C extends Closable> {
  run<T>(work: (client: C) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const SHARED_CLIENT_MAX_MS = 30 * 60_000;
export const OPEN_BACKOFF_MS = 1_000;
export const OPEN_BACKOFF_MAX_MS = 30_000;

export function sharedDaemon<C extends Closable>(
  open: () => Promise<C>,
  options: { maxMs?: number; now?: () => number; backoffMs?: number; backoffMaxMs?: number; stopping?: () => Error } = {},
): SharedDaemon<C> {
  const maxMs = options.maxMs ?? SHARED_CLIENT_MAX_MS;
  const now = options.now ?? Date.now;
  const backoffMs = options.backoffMs ?? OPEN_BACKOFF_MS;
  const backoffMaxMs = options.backoffMaxMs ?? OPEN_BACKOFF_MAX_MS;
  const stopping = options.stopping ?? (() => new Error("Send to Paseo is stopping."));
  type Entry = { client: Promise<C>; opened: number; users: number; retired: boolean; unsubscribe?: () => void };
  let current: Entry | null = null;
  let stopped = false;
  let failures = 0;
  let retryAt = 0;
  let lastError: unknown = null;
  const all = new Set<Entry>();

  const shut = async (entry: Entry) => {
    all.delete(entry);
    if (current === entry) current = null;
    entry.unsubscribe?.();
    const client = await entry.client.catch(() => null);
    if (client) await client.close().catch(() => undefined);
  };
  const retire = (entry: Entry) => {
    entry.retired = true;
    if (current === entry) current = null;
    if (entry.users === 0) void shut(entry);
  };
  const live = (client: C) => {
    const status = (client as unknown as StatusSource).getConnectionState?.().status;
    return status === undefined || status === "connected";
  };

  const run = async <T>(work: (client: C) => Promise<T>): Promise<T> => {
    if (stopped) throw stopping();
    if (current && now() - current.opened >= maxMs) retire(current);
    if (!current) {
      if (failures > 0 && now() < retryAt) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      const entry = { opened: now(), users: 0, retired: false } as Entry;
      entry.client = open().then(
        (client) => {
          failures = 0;
          if (stopped) {
            void client.close().catch(() => undefined);
            throw stopping();
          }
          entry.unsubscribe = (client as unknown as StatusSource).subscribeConnectionStatus?.((state) => {
            if (state.status === "disconnected" || state.status === "disposed") retire(entry);
          });
          return client;
        },
        (error: unknown) => {
          failures++;
          lastError = error;
          retryAt = now() + Math.min(backoffMs * 2 ** (failures - 1), backoffMaxMs);
          all.delete(entry);
          if (current === entry) current = null;
          throw error;
        },
      );
      current = entry;
      all.add(entry);
    }
    const entry = current;
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
    await Promise.allSettled([...all].map((entry) => shut(entry)));
  };
  return { run, close };
}
