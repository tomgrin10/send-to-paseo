import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_PORT, RecentSendSchema, type RecentSend } from "./contracts.shared";

/**
 * The bridge's own state: the pairing token, the port, the default provider
 * and a short send history for the Paseo surface.
 *
 * The token controls an endpoint that can start agents, so the file is written
 * `0600` inside a `0700` directory and is never logged, echoed into an error,
 * or included in a status payload. Only the explicit reveal RPC returns it.
 */

const SettingsSchema = z.object({
  version: z.literal(1),
  token: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** `provider/model`, or null to follow the daemon's own default. */
  defaultProvider: z.string().nullable(),
  /**
   * A Paseo agent profile id (`daemon.agentProfiles[].id`) to follow, or null.
   *
   * Both of these are `.default(null)` rather than required so that a
   * settings.json written before permission modes existed still validates. A
   * failed parse regenerates the file — and with it the pairing token — which
   * would silently unpair the extension on upgrade.
   */
  defaultProfileId: z.string().nullable().default(null),
  /** Permission mode override, or null to follow the resolution chain. */
  defaultModeId: z.string().nullable().default(null),
  /** Advisory: flipped true after the first authenticated request succeeds. */
  paired: z.boolean(),
  /** Newest first, capped at RECENT_LIMIT. */
  recentSends: z.array(RecentSendSchema),
  /**
   * When non-empty, only these `chrome-extension://<id>` origins are accepted.
   * Empty means any extension origin, which is the documented default.
   */
  allowedExtensionIds: z.array(z.string()),
});

export type Settings = z.infer<typeof SettingsSchema>;

const RECENT_LIMIT = 20;

function dataDir(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "send-to-paseo");
}

const filePath = () => join(dataDir(), "settings.json");

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function defaults(): Settings {
  return {
    version: 1,
    token: newToken(),
    port: DEFAULT_PORT,
    defaultProvider: null,
    defaultProfileId: null,
    defaultModeId: null,
    paired: false,
    recentSends: [],
    allowedExtensionIds: [],
  };
}

/**
 * Single-writer store. HTTP requests and RPC handlers share one process, so a
 * promise chain is enough to keep read-modify-write sequences from interleaving
 * and losing a token rotation.
 */
let tail: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** In-memory copy so the hot auth path never touches the filesystem. */
let cached: Settings | null = null;

async function load(): Promise<Settings> {
  if (cached !== null) return cached;
  let parsed: Settings | null = null;
  try {
    const raw = await readFile(filePath(), "utf8");
    const result = SettingsSchema.safeParse(JSON.parse(raw));
    if (result.success) {
      parsed = result.data;
    } else {
      // Never log the file contents; it holds the token.
      console.error("[send-to-paseo] settings failed validation; regenerating");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error("[send-to-paseo] could not read settings; regenerating", code ?? "unknown");
    }
  }
  if (parsed === null) {
    parsed = defaults();
    await persist(parsed);
    console.log("[send-to-paseo] generated a new pairing token");
  }
  cached = parsed;
  return parsed;
}

async function persist(settings: Settings): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const target = filePath();
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, target);
  cached = settings;
}

export const settings = {
  read: (): Promise<Settings> => serialize(load),

  /** Applies a partial patch and persists. Returns the new settings. */
  update: (patch: Partial<Omit<Settings, "version">>): Promise<Settings> =>
    serialize(async () => {
      const current = await load();
      const next: Settings = { ...current, ...patch, version: 1 };
      await persist(next);
      return next;
    }),

  regenerateToken: (): Promise<Settings> =>
    serialize(async () => {
      const current = await load();
      // Rotation also un-pairs: the old extension copy no longer works.
      const next: Settings = { ...current, token: newToken(), paired: false };
      await persist(next);
      console.log("[send-to-paseo] pairing token regenerated");
      return next;
    }),

  markPaired: (): Promise<void> =>
    serialize(async () => {
      const current = await load();
      if (current.paired) return;
      await persist({ ...current, paired: true });
    }),

  recordSend: (entry: Omit<RecentSend, "id" | "at">): Promise<void> =>
    serialize(async () => {
      const current = await load();
      const row: RecentSend = { id: randomUUID(), at: new Date().toISOString(), ...entry };
      const recentSends = [row, ...current.recentSends].slice(0, RECENT_LIMIT);
      await persist({ ...current, recentSends });
    }),

  clearRecentSends: (): Promise<number> =>
    serialize(async () => {
      const current = await load();
      const removed = current.recentSends.length;
      if (removed > 0) await persist({ ...current, recentSends: [] });
      return removed;
    }),
};

/** Constant-time bearer comparison, so a wrong token leaks no timing signal. */
export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `Cg7x…9fQk`: enough to tell two tokens apart, not enough to use one. */
export function previewToken(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
