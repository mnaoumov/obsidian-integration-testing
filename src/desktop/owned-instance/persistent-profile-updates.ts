/**
 * @file
 *
 * Keeps Obsidian's own updater state in a **persistent** user-data profile from
 * overriding the version a run asked for.
 *
 * The shell's `main.js` (read from the 1.15 installer's `app.asar`) loads the
 * highest-versioned `obsidian-<version>.asar` it finds in the user-data directory,
 * whenever that version is not older than the shell, in place of the bundled app. Its
 * updater downloads new versions into that same directory every hour, and deletes
 * every `obsidian-*.asar` that is neither running nor the latest. A temporary profile
 * starts empty and is seeded with `updateDisabled: true`, so it never meets either. A
 * kept profile does: an updater download from an earlier session silently replaced a
 * pinned `obsidianVersion`, and a run left the updater free to download another.
 *
 * So for the length of a run the harness:
 *
 * - **holds the profile's `obsidian-*.asar` files aside**, in
 *   {@link PERSISTENT_PROFILE_HELD_ASARS_DIRECTORY_NAME}, before it provisions the
 *   asar the run asked for, so the shell can only load that asar or its own bundled
 *   app; and
 * - **sets `updateDisabled: true` in `obsidian.json`** (the merge does it, see
 *   `mergePersistentObsidianJson`), which the app reads at startup to stop its
 *   updater.
 *
 * Both are undone on dispose: the run's own `obsidian-*.asar` files are removed, the
 * held ones put back, and `updateDisabled` returned to the value the profile had. The
 * original value is written into the hold directory, so a run that was killed before
 * it could restore is restored by the next run on that profile, before it holds again.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import { log } from '../../log.ts';

/**
 * The directory inside a persistent profile where its `obsidian-*.asar` files wait out a run.
 */
export const PERSISTENT_PROFILE_HELD_ASARS_DIRECTORY_NAME = 'obsidian-integration-testing-held-asars';

/**
 * The file in the hold directory recording the profile's own `updateDisabled`.
 */
export const PERSISTENT_PROFILE_HOLD_STATE_FILE_NAME = 'state.json';

const OBSIDIAN_JSON_FILE_NAME = 'obsidian.json';
const UPDATED_ASAR_FILE_NAME_PATTERN = /^obsidian-.+\.asar$/u;

/**
 * What the hold directory records about the profile before the run changed it.
 */
export interface PersistentProfileHoldState extends PersistentProfileUpdateDisabledState {
  /**
   * The `obsidian-*.asar` files held aside: the profile's own, which the restore keeps.
   */
  readonly heldAsarFileNames: readonly string[];
}

/**
 * The profile's own `updateDisabled`, before the run set it.
 */
export interface PersistentProfileUpdateDisabledState {
  /**
   * Whether the profile's `obsidian.json` carried an `updateDisabled` key.
   */
  readonly hadUpdateDisabled: boolean;

  /**
   * That key's value, when it carried one.
   */
  readonly updateDisabled?: unknown;
}

/**
 * Puts a registry's `updateDisabled` back to what the profile had before the run.
 *
 * @param existing - The profile's current `obsidian.json`, parsed.
 * @param state - What the profile had.
 * @returns The registry to write back, or `null` when `existing` is not an object (nothing to restore into).
 */
export function applyUpdateDisabledRestore(existing: unknown, state: PersistentProfileHoldState): null | Record<string, unknown> {
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
    return null;
  }
  const { updateDisabled: _updateDisabled, ...rest } = existing as Record<string, unknown>;
  return state.hadUpdateDisabled ? { ...rest, updateDisabled: state.updateDisabled } : rest;
}

/**
 * Whether a file name is one the shell would load as an updated app.
 *
 * @param fileName - A file name in the user-data directory.
 * @returns `true` for `obsidian-<version>.asar`.
 */
export function checkIsUpdatedAsarFileName(fileName: string): boolean {
  return UPDATED_ASAR_FILE_NAME_PATTERN.test(fileName);
}

/**
 * Holds a persistent profile's updater state aside for a run: first restores a hold
 * a killed run left behind, then records the profile's `updateDisabled` and moves its
 * `obsidian-*.asar` files into the hold directory. Call it after taking the profile's
 * lock and before provisioning the run's asar or writing `obsidian.json`.
 *
 * @param userDataDirectory - The persistent profile directory (must exist).
 * @returns A function that restores the profile; call it once the instance is dead.
 */
