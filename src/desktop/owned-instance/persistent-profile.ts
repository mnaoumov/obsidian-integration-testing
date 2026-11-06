/**
 * @file
 *
 * A **persistent** user-data profile for an owned desktop instance: a directory the
 * caller keeps (and signs in to once, by hand), which the harness launches against
 * instead of a fresh temporary one. Used to drive Obsidian Sync and Obsidian Publish,
 * whose account and connection live in the profile's `localStorage` and IndexedDB.
 *
 * Two things differ from a temporary profile, and both live here as pure functions:
 *
 * - **`obsidian.json` is merged, never overwritten.** The profile's registry already
 *   lists the vault the owner connected to Sync, under the id Sync keys its
 *   connection to, so the vault is reused under that id, every other vault is kept,
 *   and only the auto-open markers and `updateDisabled` change (the latter only for
 *   the run, see `persistent-profile-updates.ts`).
 * - **One instance per profile.** Two Electron processes on one user-data directory
 *   corrupt each other's `localStorage`, and Electron's own single-instance lock would
 *   hand the second launch to the first and exit. So the harness takes a lock file in
 *   the profile and refuses a second run while the holder is alive.
 */

import {
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import { checkIsProcessAlive } from '../../process/process-liveness.ts';
import {
  areVaultPathsMatching,
  normalizeVaultPathForComparison
} from '../../vault/vault-path-match.ts';

/**
 * The lock file the harness keeps in a persistent profile while an owned instance runs on it.
 */
export const PERSISTENT_PROFILE_LOCK_FILE_NAME = 'obsidian-integration-testing.lock';

// The profiles THIS process holds: the lock file names a pid, and two transports in one process share it.
const heldProfiles = new Map<string, PersistentProfileLock>();

/**
 * Parameters for {@link mergePersistentObsidianJson}.
 */
export interface MergePersistentObsidianJsonParams {
  /**
   * The profile's current `obsidian.json`, parsed; anything that is not an object reads as an empty registry.
   */
  readonly existing: unknown;

  /**
   * The id to register the vault under when the registry does not already list it.
   */
  readonly newVaultId: string;

  /**
   * Whether the vault auto-opens. See `BuildOwnedObsidianJsonParams.shouldAutoOpenVault`.
   */
  readonly shouldAutoOpenVault: boolean;

  /**
   * Last-access timestamp to stamp on the vault entry.
   */
  readonly ts: number;

  /**
   * Absolute path to the vault to open.
   */
  readonly vaultPath: string;
}

/**
 * The merged registry, and the id the vault ended up under.
 */
export interface MergePersistentObsidianJsonResult {
  /**
   * The `obsidian.json` object to write back.
   */
  readonly json: Record<string, unknown>;

  /**
   * The vault's id: its existing one when the registry already listed it, else {@link MergePersistentObsidianJsonParams.newVaultId}.
   */
  readonly vaultId: string;
}

/**
 * Parameters for {@link PersistentProfileInUseError}.
 */
export interface PersistentProfileInUseErrorConstructorParams {
  /**
   * The lock's current holder.
   */
  readonly holder: PersistentProfileLock;

  /**
   * The profile directory.
   */
  readonly userDataDirectory: string;
}

/**
 * The contents of a persistent profile's lock file.
 */
export interface PersistentProfileLock {
  /**
   * The process that holds the profile.
   */
  readonly pid: number;

  /**
   * When it took the lock.
   */
  readonly startedAtInMilliseconds: number;
}

/**
 * Thrown when a second run asks for a persistent profile another live process holds.
 */
export class PersistentProfileInUseError extends Error {
  /**
   * Creates the error.
   *
   * @param params - The profile and its holder.
   */
  public constructor(params: PersistentProfileInUseErrorConstructorParams) {
    super(
      `The persistent user-data profile ${params.userDataDirectory} is already in use by process ${String(params.holder.pid)} `
        + `(since ${new Date(params.holder.startedAtInMilliseconds).toISOString()}). Two Obsidian instances on one profile `
        + 'corrupt its localStorage, so this run is refused. Wait for that run to end, or give this one a profile of its own.'
    );
    this.name = 'PersistentProfileInUseError';
  }
}

/**
 * Takes the profile's lock for this process, stealing a lock whose holder is gone.
 *
 * @param userDataDirectory - The persistent profile directory (must exist).
 * @returns A function that releases the lock, a no-op once another process has stolen it.
 * @throws PersistentProfileInUseError when a live process other than this one holds it.
 */
export function acquirePersistentProfileLock(userDataDirectory: string): () => void {
  const lockPath = join(userDataDirectory, PERSISTENT_PROFILE_LOCK_FILE_NAME);
  const key = normalizeVaultPathForComparison(userDataDirectory);
  const ownHolder = heldProfiles.get(key);
  if (ownHolder) {
    throw new PersistentProfileInUseError({ holder: ownHolder, userDataDirectory });
  }
  const holder = readPersistentProfileLock(lockPath);
  if (holder && holder.pid !== process.pid && checkIsProcessAlive(holder.pid)) {
    throw new PersistentProfileInUseError({ holder, userDataDirectory });
  }

  const lock: PersistentProfileLock = { pid: process.pid, startedAtInMilliseconds: Date.now() };
  writeFileSync(lockPath, JSON.stringify(lock));
  heldProfiles.set(key, lock);
  return (): void => {
    if (heldProfiles.get(key) !== lock) {
      return;
    }
    heldProfiles.delete(key);
    if (readPersistentProfileLock(lockPath)?.pid === process.pid) {
      rmSync(lockPath, { force: true });
    }
  };
}

/**
 * Merges the vault into a persistent profile's `obsidian.json`: reuses the id the
 * registry already gives that path (Sync keys its connection to it), keeps every
 * other vault and top-level key, takes the auto-open markers off every other vault,
 * and puts them on this one when asked to.
 *
 * @param params - The current registry and the vault to open.
 * @returns The registry to write and the vault's id.
 */
export function mergePersistentObsidianJson(params: MergePersistentObsidianJsonParams): MergePersistentObsidianJsonResult {
  const existing = isRecord(params.existing) ? params.existing : {};
  const existingVaults = isRecord(existing['vaults']) ? existing['vaults'] : {};

  let vaultId = params.newVaultId;
  const vaults: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(existingVaults)) {
    if (!isRecord(entry)) {
      vaults[id] = entry;
      continue;
    }
    if (typeof entry['path'] === 'string' && areVaultPathsMatching(entry['path'], params.vaultPath)) {
      vaultId = id;
    }
    const { open: _open, ...rest } = entry;
    vaults[id] = rest;
  }

  const ownEntryCandidate = vaults[vaultId];
  const ownEntry = isRecord(ownEntryCandidate) ? ownEntryCandidate : {};
  vaults[vaultId] = {
    ...ownEntry,
    ...params.shouldAutoOpenVault && { open: true },
    path: params.vaultPath,
    ts: params.ts
  };

  const { last_open: _lastOpen, ...rest } = existing;
  const json: Record<string, unknown> = {
    ...rest,
    // eslint-disable-next-line camelcase -- Obsidian's own obsidian.json field name (old versions' auto-open marker).
    ...params.shouldAutoOpenVault && { last_open: vaultId },
    // Stops the app's updater for the run; `restorePersistentProfileUpdates` puts the profile's own value back.
    updateDisabled: true,
    vaults
  };
  return { json, vaultId };
}

/**
 * Reads a persistent profile's lock file.
 *
 * @param lockPath - The lock file's path.
 * @returns The lock, or `undefined` when the file is missing or unreadable.
 */
export function readPersistentProfileLock(lockPath: string): PersistentProfileLock | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return undefined;
  }
  return !isRecord(parsed) || typeof parsed['pid'] !== 'number' || typeof parsed['startedAtInMilliseconds'] !== 'number' ? undefined : { pid: parsed['pid'], startedAtInMilliseconds: parsed['startedAtInMilliseconds'] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
