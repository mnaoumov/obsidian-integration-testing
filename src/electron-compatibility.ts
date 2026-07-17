/**
 * @file
 *
 * Pure verdict on whether the Electron version an owned Obsidian instance is
 * actually running is new enough for the resolved app version. Kept separate from
 * the integration-only `transport-desktop-cdp` (which reads the live version over
 * CDP and is excluded from unit tests) so the tier logic stays unit-testable —
 * mirroring the `installer-compatibility` / `renderer-boot-detection` split.
 *
 * This is the tier-2 companion to `installer-compatibility`. That one is fully
 * offline — it compares the resolved installer version against installer-version
 * thresholds. But the app's real requirement is a **minimum Electron version**
 * hardcoded inside `app.js` (e.g. `1.13.1` needs Electron `28.2.3`), and the
 * installer's bundled Electron is not derivable offline (see
 * {@link ObsidianVersionMetadata.minRecommendedElectronVersion}). So this verdict
 * takes the **live** `process.versions.electron` read from the booted renderer and
 * compares it to `minRecommendedElectronVersion` from `metadata.json`.
 *
 * An Electron below the recommendation runs but is nagged (`'nagged'`) — Obsidian
 * would show its "installer too old" recommendation; it never blocks, so there is
 * no `'unrunnable'` tier here. When the live version is unreadable or the app
 * version carries no recommended Electron, the verdict is `'unknown'` and nothing
 * is warned.
 */

import type { ObsidianVersionMetadata } from './obsidian-metadata.ts';

import { compareVersions } from './obsidian-version.ts';

/**
 * Parameters for {@link checkElectronCompatibility}.
 */
export interface CheckElectronCompatibilityParams {
  /** The Electron version the instance is actually running, or `undefined` when unreadable. */
  readonly actualElectronVersion: string | undefined;

  /** The resolved Obsidian app (asar) version that is running. */
  readonly appVersion: string;

  /** The `metadata.json` entry for {@link appVersion}, or `undefined` when absent. */
  readonly metadata: ObsidianVersionMetadata | undefined;
}

/**
 * The runtime Electron compatibility verdict for a booted owned instance, carried
 * as data on the transport / connection result so consumers can assert on it.
 */
export interface ElectronCompatibility {
  /** The Electron version the instance is actually running, or `null` when unreadable. */
  readonly actualElectronVersion: null | string;

  /** The resolved Obsidian app (asar) version that is running. */
  readonly appVersion: string;

  /** A human-readable explanation, present for the `'nagged'` tier. */
  readonly message?: string;

  /** The app's recommended-minimum Electron version, when the table carries one. */
  readonly minRecommendedElectronVersion?: string;

  /** The resolved compatibility tier. */
  readonly tier: ElectronCompatibilityTier;
}

/**
 * The runtime Electron compatibility tier for a booted owned instance.
 *
 * - `'ok'` — the running Electron is at or above the app's recommended minimum.
 * - `'nagged'` — the running Electron is below the recommended minimum; Obsidian
 *   runs but would show its "installer too old" recommendation.
 * - `'unknown'` — cannot be determined (the live version was unreadable, or the
 *   app version carries no recommended Electron version in the table).
 */
export type ElectronCompatibilityTier = 'nagged' | 'ok' | 'unknown';

/**
 * Computes the runtime Electron compatibility verdict for a booted owned instance.
 *
 * Only `'nagged'` warrants a warning; `'ok'` and `'unknown'` are silent. An
 * Electron mismatch never blocks, so there is no error tier. Comparisons are pure
 * `x.y.z` version compares — no I/O.
 *
 * @param params - The running app version, the live Electron version, and the app
 *   version's metadata entry.
 * @returns The compatibility verdict.
 */
export function checkElectronCompatibility(params: CheckElectronCompatibilityParams): ElectronCompatibility {
  const { actualElectronVersion, appVersion, metadata } = params;
  const minRecommendedElectronVersion = metadata?.minRecommendedElectronVersion;

  if (actualElectronVersion === undefined || minRecommendedElectronVersion === undefined) {
    return { actualElectronVersion: actualElectronVersion ?? null, appVersion, tier: 'unknown' };
  }

  if (compareVersions(actualElectronVersion, minRecommendedElectronVersion) < 0) {
    return {
      actualElectronVersion,
      appVersion,
      message: `Obsidian ${appVersion} runs on Electron ${actualElectronVersion} but recommends Electron `
        + `${minRecommendedElectronVersion} or newer; pin a newer obsidianInstallerVersion for full compatibility.`,
      minRecommendedElectronVersion,
      tier: 'nagged'
    };
  }

  return { actualElectronVersion, appVersion, minRecommendedElectronVersion, tier: 'ok' };
}
