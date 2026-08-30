import {
  describe,
  expect,
  it
} from 'vitest';

import { getVersionMetadata } from './obsidian-metadata.ts';

describe('getVersionMetadata', () => {
  it('returns the run floor for a known catalyst version', () => {
    expect(getVersionMetadata('1.13.1')?.minRunnableInstallerVersion).toBe('1.1.9');
  });

  it('records 1.13.0 as needing installer 1.6.5 (silent-fallback correction, not the false-positive 1.1.9)', () => {
    // 1.13.0 silently falls back to the installer's bundled asar below 1.6.5; verified over CDP that it
    // Does not actually run 1.13.0 on installer 1.1.9. See CLAUDE.md L20's silent-fallback caveat.
    expect(getVersionMetadata('1.13.0')?.minRunnableInstallerVersion).toBe('1.6.5');
  });

  it('returns the recommended installer floor for an old version that carries one', () => {
    const metadata = getVersionMetadata('0.15.6');
    expect(metadata?.minRunnableInstallerVersion).toBe('0.6.4');
    expect(metadata?.minRecommendedInstallerVersion).toBe('0.11.0');
  });

  it('exposes the recommended Electron version and channel for a modern version', () => {
    const metadata = getVersionMetadata('1.5.3');
    expect(metadata?.minRecommendedElectronVersion).toBe('25.8.1');
    expect(metadata?.channel).toBe('public');
  });

  it('exposes the baked asar + desktop-installer + apk download URLs for a public version', () => {
    const downloads = getVersionMetadata('1.12.7')?.downloads;
    expect(downloads?.asar).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/obsidian-1.12.7.asar.gz');
    expect(downloads?.exe).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/Obsidian-1.12.7.exe');
    expect(downloads?.dmg).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/Obsidian-1.12.7.dmg');
    expect(downloads?.tar).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/obsidian-1.12.7.tar.gz');
    expect(downloads?.apk).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/Obsidian-1.12.7.apk');
  });

  it('carries no apk before 1.5.8, the release the Android asset first appears on', () => {
    expect(getVersionMetadata('1.5.7')?.downloads?.apk).toBeUndefined();
    expect(getVersionMetadata('1.5.8')?.downloads?.apk).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.5.8/Obsidian-1.5.8.apk');
  });

  it('carries only the asar URL for a catalyst version (no public desktop installer, no apk)', () => {
    const downloads = getVersionMetadata('1.13.1')?.downloads;
    expect(downloads?.asar).toBe('https://releases.obsidian.md/release/obsidian-1.13.1.asar.gz');
    expect(downloads?.exe).toBeUndefined();
    expect(downloads?.dmg).toBeUndefined();
    expect(downloads?.tar).toBeUndefined();
    expect(downloads?.apk).toBeUndefined();
  });

  it('exposes a changelog page per publication target, the catalyst pages predating the public ones', () => {
    const changelogUrl = getVersionMetadata('1.13.7')?.changelogUrl;
    expect(changelogUrl?.desktop).toBe('https://obsidian.md/changelog/2026-08-12-desktop-v1.13.7/');
    expect(changelogUrl?.mobile).toBe('https://obsidian.md/changelog/2026-08-12-mobile-v1.13.7/');
    expect(changelogUrl?.desktopCatalyst).toBe('https://obsidian.md/changelog/2026-08-11-desktop-v1.13.7/');
    expect(changelogUrl?.mobileCatalyst).toBe('https://obsidian.md/changelog/2026-08-11-mobile-v1.13.7/');
  });

  it('carries only the catalyst changelog pages for a version that never shipped publicly', () => {
    const changelogUrl = getVersionMetadata('1.13.1')?.changelogUrl;
    expect(changelogUrl?.desktopCatalyst).toBe('https://obsidian.md/changelog/2026-06-09-desktop-v1.13.1/');
    expect(changelogUrl?.mobileCatalyst).toBe('https://obsidian.md/changelog/2026-06-09-mobile-v1.13.1/');
    expect(changelogUrl?.desktop).toBeUndefined();
    expect(changelogUrl?.mobile).toBeUndefined();
  });

  it('carries no mobile changelog page for a version predating the mobile app', () => {
    const changelogUrl = getVersionMetadata('0.9.22')?.changelogUrl;
    expect(changelogUrl?.desktop).toBeDefined();
    expect(changelogUrl?.mobile).toBeUndefined();
    expect(changelogUrl?.mobileCatalyst).toBeUndefined();
  });

  it('exposes the empirically-collected runtime versions and derived ECMAScript edition', () => {
    const metadata = getVersionMetadata('1.5.3');
    expect(metadata?.runtimeVersions?.electron).toBe('25.8.1');
    expect(metadata?.runtimeVersions?.chrome).toBe('114.0.5735.289');
    expect(metadata?.runtimeVersions?.node).toBe('18.15.0');
    expect(metadata?.runtimeVersions?.v8).toBe('11.4.183.29-electron.0');
    expect(metadata?.ecmaScriptVersion).toBe('ES2023');
  });

  it('captures the entire `process.versions`, not just the four well-known keys', () => {
    const runtimeVersions = getVersionMetadata('1.5.3')?.runtimeVersions;
    // Guard against a regression to picking only chrome/electron/node/v8.
    // Every key the Electron build exposes must be captured.
    expect(runtimeVersions?.['uv']).toBe('1.44.2');
    expect(runtimeVersions?.['openssl']).toBe('1.1.1');
    expect(runtimeVersions?.['zlib']).toBe('1.2.13');
    expect(runtimeVersions?.['icu']).toBe('72.1');
    expect(Object.keys(runtimeVersions ?? {}).length).toBeGreaterThan(4);
  });

  it('returns `undefined` for a version absent from the table', () => {
    expect(getVersionMetadata('999.999.999')).toBeUndefined();
  });
});
