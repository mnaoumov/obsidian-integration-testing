/**
 * @file
 *
 * Pure decision on whether a pinned `obsidianInstallerVersion` names an installer
 * that exists. Catalyst builds ship an asar only, so `catalyst-latest` usually
 * resolves to a version with no installer, and downloading it used to fail with a
 * bare `HTTP 404` minutes into a launch. The catalog (`metadata.json`) knows which
 * versions publish an installer for which platform, so the answer is known before
 * any download.
 *
 * Kept apart from the integration-only `transport-factory` so it stays unit-tested.
 */

import type { ObsidianVersionDownloads } from './obsidian-metadata.ts';

import { selectInstallerDownloadUrl } from './installer-asset.ts';
import { parseVersionSpec } from './obsidian-version.ts';

/**
 * What to do with a pinned installer version.
 *
 * - `use`: the catalog lists an installer for the platform, or does not know the
 *   version at all (a release newer than the catalog), so the download is tried.
 * - `use-public-latest`: the specifier was `catalyst-latest` and the Catalyst build
 *   ships no installer; the newest public installer is the newest shell there is.
 * - `refuse`: an explicit version the catalog lists with no installer for the
 *   platform. `message` says why, and what to pass instead.
 */
export type InstallerVersionAction = InstallerVersionChoice | InstallerVersionRefusal;

/**
 * A pinned installer version that can be downloaded, as is or by falling back.
 */
export interface InstallerVersionChoice {
  /**
  `use` keeps the resolved version; `use-public-latest` swaps in the public installer.
   */
  readonly action: 'use-public-latest' | 'use';
}

/**
 * A pinned installer version that cannot be downloaded at all.
 */
export interface InstallerVersionRefusal {
  /**
  Discriminant.
   */
  readonly action: 'refuse';

  /**
  Why the version cannot be pinned, and what to pass instead.
   */
  readonly message: string;
}

/**
 * Parameters for {@link resolveInstallerVersionAction}.
 */
export interface ResolveInstallerVersionActionParams {
  /**
  The resolved version's baked download URLs, or `undefined` when the catalog does not list it.
   */
  readonly downloads: ObsidianVersionDownloads | undefined;

  /**
  The platform whose installer would be downloaded.
   */
  readonly platform: NodeJS.Platform;

  /**
  The `obsidianInstallerVersion` specifier as the caller passed it.
   */
  readonly spec: string;

  /**
  The concrete version the specifier resolved to.
   */
  readonly version: string;
}

/**
 * Decides whether a pinned installer version can be downloaded, from the catalog alone.
 *
 * @param params - The specifier, its resolved version, the catalog entry and the platform.
 * @returns The action to take.
 */
export function resolveInstallerVersionAction(params: ResolveInstallerVersionActionParams): InstallerVersionAction {
  if (params.downloads === undefined || selectInstallerDownloadUrl({ downloads: params.downloads, platform: params.platform }) !== undefined) {
    return { action: 'use' };
  }

  const parsed = parseVersionSpec(params.spec);
  // Falling back from `public-latest` to itself would change nothing, so that
  // channel keeps the version and lets the download say what is missing.
  return parsed.kind === 'channel'
    ? { action: parsed.channel === 'catalyst' ? 'use-public-latest' : 'use' }
    : buildRefusal(params);
}

/**
 * Builds the refusal for an explicit version that publishes no installer.
 *
 * @param params - The resolved version and the platform.
 * @returns The refusal, naming what to pass instead.
 */
function buildRefusal(params: ResolveInstallerVersionActionParams): InstallerVersionRefusal {
  return {
    action: 'refuse',
    message: `Obsidian ${params.version} publishes no desktop installer for ${params.platform} (Catalyst builds ship an asar only), `
      + 'so `obsidianInstallerVersion` cannot pin it. Pin a public installer version instead, or leave `obsidianInstallerVersion` '
      + `unset and pass \`obsidianVersion: '${params.version}'\`, which swaps the asar onto an installed or public shell.`
  };
}
