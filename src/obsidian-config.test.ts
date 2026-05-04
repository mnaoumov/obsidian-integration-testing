import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  getAnyRegisteredVaultPath,
  getVaultId,
  isCliEnabled,
  isVaultRegistered
} from './obsidian-config.ts';

interface MockEnv {
  APPDATA: string | undefined;
}

const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());
const mockPlatform = vi.hoisted(() => ({ value: 'win32' }));
const mockEnv = vi.hoisted((): MockEnv => ({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: mockReadFileSync
  };
});

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return {
    ...actual,
    default: {
      ...actual,
      get env(): Record<string, string | undefined> {
        return { ...actual.env, ...mockEnv };
      },
      get platform(): string {
        return mockPlatform.value;
      }
    }
  };
});

const OBSIDIAN_JSON = JSON.stringify({
  cli: true,
  vaults: {
    '5e01ed323ddcc367': { path: 'F:\\Obsidian', ts: 1774321021398 },
    'abc123': { open: true, path: 'F:\\dev\\test-vault', ts: 1774322353409 }
  }
});

describe('isVaultRegistered', () => {
  it('should return true when vault path is in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultRegistered('F:\\Obsidian')).toBe(true);
  });

  it('should return false when vault path is not in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultRegistered('F:\\nonexistent')).toBe(false);
  });

  it('should return false when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isVaultRegistered('F:\\Obsidian')).toBe(false);
  });

  it('should normalize path comparison case-insensitively on Windows', () => {
    mockPlatform.value = 'win32';
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultRegistered('f:\\obsidian')).toBe(true);
    expect(isVaultRegistered('F:\\OBSIDIAN')).toBe(true);
  });

  it('should use macOS config path on darwin', () => {
    mockPlatform.value = 'darwin';
    const savedAppData = mockEnv.APPDATA;
    mockEnv.APPDATA = undefined;
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    isVaultRegistered('F:\\Obsidian');
    expect(mockReadFileSync).toHaveBeenLastCalledWith(
      expect.stringMatching(/Library.*Application Support.*obsidian/),
      'utf-8'
    );
    mockEnv.APPDATA = savedAppData;
    mockPlatform.value = 'win32';
  });

  it('should fall through to non-Windows path when APPDATA is not set on win32', () => {
    mockPlatform.value = 'win32';
    const savedAppData = mockEnv.APPDATA;
    mockEnv.APPDATA = undefined;
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    isVaultRegistered('F:\\Obsidian');
    expect(mockReadFileSync).toHaveBeenLastCalledWith(
      expect.stringMatching(/\.config.*obsidian/),
      'utf-8'
    );
    mockEnv.APPDATA = savedAppData;
  });

  it('should use XDG config path on Linux', () => {
    mockPlatform.value = 'linux';
    const savedAppData = mockEnv.APPDATA;
    mockEnv.APPDATA = undefined;
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    isVaultRegistered('F:\\Obsidian');
    expect(mockReadFileSync).toHaveBeenLastCalledWith(
      expect.stringMatching(/\.config.*obsidian/),
      'utf-8'
    );
    mockEnv.APPDATA = savedAppData;
    mockPlatform.value = 'win32';
  });

  it('should handle malformed obsidian.json gracefully', () => {
    mockReadFileSync.mockReturnValue('not valid json {{{');
    expect(isVaultRegistered('F:\\Obsidian')).toBe(false);
  });

  it('should normalize path separators', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultRegistered('F:/Obsidian')).toBe(true);
  });
});

describe('getVaultId', () => {
  it('should return the vault ID when vault path is in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(getVaultId('F:\\Obsidian')).toBe('5e01ed323ddcc367');
  });

  it('should return undefined when vault path is not in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(getVaultId('F:\\nonexistent')).toBeUndefined();
  });

  it('should return undefined when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(getVaultId('F:\\Obsidian')).toBeUndefined();
  });

  it('should match case-insensitively on Windows', () => {
    mockPlatform.value = 'win32';
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(getVaultId('f:\\obsidian')).toBe('5e01ed323ddcc367');
  });
});

describe('isCliEnabled', () => {
  it('should return true when cli is true in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isCliEnabled()).toBe(true);
  });

  it('should return false when cli is false in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ cli: false, vaults: {} }));
    expect(isCliEnabled()).toBe(false);
  });

  it('should return false when cli is absent in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ vaults: {} }));
    expect(isCliEnabled()).toBe(false);
  });

  it('should return false when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isCliEnabled()).toBe(false);
  });
});

describe('getAnyRegisteredVaultPath', () => {
  it('should return the first vault path when vaults exist', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(getAnyRegisteredVaultPath()).toBe('F:\\Obsidian');
  });

  it('should return undefined when no vaults are registered', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ vaults: {} }));
    expect(getAnyRegisteredVaultPath()).toBeUndefined();
  });

  it('should return undefined when obsidian.json cannot be read', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(getAnyRegisteredVaultPath()).toBeUndefined();
  });
});
