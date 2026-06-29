/**
 * @file
 *
 * Reads and queries the user's Obsidian local configuration (`obsidian.json`).
 *
 * Used by the CDP transport's **attach** mode (targeting an already-running,
 * user-scope Obsidian). Harness-owned isolated instances write their own
 * `obsidian.json` directly into a temporary user-data dir and do not use these
 * helpers.
 */

import {
  readFileSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import {
  join,
  resolve
} from 'node:path';
import process from 'node:process';

/**
 * The top-level structure of Obsidian's `obsidian.json` config file.
 */
interface ObsidianJson {
  /**
   * Map of vault IDs to vault entries.
   */
  vaults: Record<string, ObsidianVaultEntry>;
}

/**
 * A single vault entry in `obsidian.json`.
 */
interface ObsidianVaultEntry {
  /**
   * The absolute path to the vault folder.
   */
  path: string;

  /**
   * Timestamp of the last access.
   */
  ts: number;
}

/**
 * Returns the platform-specific path to the **user's** Obsidian config (user-data)
 * directory — `%APPDATA%\obsidian` on Windows, `~/Library/Application Support/obsidian`
 * on macOS, `$XDG_CONFIG_HOME/obsidian` (or `~/.config/obsidian`) on Linux.
 *
 * This is the user-scope directory; harness-owned isolated instances use their
 * own temporary user-data dir instead.
 *
 * @returns The absolute path to the `obsidian/` config directory.
 */
export function getObsidianConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData) {
      return join(appData, 'obsidian');
    }
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'obsidian');
  }

  return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'obsidian');
}

/**
 * Returns the hex vault ID for a given vault path from Obsidian's registry.
 *
 * @param vaultPath - The absolute path to the vault folder.
 * @returns The vault ID, or `undefined` if the vault is not registered.
 */
export function getVaultId(vaultPath: string): string | undefined {
  const config = readObsidianJson();
  if (!config) {
    return undefined;
  }

  const normalizedTarget = normalizePath(vaultPath);

  for (const [id, entry] of Object.entries(config.vaults)) {
    if (normalizePath(entry.path) === normalizedTarget) {
      return id;
    }
  }

  return undefined;
}

/**
 * Checks whether a vault path is registered in Obsidian's vault registry.
 *
 * @param vaultPath - The absolute path to the vault folder.
 * @returns `true` if the vault is registered, `false` otherwise.
 */
export function isVaultRegistered(vaultPath: string): boolean {
  return getVaultId(vaultPath) !== undefined;
}

/**
 * Removes a vault entry from Obsidian's `obsidian.json` config file.
 *
 * @param vaultPath - The absolute path to the vault folder.
 * @returns `true` if the vault was found and removed, `false` otherwise.
 */
export function removeVaultFromConfig(vaultPath: string): boolean {
  const config = readObsidianJson();
  if (!config) {
    return false;
  }

  const normalizedTarget = normalizePath(vaultPath);
  let wasFound = false;

  for (const [id, entry] of Object.entries(config.vaults)) {
    if (normalizePath(entry.path) === normalizedTarget) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Removing a vault entry by its dynamic key.
      delete config.vaults[id];
      wasFound = true;
      break;
    }
  }

  if (wasFound) {
    writeObsidianJson(config);
  }

  return wasFound;
}

/**
 * Normalizes a vault path for comparison.
 * On Windows, paths are case-insensitive and separators may vary.
 *
 * @param vaultPath - The path to normalize.
 * @returns The normalized path.
 */
function normalizePath(vaultPath: string): string {
  const resolved = resolve(vaultPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Reads and parses Obsidian's `obsidian.json` config file.
 *
 * @returns The parsed config, or `undefined` if the file doesn't exist or can't be parsed.
 */
function readObsidianJson(): ObsidianJson | undefined {
  const configPath = join(getObsidianConfigDir(), 'obsidian.json');
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as ObsidianJson;
  } catch {
    return undefined;
  }
}

/**
 * Writes the given config object to Obsidian's `obsidian.json` file.
 *
 * @param config - The config to write.
 */
function writeObsidianJson(config: ObsidianJson): void {
  const configPath = join(getObsidianConfigDir(), 'obsidian.json');
  writeFileSync(configPath, JSON.stringify(config));
}