export function holdPersistentProfileUpdates(userDataDirectory: string): () => void {
  const heldDirectory = join(userDataDirectory, PERSISTENT_PROFILE_HELD_ASARS_DIRECTORY_NAME);
  if (existsSync(heldDirectory)) {
    restorePersistentProfileUpdates(userDataDirectory);
    log(`[persistent-profile] Restored the updater state a previous run left held aside in ${userDataDirectory}.`);
  }

  mkdirSync(heldDirectory, { recursive: true });
  const asarFileNames = listUpdatedAsarFileNames(userDataDirectory);
  // Written before anything moves, so a run killed mid-hold still restores exactly what the profile had.
  const state: PersistentProfileHoldState = { ...readUpdateDisabledState(userDataDirectory), heldAsarFileNames: asarFileNames };
  writeFileSync(join(heldDirectory, PERSISTENT_PROFILE_HOLD_STATE_FILE_NAME), JSON.stringify(state));

  for (const fileName of asarFileNames) {
    renameSync(join(userDataDirectory, fileName), join(heldDirectory, fileName));
  }
  if (asarFileNames.length > 0) {
    log(
      `[persistent-profile] Held ${asarFileNames.join(', ')} aside for this run, so the shell loads only the version the run asked for; `
        + 'they are put back on dispose.'
    );
  }

  return (): void => {
    restorePersistentProfileUpdates(userDataDirectory);
  };
}

/**
 * Undoes {@link holdPersistentProfileUpdates}: removes the `obsidian-*.asar` files the
 * run left in the profile, puts the held ones back, and restores `updateDisabled`.
 * Does nothing when the profile holds nothing aside.
 *
 * @param userDataDirectory - The persistent profile directory.
 */
export function restorePersistentProfileUpdates(userDataDirectory: string): void {
  const heldDirectory = join(userDataDirectory, PERSISTENT_PROFILE_HELD_ASARS_DIRECTORY_NAME);
  if (!existsSync(heldDirectory)) {
    return;
  }

  const state = readJson(join(heldDirectory, PERSISTENT_PROFILE_HOLD_STATE_FILE_NAME));
  const profileAsarFileNames = new Set(isHoldState(state) ? state.heldAsarFileNames : listUpdatedAsarFileNames(heldDirectory));

  // Every step below can be repeated after a failure part-way (a file Windows still holds), so a retry, or the next run, finishes the job.
  // The run's own asar files go: the one the harness provisioned, and anything an updater wrote despite the flag.
  for (const fileName of listUpdatedAsarFileNames(userDataDirectory)) {
    if (!profileAsarFileNames.has(fileName)) {
      rmSync(join(userDataDirectory, fileName), { force: true });
    }
  }
  // The held copy is the profile's own, so it wins over a run's copy of the same version.
  for (const fileName of listUpdatedAsarFileNames(heldDirectory)) {
    rmSync(join(userDataDirectory, fileName), { force: true });
    renameSync(join(heldDirectory, fileName), join(userDataDirectory, fileName));
  }

  if (isHoldState(state)) {
    const obsidianJsonPath = join(userDataDirectory, OBSIDIAN_JSON_FILE_NAME);
    const restored = applyUpdateDisabledRestore(readJson(obsidianJsonPath), state);
    if (restored) {
      writeFileSync(obsidianJsonPath, JSON.stringify(restored));
    }
  }

  rmSync(heldDirectory, { force: true, recursive: true });
}

function isHoldState(value: unknown): value is PersistentProfileHoldState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const names = record['heldAsarFileNames'];
  return typeof record['hadUpdateDisabled'] === 'boolean' && Array.isArray(names) && names.every((name) => typeof name === 'string');
}

function listUpdatedAsarFileNames(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && checkIsUpdatedAsarFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function readUpdateDisabledState(userDataDirectory: string): PersistentProfileUpdateDisabledState {
  const existing = readJson(join(userDataDirectory, OBSIDIAN_JSON_FILE_NAME));
  return typeof existing !== 'object' || existing === null || Array.isArray(existing) || !Object.hasOwn(existing, 'updateDisabled') ? { hadUpdateDisabled: false } : { hadUpdateDisabled: true, updateDisabled: (existing as Record<string, unknown>)['updateDisabled'] };
}
