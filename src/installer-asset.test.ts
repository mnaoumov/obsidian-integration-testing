import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildInstallerAssetNameCandidates,
  selectInstallerAssetName,
  selectInstallerDownloadUrl
} from './installer-asset.ts';

// A fully-populated public-release catalog entry (all three desktop installers).
const DOWNLOADS_PUBLIC = {
  asar: 'https://example.test/obsidian-1.6.7.asar.gz',
  dmg: 'https://example.test/Obsidian-1.6.7.dmg',
  exe: 'https://example.test/Obsidian-1.6.7.exe',
  tar: 'https://example.test/obsidian-1.6.7.tar.gz'
};

// A catalyst-release entry: only the asar is published, no desktop installer.
const DOWNLOADS_CATALYST_ONLY_ASAR = {
  asar: 'https://releases.obsidian.md/release/obsidian-1.13.2.asar.gz'
};

// Real GitHub release asset name lists, captured from the
// `obsidianmd/obsidian-releases` release API. They span the historical rename
// Of the desktop installer separator: older releases use a DOT
// (`Obsidian.<ver>.exe`), newer ones a HYPHEN (`Obsidian-<ver>.exe`). The old
// Mac dmg additionally carried a `-universal` infix in the dot era.
const ASSET_NAMES_0_14_5 = [
  'Obsidian-0.14.5-arm64.AppImage',
  'Obsidian-0.14.5-universal.dmg',
  'Obsidian-0.14.5.AppImage',
  'obsidian-0.14.5.asar.gz',
  'obsidian-0.14.5.tar.gz',
  'Obsidian.0.14.5-32.exe',
  'Obsidian.0.14.5-arm64.exe',
  'Obsidian.0.14.5.exe',
  'obsidian_0.14.5_amd64.deb',
  'obsidian_0.14.5_amd64.snap'
];

const ASSET_NAMES_1_5_12 = [
  'Obsidian-1.5.12-arm64.AppImage',
  'obsidian-1.5.12-arm64.tar.gz',
  'Obsidian-1.5.12-universal.dmg',
  'Obsidian-1.5.12.apk',
  'Obsidian-1.5.12.AppImage',
  'obsidian-1.5.12.asar.gz',
  'obsidian-1.5.12.tar.gz',
  'Obsidian.1.5.12-32.exe',
  'Obsidian.1.5.12-allusers.exe',
  'Obsidian.1.5.12-arm64.exe',
  'Obsidian.1.5.12.exe',
  'obsidian_1.5.12_amd64.deb',
  'obsidian_1.5.12_amd64.snap'
];

const ASSET_NAMES_1_6_7 = [
  'Obsidian-1.6.7-arm64.AppImage',
  'obsidian-1.6.7-arm64.tar.gz',
  'Obsidian-1.6.7.apk',
  'Obsidian-1.6.7.AppImage',
  'obsidian-1.6.7.asar.gz',
  'Obsidian-1.6.7.dmg',
  'Obsidian-1.6.7.exe',
  'obsidian-1.6.7.tar.gz',
  'obsidian_1.6.7_amd64.deb'
];

const ASSET_NAMES_1_7_7 = [
  'Obsidian-1.7.7-arm64.AppImage',
  'obsidian-1.7.7-arm64.tar.gz',
  'Obsidian-1.7.7.apk',
  'Obsidian-1.7.7.AppImage',
  'obsidian-1.7.7.asar.gz',
  'Obsidian-1.7.7.dmg',
  'Obsidian-1.7.7.exe',
  'obsidian-1.7.7.tar.gz',
  'obsidian_1.7.7_amd64.deb'
];

