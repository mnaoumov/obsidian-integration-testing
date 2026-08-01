/**
 * @file
 *
 * Sweeps the temporary directories a previous integration run leaked — the
 * `temp-vault-*` staging/vault directories and the owned instance's
 * `userdata-*` Chromium profiles.
 *
 * A run that dies mid-flight cannot clean up after itself: on Android the
 * teardown talks to the WebView, and a dead WebView is exactly what most
 * failures are (`Vault cleanup error (non-fatal): no such window`). Every
 * failure therefore leaks a vault, every leaked vault stays registered for
 * Obsidian to enumerate at startup, and that enumeration has to finish inside
 * the WebView-readiness budget — so each failure makes the next one likelier.
 * Sweeping foreign residue at the START of a run breaks that loop, because it
 * runs before anything that can die.
 *
 * The two sides use deliberately different safety gates (see the repo's L31):
 *
 * - **Device (Android)** — unconditional. Android runs hold the exclusive
 *   `android` setup lock, so no concurrent run can own a device vault, and an
 *   age gate would let a vault leaked ten minutes ago survive into the next run.
 * - **Host** — age-gated. Desktop runs are deliberately *not* serialized (each
 *   owns an isolated instance) and every project on the machine shares one
 *   `tmpdir()`, so a directory young enough to belong to a live run is left
 *   alone.
 */

import {
  readdir,
  rm,
  stat
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ObsidianTransportOptions } from './transport-options.ts';

/**
 * Default for the `leftoverMaxAgeInMilliseconds` transport option — two hours.
 */
export const DEFAULT_LEFTOVER_MAX_AGE_IN_MILLISECONDS = 7200000;

/**
 * Name of the harness's own directory inside {@link tmpdir}, which holds the
 * owned instances' user-data directories alongside the version/installer caches
 * and the setup locks.
 */
export const HARNESS_TEMP_DIR_NAME = 'obsidian-integration-testing';

/**
 * Prefix of an owned desktop instance's isolated user-data directory.
 */
export const OWNED_USER_DATA_DIR_PREFIX = 'userdata-';

/**
 * Prefix of a temporary vault directory, both on the host (where it is created)
 * and on an Android device (where it keeps its host basename).
 */
export const TEMP_VAULT_DIR_PREFIX = 'temp-vault-';

/**
 * Parameters for {@link checkIsLeftoverStale}.
 */
export interface CheckIsLeftoverStaleParams {
  /**
   * How old an entry must be to count as stale. `0` disables the gate, making
   * every entry stale.
   */
  readonly maxAgeInMilliseconds: number;

  /** The entry's modification time, in epoch milliseconds. */
  readonly modifiedAtInMilliseconds: number;

  /** The current time, in epoch milliseconds. */
  readonly nowInMilliseconds: number;
}

/**
 * Parameters for {@link filterLeftoverNames}.
 */
export interface FilterLeftoverNamesParams {
  /** Names to keep even when they match a prefix (e.g. the current run's own vault). */
  readonly excludedNames?: readonly string[] | undefined;

  /**
   * Raw entry names. Accepts `adb shell ls` output split into lines, so each
   * name is trimmed (dropping the trailing `\r` an `adb` shell adds on Windows)
   * and blank lines are dropped.
   */
  readonly names: readonly string[];

  /** Directory-name prefixes that mark an entry as the harness's own residue. */
  readonly prefixes: readonly string[];
}

/**
 * A directory the host sweep scans, together with the prefixes that mark
 * residue inside it.
 */
export interface LeftoverRoot {
  /** The absolute path to scan. */
  readonly path: string;

  /** Directory-name prefixes that mark an entry as removable residue. */
  readonly prefixes: readonly string[];
}

/**
 * Parameters for {@link sweepDeviceLeftovers}.
 */
export interface SweepDeviceLeftoversParams {
  /**
   * Lists the entry names directly under the vault base path. A listing failure
   * must resolve to an empty list rather than reject — a device with no vault
   * directory yet is the normal first-run state, not an error.
   */
  readonly listNames: () => Promise<readonly string[]>;

  /**
   * Removes ONE directory, by absolute device path. May reject; the caller
   * treats a rejection as this directory failing and moves on to the next.
   */
  readonly removeDir: (path: string) => Promise<void>;

  /** The absolute device path the vaults sit under, including its trailing separator. */
  readonly vaultBasePath: string;
}

