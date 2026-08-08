import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

import {
  checkIsLeftoverStale,
  DEFAULT_LEFTOVER_MAX_AGE_IN_MILLISECONDS,
  filterLeftoverNames,
  OWNED_USER_DATA_DIR_PREFIX,
  resolveLeftoverMaxAgeInMilliseconds,
  sweepDeviceLeftovers,
  sweepHostLeftovers,
  TEMP_VAULT_DIR_PREFIX,
  willSweepLeftovers
} from './leftover-cleanup.ts';

const HOUR_IN_MILLISECONDS = 3_600_000;
const FIXED_NOW_IN_MILLISECONDS = 1_000_000_000_000;
const DEVICE_VAULT_COUNT_2 = 2;
const DEVICE_VAULT_COUNT_3 = 3;

/**
 * A stand-in for the device side of the sweep: it lists what it still holds and
 * records every removal it was asked for.
 */
interface DeviceDouble {
  /**
  The absolute paths `removeDirectory` was called with, in order.
  */
  readonly attemptedPaths: string[];

  /**
  Lists the names still present.
  */
  readonly listNames: () => Promise<readonly string[]>;

  /**
  Removes one directory, rejecting for the names configured as un-removable.
  */
  readonly removeDirectory: (path: string) => Promise<void>;
}

const mockReaddir = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockStat = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: mockReaddir,
    rm: mockRm,
    stat: mockStat
  };
});

const BASE_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

/**
 * Builds a `stat` result carrying only the fields the sweeper reads.
 *
 * @param isDirectory - Whether the entry is a directory.
 * @param modifiedAtInMilliseconds - The entry's modification time.
 * @returns A minimal stat-shaped object.
 */
function makeStat(isDirectory: boolean, modifiedAtInMilliseconds: number): unknown {
  return {
    isDirectory: () => isDirectory,
    mtimeMs: modifiedAtInMilliseconds
  };
}

beforeEach(() => {
  mockReaddir.mockReset().mockResolvedValue([]);
  mockRm.mockReset().mockResolvedValue(undefined);
  mockStat.mockReset().mockResolvedValue(makeStat(true, 0));
  vi.restoreAllMocks();
});

describe('filterLeftoverNames', () => {
  it('should keep names matching a prefix', () => {
    expect(filterLeftoverNames({
      names: ['temp-vault-alpha', 'temp-vault-bravo'],
      prefixes: [TEMP_VAULT_DIR_PREFIX]
    })).toEqual(['temp-vault-alpha', 'temp-vault-bravo']);
  });

  it('should drop names matching no prefix', () => {
    expect(filterLeftoverNames({
      names: ['temp-vault-alpha', 'unrelated', 'obsidian-integration-testing'],
      prefixes: [TEMP_VAULT_DIR_PREFIX]
    })).toEqual(['temp-vault-alpha']);
  });

  it('should match any of several prefixes', () => {
    expect(filterLeftoverNames({
      names: ['temp-vault-alpha', 'userdata-bravo', 'charlie'],
      prefixes: [TEMP_VAULT_DIR_PREFIX, OWNED_USER_DATA_DIR_PREFIX]
    })).toEqual(['temp-vault-alpha', 'userdata-bravo']);
  });

  it('should drop excluded names', () => {
    expect(filterLeftoverNames({
      excludedNames: ['temp-vault-alpha'],
      names: ['temp-vault-alpha', 'temp-vault-bravo'],
      prefixes: [TEMP_VAULT_DIR_PREFIX]
    })).toEqual(['temp-vault-bravo']);
  });

  it('should trim surrounding whitespace and carriage returns from adb output lines', () => {
    expect(filterLeftoverNames({
      names: ['temp-vault-alpha\r', '  temp-vault-bravo  '],
      prefixes: [TEMP_VAULT_DIR_PREFIX]
    })).toEqual(['temp-vault-alpha', 'temp-vault-bravo']);
  });

  it('should drop blank lines and adb error output', () => {
    expect(filterLeftoverNames({
      names: ['', ' '.repeat(3), 'ls: /sdcard/Documents: No such file or directory', 'temp-vault-alpha'],
      prefixes: [TEMP_VAULT_DIR_PREFIX]
    })).toEqual(['temp-vault-alpha']);
  });
});

