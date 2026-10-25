import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianVersionDownloads } from './obsidian-metadata.ts';

import { resolveInstallerVersionAction } from './installer-version-resolution.ts';

const CATALYST_ONLY: ObsidianVersionDownloads = {
  asar: 'https://releases.obsidian.md/release/obsidian-1.15.0.asar.gz'
};

const PUBLIC: ObsidianVersionDownloads = {
  asar: 'https://example.invalid/obsidian-1.14.5.asar.gz',
  dmg: 'https://example.invalid/Obsidian-1.14.5.dmg',
  exe: 'https://example.invalid/Obsidian-1.14.5.exe',
  tar: 'https://example.invalid/obsidian-1.14.5.tar.gz'
};

describe('resolveInstallerVersionAction', () => {
  it('should use a version whose catalog entry has an installer for the platform', () => {
    expect(resolveInstallerVersionAction({ downloads: PUBLIC, platform: 'win32', spec: '1.14.5', version: '1.14.5' })).toStrictEqual({ action: 'use' });
  });

  it('should use a version the catalog does not know, leaving the download to answer', () => {
    expect(resolveInstallerVersionAction({ downloads: undefined, platform: 'win32', spec: 'catalyst-latest', version: '9.9.9' })).toStrictEqual({ action: 'use' });
  });

  it('should fall back to the public installer when catalyst-latest has none', () => {
    expect(resolveInstallerVersionAction({ downloads: CATALYST_ONLY, platform: 'win32', spec: 'catalyst-latest', version: '1.15.0' })).toStrictEqual({
      action: 'use-public-latest'
    });
  });

  it('should keep public-latest rather than fall back to itself', () => {
    expect(resolveInstallerVersionAction({ downloads: CATALYST_ONLY, platform: 'linux', spec: 'public-latest', version: '1.15.0' })).toStrictEqual({ action: 'use' });
  });

  it('should refuse an explicit version that ships no installer for the platform, naming the alternative', () => {
    const result = resolveInstallerVersionAction({ downloads: CATALYST_ONLY, platform: 'darwin', spec: '1.15.0', version: '1.15.0' });
    expect(result.action).toBe('refuse');
    expect(result).toHaveProperty('message', expect.stringContaining('Obsidian 1.15.0 publishes no desktop installer for darwin'));
    expect(result).toHaveProperty('message', expect.stringContaining('obsidianVersion: \'1.15.0\''));
  });
});