/**
 * Result of {@link sweepDeviceLeftovers}.
 */
export interface SweepDeviceLeftoversResult {
  /**
   * The names that were still present after the sweep. Named rather than
   * counted, because the interesting case is a directory that fails EVERY run
   * and a caller can only say so if it knows which one.
   */
  readonly failedNames: string[];

  /** How many directories are verifiably gone. */
  readonly removedCount: number;
}

/**
 * Options for {@link sweepHostLeftovers}.
 */
export interface SweepHostLeftoversOptions {
  /** Names to keep regardless of age (e.g. the current run's own directories). */
  readonly excludedNames?: readonly string[] | undefined;

  /**
   * How old a directory must be before it is removed. `0` removes every match.
   *
   * @default {@link DEFAULT_LEFTOVER_MAX_AGE_IN_MILLISECONDS}
   */
  readonly maxAgeInMilliseconds?: number | undefined;

  /**
   * The roots to sweep. Defaults to the temp-vault root ({@link tmpdir}) and the
   * owned user-data root (`<tmpdir>/{@link HARNESS_TEMP_DIR_NAME}`).
   */
  readonly roots?: readonly LeftoverRoot[] | undefined;
}

/**
 * Result of {@link sweepHostLeftovers}.
 */
export interface SweepHostLeftoversResult {
  /** How many directories were selected for removal but could not be removed. */
  readonly failedCount: number;

  /** How many directories were removed. */
  readonly removedCount: number;
}

/**
 * Parameters for {@link checkIsRemovableDir}.
 */
interface CheckIsRemovableDirParams {
  /** How old the entry must be to be removed (`0` disables the gate). */
  readonly maxAgeInMilliseconds: number;

  /** The sweep's reference time, in epoch milliseconds. */
  readonly nowInMilliseconds: number;

  /** The absolute path to the entry. */
  readonly path: string;
}

/**
 * Decides whether a leftover entry is old enough to be removed.
 *
 * The gate exists because every project on the machine shares one `tmpdir()`
 * and desktop runs are not serialized, so a young directory may well belong to
 * a run that is still in flight. An entry whose modification time is in the
 * future (a clock skew) is treated as live for the same reason.
 *
 * @param params - The age comparison inputs.
 * @returns `true` when the entry may be removed.
 */
export function checkIsLeftoverStale(params: CheckIsLeftoverStaleParams): boolean {
  if (params.maxAgeInMilliseconds === 0) {
    return true;
  }

  return params.nowInMilliseconds - params.modifiedAtInMilliseconds >= params.maxAgeInMilliseconds;
}

/**
 * Selects the entry names that are the harness's own residue.
 *
 * Name-only, so the caller can filter a large directory listing before paying
 * for a `stat` per entry, and so the Android sweep can feed it raw
 * `adb shell ls` output.
 *
 * @param params - The names, prefixes, and exclusions.
 * @returns The matching names, trimmed.
 */
export function filterLeftoverNames(params: FilterLeftoverNamesParams): string[] {
  const excludedNames = params.excludedNames ?? [];
  return params.names
    .map((name) => name.trim())
    .filter((name) => params.prefixes.some((prefix) => name.startsWith(prefix)))
    .filter((name) => !excludedNames.includes(name));
}

/**
 * Resolves the leftover age gate, applying the default when the option is
 * omitted.
 *
 * @param options - The transport options.
 * @returns The max age in milliseconds (`0` disables the gate).
 */
export function resolveLeftoverMaxAgeInMilliseconds(options: ObsidianTransportOptions | undefined): number {
  return options?.leftoverMaxAgeInMilliseconds ?? DEFAULT_LEFTOVER_MAX_AGE_IN_MILLISECONDS;
}

/**
 * Resolves whether leftover directories are swept, applying the default when
 * the option is omitted.
 *
 * @param options - The transport options.
 * @returns `true` when the sweeps should run.
 */
export function resolveShouldSweepLeftovers(options: ObsidianTransportOptions | undefined): boolean {
  return options?.shouldSweepLeftovers ?? true;
}