describe('checkIsLeftoverStale', () => {
  it('should treat an entry older than the max age as stale', () => {
    expect(checkIsLeftoverStale({
      maxAgeInMilliseconds: HOUR_IN_MILLISECONDS,
      modifiedAtInMilliseconds: FIXED_NOW_IN_MILLISECONDS - HOUR_IN_MILLISECONDS - 1,
      nowInMilliseconds: FIXED_NOW_IN_MILLISECONDS
    })).toBe(true);
  });

  it('should treat an entry younger than the max age as live', () => {
    expect(checkIsLeftoverStale({
      maxAgeInMilliseconds: HOUR_IN_MILLISECONDS,
      modifiedAtInMilliseconds: FIXED_NOW_IN_MILLISECONDS - 1,
      nowInMilliseconds: FIXED_NOW_IN_MILLISECONDS
    })).toBe(false);
  });

  it('should treat an entry exactly at the max age as stale', () => {
    expect(checkIsLeftoverStale({
      maxAgeInMilliseconds: HOUR_IN_MILLISECONDS,
      modifiedAtInMilliseconds: FIXED_NOW_IN_MILLISECONDS - HOUR_IN_MILLISECONDS,
      nowInMilliseconds: FIXED_NOW_IN_MILLISECONDS
    })).toBe(true);
  });

  it('should treat every entry as stale when the age gate is disabled with 0', () => {
    expect(checkIsLeftoverStale({
      maxAgeInMilliseconds: 0,
      modifiedAtInMilliseconds: FIXED_NOW_IN_MILLISECONDS,
      nowInMilliseconds: FIXED_NOW_IN_MILLISECONDS
    })).toBe(true);
  });

  it('should treat a future modification time as live', () => {
    expect(checkIsLeftoverStale({
      maxAgeInMilliseconds: HOUR_IN_MILLISECONDS,
      modifiedAtInMilliseconds: FIXED_NOW_IN_MILLISECONDS + HOUR_IN_MILLISECONDS,
      nowInMilliseconds: FIXED_NOW_IN_MILLISECONDS
    })).toBe(false);
  });
});

describe('willSweepLeftovers', () => {
  it('should default to true when the option is omitted', () => {
    expect(willSweepLeftovers(BASE_OPTIONS)).toBe(true);
    expect(willSweepLeftovers(undefined)).toBe(true);
  });

  it('should use the provided value when the option is set', () => {
    expect(willSweepLeftovers({ ...BASE_OPTIONS, shouldSweepLeftovers: false })).toBe(false);
  });
});

describe('resolveLeftoverMaxAgeInMilliseconds', () => {
  it('should default to 7200000ms when the option is omitted', () => {
    expect(resolveLeftoverMaxAgeInMilliseconds(BASE_OPTIONS)).toBe(7_200_000);
    expect(resolveLeftoverMaxAgeInMilliseconds(undefined)).toBe(7_200_000);
    expect(DEFAULT_LEFTOVER_MAX_AGE_IN_MILLISECONDS).toBe(7_200_000);
  });

  it('should use the provided value when the option is set', () => {
    expect(
      resolveLeftoverMaxAgeInMilliseconds({ ...BASE_OPTIONS, leftoverMaxAgeInMilliseconds: HOUR_IN_MILLISECONDS })
    ).toBe(HOUR_IN_MILLISECONDS);
  });

  it('should allow 0 to disable the age gate', () => {
    expect(
      resolveLeftoverMaxAgeInMilliseconds({ ...BASE_OPTIONS, leftoverMaxAgeInMilliseconds: 0 })
    ).toBe(0);
  });
});

