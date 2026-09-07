import {
  describe,
  expect,
  it
} from 'vitest';

import {
  remapConfigDirectoryKeys,
  resolveIntegrationTransportOptions
} from './global-setup-core.ts';

const OVERRIDE = '.obsidian-desktop';

describe('remapConfigDirectoryKeys', () => {
  it('should redirect a config-folder entry to the folder the vault will actually read', () => {
    expect(remapConfigDirectoryKeys({ '.obsidian/app.json': '{}' }, OVERRIDE)).toStrictEqual({
      '.obsidian-desktop/app.json': '{}'
    });
  });

  it('should redirect a seeded community plugin, binaries and all', () => {
    // What `buildDemoVaultPopulate`'s `injectPlugins` emits. Left under `.obsidian/` these are the
    // "enabled but not loaded" the override used to produce, with nothing naming a config folder.
    expect(remapConfigDirectoryKeys({
      '.obsidian/plugins/extra/main.js': 'module.exports = {};',
      '.obsidian/plugins/extra/manifest.json': '{}'
    }, OVERRIDE)).toStrictEqual({
      '.obsidian-desktop/plugins/extra/main.js': 'module.exports = {};',
      '.obsidian-desktop/plugins/extra/manifest.json': '{}'
    });
  });

  it('should leave note entries alone', () => {
    expect(remapConfigDirectoryKeys({ 'folder/note.md': '# Note' }, OVERRIDE)).toStrictEqual({
      'folder/note.md': '# Note'
    });
  });

  it('should move a leading path segment only, not any key containing the name', () => {
    // `.obsidian` is a legal thing for a note path to mention; only the first segment is the config folder.
    expect(remapConfigDirectoryKeys({
      'notes/.obsidian-notes.md': '# About .obsidian',
      'notes/.obsidian/note.md': '# Nested'
    }, OVERRIDE)).toStrictEqual({
      'notes/.obsidian-notes.md': '# About .obsidian',
      'notes/.obsidian/note.md': '# Nested'
    });
  });

  it('should return the map untouched when nothing overrides the config folder', () => {
    const populate = { '.obsidian/app.json': '{}' };

    expect(remapConfigDirectoryKeys(populate, undefined)).toBe(populate);
  });

  it('should return the map untouched when the override names the default folder anyway', () => {
    const populate = { '.obsidian/app.json': '{}' };

    expect(remapConfigDirectoryKeys(populate, '.obsidian')).toBe(populate);
  });
});

describe('resolveIntegrationTransportOptions', () => {
  it('should hide the default desktop instance', () => {
    expect(resolveIntegrationTransportOptions()).toStrictEqual({
      isObsidianAppVisible: false,
      type: 'obsidian-cdp'
    });
  });

  it('should hide a desktop instance when visibility is not configured', () => {
    expect(resolveIntegrationTransportOptions({ type: 'obsidian-cdp' })).toStrictEqual({
      isObsidianAppVisible: false,
      type: 'obsidian-cdp'
    });
  });

  it('should preserve an explicitly configured desktop visibility', () => {
    expect(resolveIntegrationTransportOptions({
      isObsidianAppVisible: true,
      type: 'obsidian-cdp'
    })).toStrictEqual({
      isObsidianAppVisible: true,
      type: 'obsidian-cdp'
    });
  });

  it('should preserve Android transport options', () => {
    const options = {
      appiumUrl: 'http://localhost:4723',
      avdName: 'alpha',
      type: 'obsidian-android-appium' as const
    };

    expect(resolveIntegrationTransportOptions(options)).toBe(options);
  });
});
