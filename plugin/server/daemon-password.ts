import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PASSWORD_ENV_KEYS = ["SEND_TO_PASEO_DAEMON_PASSWORD", "PASEO_PASSWORD"] as const;
const PASSWORD_FILE_PARTS = ["paseo-hub", "secrets", "daemon-password"] as const;

interface PasswordSourceOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** The VM convention for a daemon password shared with local automation. */
export function daemonPasswordFile(home: string = homedir()): string {
  return join(home, ...PASSWORD_FILE_PARTS);
}

/**
 * Resolve a daemon password without ever logging or returning source metadata.
 *
 * Explicit process configuration wins, followed by the VM secret file, then
 * the plugin's existing settings value. Missing, unreadable and blank secret
 * files are deliberately indistinguishable and fall through to settings.
 */
export async function resolveDaemonPassword(
  readSettingsPassword: () => Promise<string | null | undefined>,
  options: PasswordSourceOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  for (const key of PASSWORD_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
  }

  try {
    const value = (await readFile(daemonPasswordFile(options.home), "utf8")).trim();
    if (value !== "") return value;
  } catch {
    // A host without the VM secret convention keeps using plugin settings.
  }

  const stored = await readSettingsPassword().catch(() => null);
  return stored === null || stored === undefined || stored === "" ? undefined : stored;
}