describe('sweepHostLeftovers', () => {
  it('should remove stale matching directories', async () => {
    mockReaddir.mockResolvedValue(['temp-vault-alpha', 'temp-vault-bravo']);
    mockStat.mockResolvedValue(makeStat(true, 0));

    const result = await sweepHostLeftovers({
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });

    expect(result).toEqual({ failedCount: 0, removedCount: 2 });
    expect(mockRm).toHaveBeenCalledWith(join('/scratch', 'temp-vault-alpha'), { force: true, recursive: true });
    expect(mockRm).toHaveBeenCalledWith(join('/scratch', 'temp-vault-bravo'), { force: true, recursive: true });
  });

  it('should keep a directory younger than the max age', async () => {
    mockReaddir.mockResolvedValue(['temp-vault-alpha']);
    mockStat.mockResolvedValue(makeStat(true, Date.now()));

    const result = await sweepHostLeftovers({
      maxAgeInMilliseconds: HOUR_IN_MILLISECONDS,
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });

    expect(result).toEqual({ failedCount: 0, removedCount: 0 });
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('should keep an excluded directory', async () => {
    mockReaddir.mockResolvedValue(['temp-vault-alpha']);

    const result = await sweepHostLeftovers({
      excludedNames: ['temp-vault-alpha'],
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });

    expect(result).toEqual({ failedCount: 0, removedCount: 0 });
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('should not stat entries that do not match a prefix', async () => {
    mockReaddir.mockResolvedValue(['unrelated-file.txt']);

    const result = await sweepHostLeftovers({
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });

    expect(result).toEqual({ failedCount: 0, removedCount: 0 });
    expect(mockStat).not.toHaveBeenCalled();
  });

  it('should skip a matching entry that is not a directory', async () => {
    mockReaddir.mockResolvedValue(['temp-vault-alpha']);
    mockStat.mockResolvedValue(makeStat(false, 0));

    const result = await sweepHostLeftovers({
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });

    expect(result).toEqual({ failedCount: 0, removedCount: 0 });
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('should tolerate an unreadable root', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));

    const result = await sweepHostLeftovers({
      roots: [{ path: '/missing', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });

    expect(result).toEqual({ failedCount: 0, removedCount: 0 });
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('should tolerate an entry whose stat fails', async () => {
    mockReaddir.mockResolvedValue(['temp-vault-alpha']);
    mockStat.mockRejectedValue(new Error('EPERM'));

    const result = await sweepHostLeftovers({
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });

    expect(result).toEqual({ failedCount: 0, removedCount: 0 });
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('should count a directory it cannot remove as failed', async () => {
    mockReaddir.mockResolvedValue(['temp-vault-alpha']);
    mockStat.mockResolvedValue(makeStat(true, 0));
    mockRm.mockRejectedValue(new Error('EPERM'));

    const result = await sweepHostLeftovers({
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });

    expect(result).toEqual({ failedCount: 1, removedCount: 0 });
  });

  it('should default the age gate to 7200000ms when it is omitted', async () => {
    mockReaddir.mockResolvedValue(['temp-vault-alpha']);
    mockStat.mockResolvedValue(makeStat(true, Date.now() - HOUR_IN_MILLISECONDS));

    const youngResult = await sweepHostLeftovers({
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });
    expect(youngResult).toEqual({ failedCount: 0, removedCount: 0 });

    const OLDER_THAN_DEFAULT_IN_MILLISECONDS = DEFAULT_LEFTOVER_MAX_AGE_IN_MILLISECONDS + HOUR_IN_MILLISECONDS;
    mockStat.mockResolvedValue(makeStat(true, Date.now() - OLDER_THAN_DEFAULT_IN_MILLISECONDS));

    const oldResult = await sweepHostLeftovers({
      roots: [{ path: '/scratch', prefixes: [TEMP_VAULT_DIR_PREFIX] }]
    });
    expect(oldResult).toEqual({ failedCount: 0, removedCount: 1 });
  });

  it('should sweep the temp root and the owned user-data root by default', async () => {
    await sweepHostLeftovers();

    expect(mockReaddir).toHaveBeenCalledWith(tmpdir());
    expect(mockReaddir).toHaveBeenCalledWith(join(tmpdir(), 'obsidian-integration-testing'));
  });
});

describe('sweepDeviceLeftovers', () => {
  const VAULT_BASE_PATH = '/sdcard/Documents/';

  /**
   * Builds a device double whose listing reflects the removals that succeeded.
   *
   * @param names - The entry names the device starts with.
   * @param unremovableNames - The names whose removal fails, as the emulator's un-expressible entry does.
   * @returns The `listNames` / `removeDirectory` pair plus the removal paths attempted, in order.
   */
  function createDevice(names: readonly string[], unremovableNames: readonly string[] = []): DeviceDouble {
    const remaining = new Set(names);
    const attemptedPaths: string[] = [];
    return {
      attemptedPaths,
      listNames: (): Promise<readonly string[]> => Promise.resolve([...remaining]),
      removeDirectory: (path: string): Promise<void> => {
        attemptedPaths.push(path);
        const name = path.slice(VAULT_BASE_PATH.length);
        if (unremovableNames.includes(name)) {
          return Promise.reject(new Error(`rm: ${name}: Operation not permitted`));
        }
        remaining.delete(name);
        return Promise.resolve();
      }
    };
  }

  it('should report nothing when the device carries no leftovers', async () => {
    const device = createDevice([]);

    const result = await sweepDeviceLeftovers({ ...device, vaultBasePath: VAULT_BASE_PATH });

    expect(result).toEqual({ failedNames: [], removedCount: 0 });
    expect(device.attemptedPaths).toEqual([]);
  });

  it('should ignore entries that are not temp vaults', async () => {
    const device = createDevice(['notes', 'Downloads']);

    const result = await sweepDeviceLeftovers({ ...device, vaultBasePath: VAULT_BASE_PATH });

    expect(result).toEqual({ failedNames: [], removedCount: 0 });
    expect(device.attemptedPaths).toEqual([]);
  });

  it('should remove every temp vault, one directory at a time', async () => {
    const device = createDevice(['temp-vault-a', 'temp-vault-b', 'notes']);

    const result = await sweepDeviceLeftovers({ ...device, vaultBasePath: VAULT_BASE_PATH });

    expect(result).toEqual({ failedNames: [], removedCount: DEVICE_VAULT_COUNT_2 });
    expect(device.attemptedPaths).toEqual(['/sdcard/Documents/temp-vault-a', '/sdcard/Documents/temp-vault-b']);
  });

  // The defect this function exists for: one directory whose name the FUSE layer cannot express refuses
  // Removal forever, and a single batched `rm -rf` let it take every other directory down with it.
  it('should remove the rest when one directory refuses to be removed', async () => {
    const device = createDevice(
      ['temp-vault-a', 'temp-vault-X8fvA4', 'temp-vault-b'],
      ['temp-vault-X8fvA4']
    );

    const result = await sweepDeviceLeftovers({ ...device, vaultBasePath: VAULT_BASE_PATH });

    expect(result.removedCount).toBe(DEVICE_VAULT_COUNT_2);
    expect(result.failedNames).toEqual(['temp-vault-X8fvA4']);
    expect(device.attemptedPaths).toHaveLength(DEVICE_VAULT_COUNT_3);
  });

  // A removal command can exit 0 and still leave the directory behind, which is how a sweep came to
  // Report success while clearing nothing. Counting the survivors is the only honest answer.
  it('should not count a directory that survives a removal reporting success', async () => {
    const result = await sweepDeviceLeftovers({
      listNames: (): Promise<readonly string[]> => Promise.resolve(['temp-vault-a']),
      removeDirectory: (): Promise<void> => Promise.resolve(),
      vaultBasePath: VAULT_BASE_PATH
    });

    expect(result).toEqual({ failedNames: ['temp-vault-a'], removedCount: 0 });
  });

  it('should join the base path and the name without inserting a separator', async () => {
    const device = createDevice(['temp-vault-a']);

    await sweepDeviceLeftovers({ ...device, vaultBasePath: VAULT_BASE_PATH });

    expect(device.attemptedPaths).toEqual(['/sdcard/Documents/temp-vault-a']);
  });
});
