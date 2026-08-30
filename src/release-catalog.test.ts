import {
  describe,
  expect,
  it
} from 'vitest';

import type { ReleaseAsset } from './release-catalog.ts';

import {
  buildCatalystAsarUrl,
  resolveReleaseChannel,
  selectReleaseDownloads
} from './release-catalog.ts';

const DOWNLOAD_BASE_URL = 'https://github.com/obsidianmd/obsidian-releases/releases/download';

/**
 * Turns a captured asset-name list into the `{ name, url }` shape the selector
 * takes, deriving each URL exactly as the GitHub release API reports it.
 *
 * @param tag - The release tag, e.g. `v1.13.7`.
 * @param names - The release's published asset names.
 * @returns The assets.
 */
function toAssets(tag: string, names: readonly string[]): ReleaseAsset[] {
  return names.map((name) => ({ name, url: `${DOWNLOAD_BASE_URL}/${tag}/${name}` }));
}

// Real asset lists captured from the `obsidianmd/obsidian-releases` release API.

// The modern shape: hyphen separator, every desktop installer plus the apk.
const ASSETS_1_13_7 = toAssets('v1.13.7', [
  'obsidian-1.13.7.tar.gz',
  'Obsidian-1.13.7-arm64.AppImage',
  'obsidian-1.13.7-arm64.tar.gz',
  'Obsidian-1.13.7.AppImage',
  'Obsidian-1.13.7.dmg',
  'Obsidian-1.13.7.exe',
  'obsidian_1.13.7_amd64.deb',
  'obsidian-1.13.7.asar.gz',
  'Obsidian-1.13.7.apk'
]);

// The oldest installer-bearing release: dot separator, no tarball at all (it
// Shipped an AppImage and a snap instead), and no apk (Android came at 1.5.8).
const ASSETS_0_6_4 = toAssets('v0.6.4', [
  'Obsidian-0.6.4.AppImage',
  'obsidian-0.6.4.asar.gz',
  'Obsidian-0.6.4.dmg',
  'Obsidian.0.6.4.exe',
  'obsidian_0.6.4_amd64.snap'
]);

// The dot era with a `-universal` dmg infix and 32-bit / arm64 exe siblings that
// Must not be selected.
const ASSETS_0_14_5 = toAssets('v0.14.5', [
  'Obsidian-0.14.5-arm64.AppImage',
  'Obsidian-0.14.5-universal.dmg',
  'Obsidian-0.14.5.AppImage',
  'obsidian-0.14.5.asar.gz',
  'obsidian-0.14.5.tar.gz',
  'Obsidian.0.14.5-32.exe',
  'Obsidian.0.14.5-arm64.exe',
  'Obsidian.0.14.5.exe',
  'obsidian_0.14.5_amd64.deb'
]);

// An early-access tag whose assets carry the BASE version, not the tag — so
// Nothing matches and the release contributes no downloads.
const ASSETS_1_6_3_E30 = toAssets('v1.6.3-e30', [
  'Obsidian.1.6.3.exe'
]);

// A mobile-only release: an apk and nothing else.
const ASSETS_1_13_8 = toAssets('v1.13.8', [
  'Obsidian-1.13.8.apk'
]);

describe('buildCatalystAsarUrl', () => {
  it('builds the CDN asar URL for a version', () => {
    expect(buildCatalystAsarUrl('1.13.5')).toBe('https://releases.obsidian.md/release/obsidian-1.13.5.asar.gz');
  });
});

describe('resolveReleaseChannel', () => {
  it('reports both channels for a GitHub release carrying both desktop pages', () => {
    expect(resolveReleaseChannel({ hasCatalystPage: true, hasPublicPage: true, hasPublicRelease: true }))
      .toBe('public+catalyst');
  });

  it('reports public for a GitHub release carrying only the public page', () => {
    expect(resolveReleaseChannel({ hasCatalystPage: false, hasPublicPage: true, hasPublicRelease: true }))
      .toBe('public');
  });

  // The pre-1.0 era: the whole app was early access, so the feed tagged every
  // Page that way even for ordinary GitHub releases. Publication wins.
  it('reports public for a GitHub release the feed only tagged early access', () => {
    expect(resolveReleaseChannel({ hasCatalystPage: true, hasPublicPage: false, hasPublicRelease: true }))
      .toBe('public');
  });

  it('reports catalyst for an unpublished version with an early-access page', () => {
    expect(resolveReleaseChannel({ hasCatalystPage: true, hasPublicPage: false, hasPublicRelease: false }))
      .toBe('catalyst');
  });

  it('reports nothing when there is no evidence either way', () => {
    expect(resolveReleaseChannel({ hasCatalystPage: false, hasPublicPage: true, hasPublicRelease: false }))
      .toBeUndefined();
  });
});

describe('selectReleaseDownloads', () => {
  it('selects every asset the harness downloads from a modern release', () => {
    expect(selectReleaseDownloads({ assets: ASSETS_1_13_7, version: '1.13.7' })).toEqual({
      apk: `${DOWNLOAD_BASE_URL}/v1.13.7/Obsidian-1.13.7.apk`,
      asar: `${DOWNLOAD_BASE_URL}/v1.13.7/obsidian-1.13.7.asar.gz`,
      dmg: `${DOWNLOAD_BASE_URL}/v1.13.7/Obsidian-1.13.7.dmg`,
      exe: `${DOWNLOAD_BASE_URL}/v1.13.7/Obsidian-1.13.7.exe`,
      tar: `${DOWNLOAD_BASE_URL}/v1.13.7/obsidian-1.13.7.tar.gz`
    });
  });

  it('omits the keys a release never published', () => {
    expect(selectReleaseDownloads({ assets: ASSETS_0_6_4, version: '0.6.4' })).toEqual({
      asar: `${DOWNLOAD_BASE_URL}/v0.6.4/obsidian-0.6.4.asar.gz`,
      dmg: `${DOWNLOAD_BASE_URL}/v0.6.4/Obsidian-0.6.4.dmg`,
      exe: `${DOWNLOAD_BASE_URL}/v0.6.4/Obsidian.0.6.4.exe`
    });
  });

  it('takes the universal dmg and rejects the 32-bit and arm64 exe siblings', () => {
    expect(selectReleaseDownloads({ assets: ASSETS_0_14_5, version: '0.14.5' })).toEqual({
      asar: `${DOWNLOAD_BASE_URL}/v0.14.5/obsidian-0.14.5.asar.gz`,
      dmg: `${DOWNLOAD_BASE_URL}/v0.14.5/Obsidian-0.14.5-universal.dmg`,
      exe: `${DOWNLOAD_BASE_URL}/v0.14.5/Obsidian.0.14.5.exe`,
      tar: `${DOWNLOAD_BASE_URL}/v0.14.5/obsidian-0.14.5.tar.gz`
    });
  });

  it('selects nothing when the assets carry a different version than the tag', () => {
    expect(selectReleaseDownloads({ assets: ASSETS_1_6_3_E30, version: '1.6.3-e30' })).toBeUndefined();
  });

  it('selects the apk alone from a mobile-only release', () => {
    expect(selectReleaseDownloads({ assets: ASSETS_1_13_8, version: '1.13.8' })).toEqual({
      apk: `${DOWNLOAD_BASE_URL}/v1.13.8/Obsidian-1.13.8.apk`
    });
  });

  it('selects nothing from a release with no assets', () => {
    expect(selectReleaseDownloads({ assets: [], version: '1.13.7' })).toBeUndefined();
  });
});
