import {
  describe,
  expect,
  it
} from 'vitest';

import {
  assertValidConfigDirectory,
  DEFAULT_CONFIG_DIRECTORY
} from './config-directory.ts';

describe('DEFAULT_CONFIG_DIRECTORY', () => {
  it('should be the folder Obsidian falls back to, so the readback compares against the real default', () => {
    expect(DEFAULT_CONFIG_DIRECTORY).toBe('.obsidian');
  });
});

describe('assertValidConfigDirectory', () => {
  it('should accept the default config folder', () => {
    expect(() => {
      assertValidConfigDirectory('.obsidian');
    }).not.toThrow();
  });

  it('should accept the suffixed folders a multi-profile vault uses', () => {
    for (const configDirectory of ['.obsidian-desktop', '.obsidian-mobile', '.config']) {
      expect(() => {
        assertValidConfigDirectory(configDirectory);
      }).not.toThrow();
    }
  });

  it('should reject a name that does not start with a dot, which Obsidian would silently replace', () => {
    expect(() => {
      assertValidConfigDirectory('obsidian-desktop');
    }).toThrow('must start with a dot');
  });

  it('should reject the empty string, which cannot start with a dot', () => {
    expect(() => {
      assertValidConfigDirectory('');
    }).toThrow('must start with a dot');
  });

  it('should reject the bare dot, matching the explicit exclusion in Obsidian\'s own validation', () => {
    expect(() => {
      assertValidConfigDirectory('.');
    }).toThrow('bare dot');
  });

  it('should reject a nested path, since the config folder sits directly inside the vault', () => {
    expect(() => {
      assertValidConfigDirectory('.config/obsidian');
    }).toThrow('path separator');

    expect(() => {
      assertValidConfigDirectory(String.raw`.config\obsidian`);
    }).toThrow('path separator');
  });

  it('should name the offending value in every message, so the caller sees what it passed', () => {
    expect(() => {
      assertValidConfigDirectory('nope');
    }).toThrow('"nope"');

    expect(() => {
      assertValidConfigDirectory('.');
    }).toThrow('"."');

    expect(() => {
      assertValidConfigDirectory('.a/b');
    }).toThrow('".a/b"');
  });
});
