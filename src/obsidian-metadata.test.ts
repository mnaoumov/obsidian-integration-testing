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

  it('exposes the baked asar + desktop-installer download URLs for a public version', () => {
    const downloads = getVersionMetadata('1.12.7')?.downloads;
    expect(downloads?.asar).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/obsidian-1.12.7.asar.gz');
    expect(downloads?.exe).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/Obsidian-1.12.7.exe');
    expect(downloads?.dmg).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/Obsidian-1.12.7.dmg');
    expect(downloads?.tar).toBe('https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/obsidian-1.12.7.tar.gz');
  });

  it('carries only the asar URL for a catalyst version (no public desktop installer)', () => {
    const downloads = getVersionMetadata('1.13.1')?.downloads;
    expect(downloads?.asar).toBe('https://releases.obsidian.md/release/obsidian-1.13.1.asar.gz');
    expect(downloads?.exe).toBeUndefined();
    expect(downloads?.dmg).toBeUndefined();
    expect(downloads?.tar).toBeUndefined();
  });

  it('exposes the empirically-collected runtime versions and derived ECMAScript edition', () => {
    const metadata = getVersionMetadata('1.5.3');
    expect(metadata?.runtimeVersions?.electron).toBe('25.8.1');
    expect(metadata?.runtimeVersions?.chrome).toBe('114.0.5735.289');
    expect(metadata?.runtimeVersions?.node).toBe('18.15.0');
    expect(metadata?.runtimeVersions?.v8).toBe('11.4.183.29-electron.0');
    expect(metadata?.ecmaScriptVersion).toBe('ES2023');
  });

  it('returns `undefined` for a version absent from the table', () => {
    expect(getVersionMetadata('999.999.999')).toBeUndefined();
  });
});
