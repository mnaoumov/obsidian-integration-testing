/**
 * @file
 *
 * Pure helpers for building the repo-root `metadata.json` catalog from Obsidian's
 * **own** publication endpoints, with no third-party catalog in the loop.
 *
 * `scripts/refresh-metadata.ts` drives the network side (the
 * `obsidianmd/obsidian-releases` GitHub Releases API, `obsidian.md/changelog.xml`
 * and `desktop-releases.json`); everything decidable without the network lives
 * here so it stays unit-tested.
 *
 * Three decisions are encoded:
 *
 * - **Which release assets become `downloads` keys.** A release's real asset list
 *   is matched rather than templated, reusing {@link selectInstallerAssetName} for
 *   the desktop installers so the historical dot-vs-hyphen separator rename (and
 *   the `-universal` dmg infix) is handled in exactly one place. The 32-bit,
 *   arm64, AppImage, deb and snap siblings are deliberately not carried — this
 *   harness downloads only the x64 installer, the app asar and the Android apk.
 * - **Which channel a version belongs to**, derived from which changelog pages
 *   the feed published for it (see {@link resolveReleaseChannel}).
 * - **Where a catalyst asar lives** ({@link buildCatalystAsarUrl}) — the one asset
 *   with no listing API behind it, so its URL must be constructed and probed.
 */

import type { ObsidianVersionDownloads } from './obsidian-metadata.ts';

import { selectInstallerAssetName } from './installer-asset.ts';
import { getVersionAsarFileName } from './obsidian-version.ts';

/**
 * Base URL for **catalyst** (early access / insider) release asars, served from
 * the Obsidian CDN as `.../release/obsidian-<version>.asar.gz`. Public versions
 * are NOT hosted here (the CDN returns an empty body for them), and the endpoint
 * is Cloudflare-gated against non-browser clients, so a probe needs a browser
 * `User-Agent`.
 */
export const CATALYST_ASAR_RELEASE_BASE_URL = 'https://releases.obsidian.md/release';

/**
 * One asset of a GitHub release, reduced to what the catalog needs.
 */
export interface ReleaseAsset {
  /**
  The published asset file name, e.g. `Obsidian-1.13.7.exe`.
   */
  readonly name: string;

  /**
  The asset's direct download URL (`browser_download_url`).
   */
  readonly url: string;
}

/**
 * Parameters for {@link resolveReleaseChannel}.
 */
export interface ResolveReleaseChannelParams {
  /**
  Whether the changelog feed published a catalyst ("Early access") desktop page.
   */
  readonly hasCatalystPage: boolean;

  /**
  Whether the changelog feed published a public desktop page.
   */
  readonly hasPublicPage: boolean;

  /**
   * Whether the version was published as a GitHub release — the evidence that it
   * shipped on the public channel, since catalyst builds are served only from
   * the `releases.obsidian.md` CDN.
   */
  readonly hasPublicRelease: boolean;
}

/**
 * Parameters for {@link selectReleaseDownloads}.
 */
export interface SelectReleaseDownloadsParams {
  /**
  The release's published assets.
   */
  readonly assets: readonly ReleaseAsset[];

  /**
  The concrete `x.y.z` version the release publishes.
   */
  readonly version: string;
}

/**
 * The desktop-installer `downloads` keys, paired with the platform whose asset
 * shape {@link selectInstallerAssetName} resolves for them.
 */
const INSTALLER_KEYS_BY_PLATFORM: readonly (readonly [key: 'dmg' | 'exe' | 'tar', platform: NodeJS.Platform])[] = [
  ['dmg', 'darwin'],
  ['exe', 'win32'],
  ['tar', 'linux']
];

/**
 * Builds the catalyst asar URL for a version.
 *
 * Catalyst builds are not published as GitHub release assets, and the CDN that
 * serves them has no listing API, so this URL is constructed rather than
 * discovered — the caller probes it before recording it.
 *
 * @param version - The concrete `x.y.z` version.
 * @returns The `releases.obsidian.md` asar URL for the version.
 */
export function buildCatalystAsarUrl(version: string): string {
  return `${CATALYST_ASAR_RELEASE_BASE_URL}/${getVersionAsarFileName(version)}.gz`;
}

/**
 * Derives a version's release channel from where it was published and which
 * changelog pages the feed carries for it.
 *
 * **Publication is the primary evidence, not the feed's title marker.** The feed
 * tags each entry `(Public)` or `(Early access)`, but through the pre-1.0 era it
 * tagged *everything* early-access — the whole app was — so 61 versions that
 * shipped as ordinary GitHub releases carry only a catalyst page. Trusting the
 * marker alone therefore relabels a large slice of public history as catalyst.
 * A GitHub release is unambiguous the other way round: catalyst builds are
 * served only from the `releases.obsidian.md` CDN, never as release assets.
 *
 * So a version that was published on GitHub is public, and it is recorded as the
 * combined `'public+catalyst'` only when the feed carries *both* desktop pages —
 * the shape every version already labelled `'public+catalyst'` has.
 *
 * @param params - The publication evidence and the desktop pages the feed published.
 * @returns The channel, or `undefined` when there is no evidence either way (the
 *   caller then keeps whatever the version already carries).
 */
export function resolveReleaseChannel(params: ResolveReleaseChannelParams): string | undefined {
  if (params.hasPublicRelease) {
    return params.hasPublicPage && params.hasCatalystPage ? 'public+catalyst' : 'public';
  }

  return params.hasCatalystPage ? 'catalyst' : undefined;
}

/**
 * Picks the assets this harness downloads out of a GitHub release's real asset
 * list: the x64 desktop installers, the app asar and the Android apk.
 *
 * Assets are matched against the **release's own version**, so an early-access
 * tag whose assets carry the base version instead (`v1.1.8-E21` publishing
 * `Obsidian.1.1.8.exe`, `v1.6.3-e30` publishing `Obsidian.1.6.3.exe`) matches
 * nothing and is skipped — deliberately, since those assets are the base
 * version's, not the tag's.
 *
 * @param params - The release's assets and its version.
 * @returns The distilled download URLs, or `undefined` when the release
 *   publishes none of them.
 */
export function selectReleaseDownloads(params: SelectReleaseDownloadsParams): ObsidianVersionDownloads | undefined {
  const { assets, version } = params;
  const assetNames = assets.map((asset) => asset.name);
  const urlByName = new Map(assets.map((asset) => [asset.name, asset.url]));
  const downloads: Record<string, string> = {};

  const apkUrl = urlByName.get(`Obsidian-${version}.apk`);
  if (apkUrl !== undefined) {
    downloads['apk'] = apkUrl;
  }

  const asarUrl = urlByName.get(`${getVersionAsarFileName(version)}.gz`);
  if (asarUrl !== undefined) {
    downloads['asar'] = asarUrl;
  }

  for (const [key, platform] of INSTALLER_KEYS_BY_PLATFORM) {
    const assetName = selectInstallerAssetName({ assetNames, platform, version });
    const url = assetName === undefined ? undefined : urlByName.get(assetName);
    if (url !== undefined) {
      downloads[key] = url;
    }
  }

  return Object.keys(downloads).length > 0 ? downloads : undefined;
}
