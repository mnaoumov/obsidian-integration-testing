/**
 * @file
 *
 * Reads and queries Obsidian's local configuration (`obsidian.json`).
 */

import { readFileSync } from 'node:fs';
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
   * Whether the CLI is enabled in Obsidian settings.
   */
  cli?: boolean;

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
   * Whether the vault is currently open.
   */
  open?: boolean;

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
 * Checks whether the Obsidian CLI is enabled in Obsidian's settings.
 *
 * @returns `true` if the CLI is enabled, `false` otherwise.
 */
export function isCliEnabled(): boolean {
  const config = readObsidianJson();
  return config?.cli === true;
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
 * Returns the platform-specific path to Obsidian's config directory.
 *
 * @returns The absolute path to the `obsidian/` config directory.
 */
function getObsidianConfigDir(): string {
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
