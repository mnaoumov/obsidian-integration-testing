import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildPluginAssetUrl,
  isValidRepoReference,
  selectPluginRepo
} from './community-plugin-registry.ts';

const ENTRIES = [
  { id: 'backlink-cache', repo: 'mnaoumov/obsidian-backlink-cache' },
  { id: 'fix-require-modules', repo: 'mnaoumov/obsidian-codescript-toolkit' }
];

describe('buildPluginAssetUrl', () => {
  it('should point at the latest release when no version is given', () => {
    expect(buildPluginAssetUrl({ assetName: 'main.js', repo: 'mnaoumov/obsidian-codescript-toolkit' }))
      .toBe('https://github.com/mnaoumov/obsidian-codescript-toolkit/releases/latest/download/main.js');
  });

  it('should pin the release tag when a version is given', () => {
    expect(buildPluginAssetUrl({ assetName: 'manifest.json', repo: 'mnaoumov/obsidian-codescript-toolkit', version: '13.6.11' }))
      .toBe('https://github.com/mnaoumov/obsidian-codescript-toolkit/releases/download/13.6.11/manifest.json');
  });

  it('should treat an explicit undefined version as latest', () => {
    expect(buildPluginAssetUrl({ assetName: 'styles.css', repo: 'owner/name', version: undefined }))
      .toBe('https://github.com/owner/name/releases/latest/download/styles.css');
  });
});

describe('isValidRepoReference', () => {
  it('should accept an owner/name pair', () => {
    expect(isValidRepoReference('mnaoumov/obsidian-codescript-toolkit')).toBe(true);
    expect(isValidRepoReference('obsidianmd/obsidian-releases')).toBe(true);
    expect(isValidRepoReference('owner.name/repo.name')).toBe(true);
  });

  it('should reject anything that is not exactly one owner/name pair', () => {
    expect(isValidRepoReference('no-slash')).toBe(false);
    expect(isValidRepoReference('too/many/segments')).toBe(false);
    expect(isValidRepoReference('/name')).toBe(false);
    expect(isValidRepoReference('owner/')).toBe(false);
    // A full URL must not be spliced into the asset URL as if it were `owner/name`.
    expect(isValidRepoReference('https://github.com/owner/name')).toBe(false);
  });
});

describe('selectPluginRepo', () => {
  it('should resolve a registered plugin id to its repo', () => {
    expect(selectPluginRepo({ entries: ENTRIES, pluginId: 'fix-require-modules' })).toBe('mnaoumov/obsidian-codescript-toolkit');
  });

  it('should return undefined for an id that is not in the registry', () => {
    expect(selectPluginRepo({ entries: ENTRIES, pluginId: 'not-a-community-plugin' })).toBeUndefined();
  });

  it('should return undefined for an empty registry', () => {
    expect(selectPluginRepo({ entries: [], pluginId: 'fix-require-modules' })).toBeUndefined();
  });
});
