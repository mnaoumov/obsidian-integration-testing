import {
  dirname,
  join
} from 'node:path';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  applyUpdateDisabledRestore,
  checkIsUpdatedAsarFileName,
  holdPersistentProfileUpdates,
  PERSISTENT_PROFILE_HELD_ASARS_DIRECTORY_NAME,
  PERSISTENT_PROFILE_HOLD_STATE_FILE_NAME,
  restorePersistentProfileUpdates
} from './persistent-profile-updates.ts';

const files = new Map<string, string>();
const directories = new Set<string>();
const failingRemovals = new Set<string>();

interface FakeDirent {
  readonly isFile: () => boolean;
  readonly name: string;
}

vi.mock('node:fs', () => ({
  existsSync: (path: string): boolean => files.has(path) || directories.has(path),
  mkdirSync: (path: string): void => {
    directories.add(path);
  },
  readdirSync: (path: string): FakeDirent[] => {
    const entries: FakeDirent[] = [];
    for (const filePath of files.keys()) {
      if (dirname(filePath) === path) {
        entries.push({ isFile: (): boolean => true, name: filePath.slice(path.length + 1) });
      }
    }
    for (const directoryPath of directories) {
      if (dirname(directoryPath) === path) {
        entries.push({ isFile: (): boolean => false, name: directoryPath.slice(path.length + 1) });
      }
    }
    return entries;
  },
  readFileSync: (path: string): string => {
    const content = files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  },
  renameSync: (from: string, to: string): void => {
    const content = files.get(from);
    if (content === undefined) {
      throw new Error(`ENOENT: ${from}`);
    }
    files.delete(from);
    files.set(to, content);
  },
  rmSync: (path: string): void => {
    if (failingRemovals.has(path)) {
      throw new Error(`EBUSY: ${path}`);
    }
    files.delete(path);
    for (const filePath of files.keys()) {
      if (dirname(filePath) === path) {
        files.delete(filePath);
      }
    }
    directories.delete(path);
  },
  writeFileSync: (path: string, content: string): void => {
    files.set(path, content);
  }
}));

vi.mock('../../log.ts', () => ({
  log: vi.fn()
}));

const PROFILE = join('/profiles', 'research');
const HELD = join(PROFILE, PERSISTENT_PROFILE_HELD_ASARS_DIRECTORY_NAME);
const OBSIDIAN_JSON = join(PROFILE, 'obsidian.json');

function rootAsars(): string[] {
  return [...files.keys()].filter((path) => dirname(path) === PROFILE && checkIsUpdatedAsarFileName(path.slice(PROFILE.length + 1))).sort();
}

beforeEach(() => {
  files.clear();
  directories.clear();
  failingRemovals.clear();
  directories.add(PROFILE);
});

describe('checkIsUpdatedAsarFileName', () => {
  it('should match only the names the shell loads as an updated app', () => {
    expect(checkIsUpdatedAsarFileName('obsidian-1.15.1.asar')).toBe(true);
    expect(checkIsUpdatedAsarFileName('obsidian.asar.tmp')).toBe(false);
    expect(checkIsUpdatedAsarFileName('obsidian.json')).toBe(false);
    expect(checkIsUpdatedAsarFileName('obsidian-1.15.1.asar.gz')).toBe(false);
  });
});

describe('applyUpdateDisabledRestore', () => {
  it('should delete the key when the profile had none', () => {
    expect(applyUpdateDisabledRestore({ updateDisabled: true, vaults: {} }, { hadUpdateDisabled: false, heldAsarFileNames: [] }))
      .toEqual({ vaults: {} });
  });

  it('should put back the profile\'s own value', () => {
    expect(applyUpdateDisabledRestore({ updateDisabled: true }, { hadUpdateDisabled: true, heldAsarFileNames: [], updateDisabled: false }))
      .toEqual({ updateDisabled: false });
  });

  it('should leave a registry that is not an object alone', () => {
    expect(applyUpdateDisabledRestore(undefined, { hadUpdateDisabled: false, heldAsarFileNames: [] })).toBeNull();
    expect(applyUpdateDisabledRestore([], { hadUpdateDisabled: false, heldAsarFileNames: [] })).toBeNull();
  });
});

