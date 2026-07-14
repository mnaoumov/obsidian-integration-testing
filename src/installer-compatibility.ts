/**
 * @file
 *
 * Pure verdict on whether a resolved (Obsidian app, installer) version pair is
 * compatible, computed offline from the `metadata.json` thresholds. Kept separate
 * from the integration-only `transport-factory` (which drives real
 * downloads/launches and is excluded from unit tests) so the tier logic stays
 * unit-testable — mirroring the `renderer-boot-detection` split.
 *
 * Two thresholds drive the verdict, both installer versions directly comparable
 * to the resolved installer/shell version:
 *
 * - `minRunnableInstallerVersion` — the run floor. Below it the app cannot boot
 *   (`'unrunnable'`); the caller turns this into a proactive
 *   `IncompatibleInstallerVersionError` before any download/launch.
 * - `minRecommendedInstallerVersion` — the recommended floor (older versions
 *   only). At/above the run floor but below this, the app runs but is below
 *   Obsidian's recommendation (`'nagged'`), surfaced as a warning.
 *
 * When the installer version is unknown (e.g. an undetectable Linux shell) or the
 * app version is absent from the table, the verdict is `'unknown'` and nothing is
 * thrown or warned — the reactive dead-boot fast-fail remains the safety net.
 */

import type { ObsidianVersionMetadata } from './obsidian-metadata.ts';

import { compareVersions } from './obsidian-version.ts';

/**
 * Parameters for {@link checkInstallerCompatibility}.
 */
export interface CheckInstallerCompatibilityParams {
  /** The resolved Obsidian app (asar) version. */
  readonly appVersion: string;

  /** The resolved installer/Electron shell version, or `undefined` when unknown. */
  readonly installerVersion: string | undefined;

  /** The `metadata.json` entry for {@link appVersion}, or `undefined` when absent. */
  readonly metadata: ObsidianVersionMetadata | undefined;
}

/**
 * The compatibility verdict for a resolved (app, installer) version pair, carried
 * as data on the transport / connection result so consumers can assert on it.
 */
export interface InstallerCompatibility {
  /** The resolved Obsidian app (asar) version. */
  readonly appVersion: string;

  /** The resolved installer/Electron shell version, or `null` when unknown. */
  readonly installerVersion: null | string;

  /** A human-readable explanation, present for the `'nagged'` tier. */
  readonly message?: string;

  /** The recommended installer floor, when the table carries one. */
  readonly minRecommendedInstallerVersion?: string;

  /** The run floor, when the table carries one. */
  readonly minRunnableInstallerVersion?: string;

  /** The resolved compatibility tier. */
  readonly tier: InstallerCompatibilityTier;
}

/**
 * The compatibility tier of a resolved (app, installer) version pair.
 *
 * - `'ok'` — the installer is at or above the recommended floor (or no
 *   recommended floor is known); runs with full compatibility.
 * - `'nagged'` — at/above the run floor but below the recommended floor; runs but
 *   Obsidian would show its "installer too old" recommendation.
 * - `'unrunnable'` — below the run floor; the app cannot boot on this installer.
 * - `'unknown'` — cannot be determined (installer version unknown, or the app
 *   version is absent from the table).
 */
export type InstallerCompatibilityTier = 'nagged' | 'ok' | 'unknown' | 'unrunnable';

/**
 * Computes the compatibility verdict for a resolved (app, installer) version pair.
 *
 * Only `'unrunnable'` warrants an error; `'nagged'` warrants a warning; `'ok'` and
 * `'unknown'` are silent. Comparisons are pure `x.y.z` version compares — no I/O.
 *
 * @param params - The resolved versions and the app version's metadata entry.
 * @returns The compatibility verdict.
 */
export function checkInstallerCompatibility(params: CheckInstallerCompatibilityParams): InstallerCompatibility {
  const { appVersion, installerVersion, metadata } = params;
  const minRunnableInstallerVersion = metadata?.minRunnableInstallerVersion;
  const minRecommendedInstallerVersion = metadata?.minRecommendedInstallerVersion;

  if (installerVersion === undefined || minRunnableInstallerVersion === undefined) {
    return { appVersion, installerVersion: installerVersion ?? null, tier: 'unknown' };
  }

  const recommendedFloor = minRecommendedInstallerVersion !== undefined && { minRecommendedInstallerVersion };

  if (compareVersions(installerVersion, minRunnableInstallerVersion) < 0) {
    return {
      appVersion,
      installerVersion,
      minRunnableInstallerVersion,
      tier: 'unrunnable',
      ...recommendedFloor
    };
  }

  if (minRecommendedInstallerVersion !== undefined && compareVersions(installerVersion, minRecommendedInstallerVersion) < 0) {
    return {
      appVersion,
      installerVersion,
      message: `Obsidian installer ${installerVersion} runs Obsidian ${appVersion} but is older than the `
        + `recommended installer ${minRecommendedInstallerVersion}; update the installer for full compatibility.`,
      minRecommendedInstallerVersion,
      minRunnableInstallerVersion,
      tier: 'nagged'
    };
  }

  return {
    appVersion,
    installerVersion,
    minRunnableInstallerVersion,
    tier: 'ok',
    ...recommendedFloor
  };
}
