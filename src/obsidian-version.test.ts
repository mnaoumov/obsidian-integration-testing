import {
  describe,
  expect,
  it
} from 'vitest';

import type { DesktopReleasesManifest } from './obsidian-version.ts';

import {
  CATALYST_LATEST,
  compareVersions,
  getVersionAsarFileName,
  parseVersionSpec,
  PUBLIC_LATEST,
  resolveVersionFromManifest
} from './obsidian-version.ts';

describe('parseVersionSpec', () => {
  it('should parse the public-latest alias as the public channel', () => {
    expect(parseVersionSpec(PUBLIC_LATEST)).toEqual({ channel: 'public', kind: 'channel' });
  });

  it('should parse the catalyst-latest alias as the catalyst channel', () => {
    expect(parseVersionSpec(CATALYST_LATEST)).toEqual({ channel: 'catalyst', kind: 'channel' });
  });

  it('should parse an explicit x.y.z version', () => {
    expect(parseVersionSpec('1.8.10')).toEqual({ kind: 'explicit', version: '1.8.10' });
  });

  it('should throw for a non-version, non-alias string', () => {
    expect(() => parseVersionSpec('latest')).toThrow('Invalid Obsidian version "latest"');
  });

  it('should throw for a partial version', () => {
    expect(() => parseVersionSpec('1.8')).toThrow('Invalid Obsidian version "1.8"');
  });
});

describe('resolveVersionFromManifest', () => {
  const manifest: DesktopReleasesManifest = {
    beta: { latestVersion: '1.13.1' },
    latestVersion: '1.12.7'
  };

  it('should resolve the public channel to latestVersion', () => {
    expect(resolveVersionFromManifest(manifest, 'public')).toBe('1.12.7');
  });

  it('should resolve the catalyst channel to beta.latestVersion', () => {
    expect(resolveVersionFromManifest(manifest, 'catalyst')).toBe('1.13.1');
  });

  it('should throw for the catalyst channel when the manifest has no beta entry', () => {
    expect(() => resolveVersionFromManifest({ latestVersion: '1.12.7' }, 'catalyst')).toThrow('no catalyst');
  });
});

describe('compareVersions', () => {
  it('should return a negative number when the first version is lower', () => {
    expect(compareVersions('1.8.10', '1.12.7')).toBeLessThan(0);
  });

  it('should return a positive number when the first version is higher', () => {
    expect(compareVersions('1.13.1', '1.12.7')).toBeGreaterThan(0);
  });

  it('should return zero for equal versions', () => {
    expect(compareVersions('1.12.7', '1.12.7')).toBe(0);
  });

  it('should compare the minor segment before the patch segment', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
  });

  it('should treat missing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareVersions('1.2.3', '1.2')).toBeGreaterThan(0);
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('getVersionAsarFileName', () => {
  it('should build the obsidian-<version>.asar file name', () => {
    expect(getVersionAsarFileName('1.13.1')).toBe('obsidian-1.13.1.asar');
  });
});