describe('holdPersistentProfileUpdates', () => {
  it('should hold the profile\'s asars aside and restore them, the registry key and nothing the run added', () => {
    files.set(join(PROFILE, 'obsidian-1.15.1.asar'), 'updater 1.15.1');
    files.set(OBSIDIAN_JSON, JSON.stringify({ vaults: {} }));

    const restore = holdPersistentProfileUpdates(PROFILE);
    expect(rootAsars()).toEqual([]);
    expect(files.get(join(HELD, 'obsidian-1.15.1.asar'))).toBe('updater 1.15.1');

    // The run: the harness provisions its pin, the merge sets the flag, an updater writes anyway.
    files.set(join(PROFILE, 'obsidian-1.14.5.asar'), 'pinned');
    files.set(join(PROFILE, 'obsidian-1.15.0.asar'), 'updater 1.15.0');
    files.set(OBSIDIAN_JSON, JSON.stringify({ updateDisabled: true, vaults: { a: {} } }));

    restore();
    expect(rootAsars()).toEqual([join(PROFILE, 'obsidian-1.15.1.asar')]);
    expect(files.get(join(PROFILE, 'obsidian-1.15.1.asar'))).toBe('updater 1.15.1');
    expect(JSON.parse(files.get(OBSIDIAN_JSON) ?? '')).toEqual({ vaults: { a: {} } });
    expect(directories.has(HELD)).toBe(false);
  });

  it('should prefer the profile\'s own copy over a run\'s copy of the same version', () => {
    files.set(join(PROFILE, 'obsidian-1.14.5.asar'), 'own');
    const restore = holdPersistentProfileUpdates(PROFILE);
    files.set(join(PROFILE, 'obsidian-1.14.5.asar'), 'pinned');
    restore();
    expect(files.get(join(PROFILE, 'obsidian-1.14.5.asar'))).toBe('own');
  });

  it('should first restore a hold a killed run left behind, keeping the profile\'s original flag', () => {
    files.set(join(PROFILE, 'obsidian-1.15.1.asar'), 'updater 1.15.1');
    files.set(OBSIDIAN_JSON, JSON.stringify({ updateDisabled: false }));
    holdPersistentProfileUpdates(PROFILE);
    files.set(OBSIDIAN_JSON, JSON.stringify({ updateDisabled: true }));
    files.set(join(PROFILE, 'obsidian-1.14.5.asar'), 'pinned by the killed run');

    const restore = holdPersistentProfileUpdates(PROFILE);
    expect(rootAsars()).toEqual([]);
    expect(JSON.parse(files.get(join(HELD, PERSISTENT_PROFILE_HOLD_STATE_FILE_NAME)) ?? '')).toEqual({
      hadUpdateDisabled: true,
      heldAsarFileNames: ['obsidian-1.15.1.asar'],
      updateDisabled: false
    });

    restore();
    expect(rootAsars()).toEqual([join(PROFILE, 'obsidian-1.15.1.asar')]);
    expect(JSON.parse(files.get(OBSIDIAN_JSON) ?? '')).toEqual({ updateDisabled: false });
  });

  it('should finish a restore that failed part-way when it is run again', () => {
    files.set(join(PROFILE, 'obsidian-1.15.1.asar'), 'updater 1.15.1');
    const restore = holdPersistentProfileUpdates(PROFILE);
    const pinned = join(PROFILE, 'obsidian-1.14.5.asar');
    files.set(pinned, 'pinned');

    failingRemovals.add(pinned);
    expect(restore).toThrow(/EBUSY/u);
    failingRemovals.clear();

    restore();
    expect(rootAsars()).toEqual([join(PROFILE, 'obsidian-1.15.1.asar')]);
  });

  it('should keep an asar a killed run had not yet moved', () => {
    files.set(join(PROFILE, 'obsidian-1.15.1.asar'), 'updater 1.15.1');
    directories.add(HELD);
    files.set(join(HELD, PERSISTENT_PROFILE_HOLD_STATE_FILE_NAME), JSON.stringify({ hadUpdateDisabled: false, heldAsarFileNames: ['obsidian-1.15.1.asar'] }));

    restorePersistentProfileUpdates(PROFILE);
    expect(rootAsars()).toEqual([join(PROFILE, 'obsidian-1.15.1.asar')]);
    expect(directories.has(HELD)).toBe(false);
  });

  it('should fall back to the held files when the hold has no readable state', () => {
    directories.add(HELD);
    files.set(join(HELD, 'obsidian-1.15.1.asar'), 'updater 1.15.1');
    files.set(join(PROFILE, 'obsidian-1.14.5.asar'), 'pinned');
    files.set(OBSIDIAN_JSON, JSON.stringify({ updateDisabled: true }));

    restorePersistentProfileUpdates(PROFILE);
    expect(rootAsars()).toEqual([join(PROFILE, 'obsidian-1.15.1.asar')]);
    expect(JSON.parse(files.get(OBSIDIAN_JSON) ?? '')).toEqual({ updateDisabled: true });
  });

  it('should leave a profile with nothing held aside alone', () => {
    files.set(join(PROFILE, 'obsidian-1.15.1.asar'), 'updater 1.15.1');
    restorePersistentProfileUpdates(PROFILE);
    expect(rootAsars()).toEqual([join(PROFILE, 'obsidian-1.15.1.asar')]);
  });

  it('should not write a registry it cannot parse', () => {
    files.set(OBSIDIAN_JSON, 'not json');
    const restore = holdPersistentProfileUpdates(PROFILE);
    restore();
    expect(files.get(OBSIDIAN_JSON)).toBe('not json');
  });
});
