/**
 * @file
 *
 * Pure verdict on whether a booted owned Obsidian instance is actually running
 * the pinned app (asar) version, or **silently fell back** to the installer's own
 * bundled asar. Kept separate from the integration-only `transport-desktop-cdp`
 * (which reads the live version over CDP and is excluded from unit tests) so the
 * tier logic stays unit-testable — mirroring the `installer-compatibility` /
 * `electron-compatibility` / `renderer-boot-detection` split.
 *
 * When an asar is swapped onto an installer shell below its real boot floor, the
 * renderer does not always dead-boot (the black screen `renderer-boot-detection`
 * catches). Some app versions instead **silently revert to the installer's own
 * bundled asar** and render a perfectly healthy UI of the *wrong (older)* version.
 * The dead-boot detector reads that healthy UI as a false-positive "runnable" —
 * exactly how Obsidian `1.13.0` on installer `1.1.9` was first mis-measured (it
 * reports `apiVersion` `1.1.9`, not `1.13.0`).
 *
 * The discriminator is the **running** app version, read live post-boot
 * (`ipcRenderer.sendSync('version')` / `obsidianModule.apiVersion`, which both
 * track the asar actually running). This verdict compares it to the pinned
 * version: equal ⇒ `'match'`, different ⇒ `'fallback'` (the pin was not honored),
 * and `'unknown'` when either version is unavailable (no asar was swapped, or the
 * live version could not be read) — in which case nothing is thrown or warned.
 */

import { compareVersions } from './obsidian-version.ts';

/**
 * The silent-asar-fallback verdict for a booted owned instance, carried as data
 * on the transport / connection result so consumers can assert on it.
 */
export interface AsarFallback {
  /** A human-readable explanation, present for the `'fallback'` tier. */
  readonly message?: string;

  /** The pinned app (asar) version that was requested, or `null` when none. */
  readonly requestedVersion: null | string;

  /** The app (asar) version actually running, or `null` when unreadable. */
  readonly runningApiVersion: null | string;

  /** The resolved fallback tier. */
  readonly tier: AsarFallbackTier;
}

/**
 * The silent-asar-fallback tier for a booted owned instance.
 *
 * - `'match'` — the running app version equals the pinned version; the pin was
 *   honored.
 * - `'fallback'` — the running app version differs from the pinned version; the
 *   installer silently ran a different (its own bundled) asar instead of the pin.
 * - `'unknown'` — cannot be determined (no asar was swapped, so there is no pin to
 *   verify, or the live running version could not be read).
 */
export type AsarFallbackTier = 'fallback' | 'match' | 'unknown';

/**
 * Parameters for {@link checkAsarFallback}.
 */
export interface CheckAsarFallbackParams {
  /**
   * The pinned Obsidian app (asar) version the owned instance was asked to run,
   * or `undefined` when no asar was swapped (so there is nothing to verify).
   */
  readonly requestedVersion: string | undefined;

  /**
   * The Obsidian app (asar) version the instance is actually running, read live
   * post-boot, or `undefined` when it could not be read.
   */
  readonly runningApiVersion: string | undefined;
}

/**
 * Computes the silent-asar-fallback verdict for a booted owned instance.
 *
 * Only `'fallback'` warrants action (a throw / warning); `'match'` and `'unknown'`
 * are silent. Comparison is a pure `x.y.z` version compare — no I/O.
 *
 * @param params - The pinned version and the live running version.
 * @returns The fallback verdict.
 */
export function checkAsarFallback(params: CheckAsarFallbackParams): AsarFallback {
  const { requestedVersion, runningApiVersion } = params;

  if (requestedVersion === undefined || runningApiVersion === undefined) {
    return {
      requestedVersion: requestedVersion ?? null,
      runningApiVersion: runningApiVersion ?? null,
      tier: 'unknown'
    };
  }

  if (compareVersions(runningApiVersion, requestedVersion) === 0) {
    return { requestedVersion, runningApiVersion, tier: 'match' };
  }

  return {
    message: `Obsidian was pinned to app version ${requestedVersion} but is actually running ${runningApiVersion} — `
      + 'the installer silently fell back to its own bundled asar instead of running the pinned version. '
      + `Pin an obsidianInstallerVersion at or above ${requestedVersion}'s run floor so the pin actually runs.`,
    requestedVersion,
    runningApiVersion,
    tier: 'fallback'
  };
}