describe('selectInstallerAssetName', () => {
  describe('Windows (.exe)', () => {
    it('should select the dot-separated exe on an old release', () => {
      expect(
        selectInstallerAssetName({ assetNames: ASSET_NAMES_0_14_5, platform: 'win32', version: '0.14.5' })
      ).toBe('Obsidian.0.14.5.exe');
    });

    it('should select the hyphen-separated exe on a new release', () => {
      expect(
        selectInstallerAssetName({ assetNames: ASSET_NAMES_1_6_7, platform: 'win32', version: '1.6.7' })
      ).toBe('Obsidian-1.6.7.exe');
      expect(
        selectInstallerAssetName({ assetNames: ASSET_NAMES_1_7_7, platform: 'win32', version: '1.7.7' })
      ).toBe('Obsidian-1.7.7.exe');
    });

    it('should reject the 32-bit, arm64, and all-users exe variants', () => {
      expect(
        selectInstallerAssetName({ assetNames: ASSET_NAMES_1_5_12, platform: 'win32', version: '1.5.12' })
      ).toBe('Obsidian.1.5.12.exe');
    });
  });

  describe('macOS (.dmg)', () => {
    it('should select the universal dmg on an old release', () => {
      expect(
        selectInstallerAssetName({ assetNames: ASSET_NAMES_0_14_5, platform: 'darwin', version: '0.14.5' })
      ).toBe('Obsidian-0.14.5-universal.dmg');
    });

    it('should select the plain dmg on a new release', () => {
      expect(
        selectInstallerAssetName({ assetNames: ASSET_NAMES_1_6_7, platform: 'darwin', version: '1.6.7' })
      ).toBe('Obsidian-1.6.7.dmg');
    });
  });

  describe('Linux (.tar.gz)', () => {
    it('should select the x64 tarball and reject the arm64 tarball', () => {
      expect(
        selectInstallerAssetName({ assetNames: ASSET_NAMES_1_5_12, platform: 'linux', version: '1.5.12' })
      ).toBe('obsidian-1.5.12.tar.gz');
      expect(
        selectInstallerAssetName({ assetNames: ASSET_NAMES_0_14_5, platform: 'linux', version: '0.14.5' })
      ).toBe('obsidian-0.14.5.tar.gz');
    });
  });

  it('should return undefined when no asset matches (e.g. a catalyst release with no installer)', () => {
    expect(
      selectInstallerAssetName({ assetNames: ['obsidian-1.13.1.asar.gz'], platform: 'win32', version: '1.13.1' })
    ).toBeUndefined();
    expect(
      selectInstallerAssetName({ assetNames: [], platform: 'win32', version: '1.6.7' })
    ).toBeUndefined();
  });
});

describe('selectInstallerDownloadUrl', () => {
  it('should select the platform-correct installer URL', () => {
    expect(selectInstallerDownloadUrl({ downloads: DOWNLOADS_PUBLIC, platform: 'win32' })).toBe(DOWNLOADS_PUBLIC.exe);
    expect(selectInstallerDownloadUrl({ downloads: DOWNLOADS_PUBLIC, platform: 'darwin' })).toBe(DOWNLOADS_PUBLIC.dmg);
    expect(selectInstallerDownloadUrl({ downloads: DOWNLOADS_PUBLIC, platform: 'linux' })).toBe(DOWNLOADS_PUBLIC.tar);
  });

  it('should treat any non-Windows/macOS platform as Linux (tar)', () => {
    expect(selectInstallerDownloadUrl({ downloads: DOWNLOADS_PUBLIC, platform: 'freebsd' })).toBe(DOWNLOADS_PUBLIC.tar);
  });

  it('should return undefined when the version has no catalog entry', () => {
    expect(selectInstallerDownloadUrl({ downloads: undefined, platform: 'win32' })).toBeUndefined();
  });

  it('should return undefined when the entry ships no installer for the platform (catalyst asar-only)', () => {
    expect(selectInstallerDownloadUrl({ downloads: DOWNLOADS_CATALYST_ONLY_ASAR, platform: 'win32' })).toBeUndefined();
    expect(selectInstallerDownloadUrl({ downloads: DOWNLOADS_CATALYST_ONLY_ASAR, platform: 'darwin' })).toBeUndefined();
    expect(selectInstallerDownloadUrl({ downloads: DOWNLOADS_CATALYST_ONLY_ASAR, platform: 'linux' })).toBeUndefined();
  });
});

describe('buildInstallerAssetNameCandidates', () => {
  it('should offer both separator forms of the Windows exe', () => {
    expect(buildInstallerAssetNameCandidates({ platform: 'win32', version: '0.14.5' })).toStrictEqual([
      'Obsidian-0.14.5.exe',
      'Obsidian.0.14.5.exe'
    ]);
  });

  it('should offer both separators and the universal infix for the macOS dmg', () => {
    expect(buildInstallerAssetNameCandidates({ platform: 'darwin', version: '0.14.5' })).toStrictEqual([
      'Obsidian-0.14.5.dmg',
      'Obsidian-0.14.5-universal.dmg',
      'Obsidian.0.14.5.dmg',
      'Obsidian.0.14.5-universal.dmg'
    ]);
  });

  it('should offer both separator forms of the Linux tarball', () => {
    expect(buildInstallerAssetNameCandidates({ platform: 'linux', version: '1.6.7' })).toStrictEqual([
      'obsidian-1.6.7.tar.gz',
      'obsidian.1.6.7.tar.gz'
    ]);
  });

  it('should produce candidates the selector recognizes for each real asset shape', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const candidates = buildInstallerAssetNameCandidates({ platform, version: '9.9.9' });
      for (const candidate of candidates) {
        expect(
          selectInstallerAssetName({ assetNames: [candidate], platform, version: '9.9.9' })
        ).toBe(candidate);
      }
    }
  });
});
