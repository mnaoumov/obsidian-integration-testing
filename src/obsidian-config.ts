/**
 * @file
 *
 * Reads and queries Obsidian's local configuration (`obsidian.json`).
 */

import { randomBytes } from 'node:crypto';
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
 * A registered vault entry returned by {@link getRegisteredVaults}.
 */
export interface RegisteredVault {
  /**
   * The hex vault ID from `obsidian.json`.
   */
  id: string;

  /**
   * Whether the vault is currently marked as open.
   */
  open: boolean;

  /**
   * The absolute path to the vault folder.
   */
  path: string;
}

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
 * Enables the CLI in Obsidian's `obsidian.json` config file.
 *
 * Sets `cli: true` so that Obsidian starts its CLI server on next launch.
 * If the config file doesn't exist, creates it with an empty vaults object.
 */
export function enableCliInConfig(): void {
  const config = readObsidianJson() ?? { vaults: {} };
  config.cli = true;
  writeObsidianJson(config);
}

/**
 * Returns the path of any vault that is currently registered in Obsidian's registry.
 *
 * This is useful when an `obsidian eval` call must run inside an existing vault
 * window (e.g., to issue IPC commands that register or remove other vaults).
 *
 * @returns The absolute path to a registered vault, or `undefined` if no vaults are registered.
 */
export function getAnyRegisteredVaultPath(): string | undefined {
  const config = readObsidianJson();
  if (!config) {
    return undefined;
  }

  const firstEntry = Object.values(config.vaults)[0];
  return firstEntry?.path;
}

/**
 * Returns all registered vaults from Obsidian's `obsidian.json` registry.
 *
 * @returns An array of registered vault entries.
 */
export function getRegisteredVaults(): RegisteredVault[] {
  const config = readObsidianJson();
  if (!config) {
    return [];
  }

  return Object.entries(config.vaults).map(([id, entry]) => ({
    id,
    open: entry.open === true,
    path: entry.path
  }));
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
 * Checks whether a vault is marked as open in Obsidian's vault registry.
 *
 * Note: This checks the `open` flag in `obsidian.json`, which is updated
 * asynchronously by Obsidian. It may not reflect the current runtime state.
 *
 * @param vaultPath - The absolute path to the vault folder.
 * @returns `true` if the vault is registered and marked as open, `false` otherwise.
 */
export function isVaultOpen(vaultPath: string): boolean {
  const config = readObsidianJson();
  if (!config) {
    return false;
  }

  const normalizedTarget = normalizePath(vaultPath);

  for (const entry of Object.values(config.vaults)) {
    if (normalizePath(entry.path) === normalizedTarget) {
      return entry.open === true;
    }
  }

  return false;
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
 * Registers a vault directly in Obsidian's `obsidian.json` config file.
 *
 * This writes a new vault entry with a random hex ID. Used when no existing
 * vault is available to send IPC commands through — the vault is registered
 * "offline" so Obsidian will open it on next launch.
 *
 * @param vaultPath - The absolute path to the vault folder.
 */
export function registerVaultInConfig(vaultPath: string): void {
  const config = readObsidianJson() ?? { vaults: {} };
  const VAULT_ID_BYTE_LENGTH = 8;
  const id = randomBytes(VAULT_ID_BYTE_LENGTH).toString('hex');
  config.vaults[id] = { path: vaultPath, ts: Date.now() };
  config.cli = true;
  writeObsidianJson(config);
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

/**
 * Writes the given config object to Obsidian's `obsidian.json` file.
 *
 * @param config - The config to write.
 */
function writeObsidianJson(config: ObsidianJson): void {
  const configPath = join(getObsidianConfigDir(), 'obsidian.json');
  writeFileSync(configPath, JSON.stringify(config));
}