/**
 * Removes the leftover vault directories a device is carrying, one directory at
 * a time, and reports what is verifiably gone.
 *
 * **One directory per removal, and a failure is non-fatal.** Removing the whole
 * set in a single `rm -rf` lets one un-removable entry decide the fate of every
 * other: a name that the FUSE layer cannot express (an Android emulator can
 * produce one — `rm -rf`, `find -delete` and force-stopping Obsidian first all
 * answer `Operation not permitted`) is permanent, so a sweep that gives up on it
 * gives up forever, and the residue only grows. Per-directory, that entry costs
 * one warning per run instead of the whole sweep.
 *
 * **The result is measured, not assumed.** The directories are re-listed
 * afterwards and only the ones that actually disappeared are counted, because
 * the failure this was written for was a sweep that reported success while
 * clearing nothing — a removal command can exit non-zero, or partially succeed,
 * and neither is visible from its exit code alone.
 *
 * @param params - How to list and remove, and the base path to sweep.
 * @returns The verified removal count and the names that survived.
 */
export async function sweepDeviceLeftovers(
  params: SweepDeviceLeftoversParams
): Promise<SweepDeviceLeftoversResult> {
  const { listNames, removeDir, vaultBasePath } = params;

  const names = filterLeftoverNames({ names: await listNames(), prefixes: [TEMP_VAULT_DIR_PREFIX] });
  if (names.length === 0) {
    return { failedNames: [], removedCount: 0 };
  }

  for (const name of names) {
    try {
      await removeDir(`${vaultBasePath}${name}`);
    } catch {
      // Non-fatal by design: the next directory still gets its chance.
    }
  }

  const survivingNames = filterLeftoverNames({ names: await listNames(), prefixes: [TEMP_VAULT_DIR_PREFIX] });
  const failedNames = names.filter((name) => survivingNames.includes(name));

  return { failedNames, removedCount: names.length - failedNames.length };
}

/**
 * Removes the host-side directories left behind by earlier runs.
 *
 * Best-effort throughout: an unreadable root, an entry that cannot be `stat`ed,
 * and a directory that refuses to be removed (a live process still holding a
 * handle answers `EPERM` on Windows) are all skipped rather than thrown, so a
 * sweep can never fail the run it is cleaning up for.
 *
 * @param options - The sweep options.
 * @returns How many directories were removed, and how many resisted removal.
 */
export async function sweepHostLeftovers(options?: SweepHostLeftoversOptions): Promise<SweepHostLeftoversResult> {
  const maxAgeInMilliseconds = options?.maxAgeInMilliseconds ?? DEFAULT_LEFTOVER_MAX_AGE_IN_MILLISECONDS;
  const nowInMilliseconds = Date.now();
  const roots = options?.roots ?? getDefaultLeftoverRoots();

  let failedCount = 0;
  let removedCount = 0;

  for (const root of roots) {
    const names = filterLeftoverNames({
      excludedNames: options?.excludedNames,
      names: await readDirNames(root.path),
      prefixes: root.prefixes
    });

    for (const name of names) {
      const path = join(root.path, name);
      if (!await checkIsRemovableDir({ maxAgeInMilliseconds, nowInMilliseconds, path })) {
        continue;
      }

      try {
        await rm(path, { force: true, recursive: true });
        removedCount++;
      } catch {
        failedCount++;
      }
    }
  }

  return { failedCount, removedCount };
}

/**
 * Checks whether a matched entry is a directory old enough to remove.
 *
 * @param params - The entry path and age-gate inputs.
 * @returns `true` when the entry may be removed.
 */
async function checkIsRemovableDir(params: CheckIsRemovableDirParams): Promise<boolean> {
  const { maxAgeInMilliseconds, nowInMilliseconds } = params;
  try {
    const stats = await stat(params.path);
    return stats.isDirectory()
      && checkIsLeftoverStale({ maxAgeInMilliseconds, modifiedAtInMilliseconds: stats.mtimeMs, nowInMilliseconds });
  } catch {
    // Vanished, or unreadable — either way it is not ours to remove.
    return false;
  }
}

/**
 * Returns the roots swept when the caller does not name its own.
 *
 * @returns The temp-vault root and the owned user-data root.
 */
function getDefaultLeftoverRoots(): LeftoverRoot[] {
  return [
    { path: tmpdir(), prefixes: [TEMP_VAULT_DIR_PREFIX] },
    { path: join(tmpdir(), HARNESS_TEMP_DIR_NAME), prefixes: [OWNED_USER_DATA_DIR_PREFIX] }
  ];
}

/**
 * Lists a directory's entry names, treating an unreadable directory as empty.
 *
 * @param path - The absolute path to list.
 * @returns The entry names, or an empty list.
 */
async function readDirNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
