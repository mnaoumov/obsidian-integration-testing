import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  getVaultId,
  isVaultRegistered,
  removeVaultFromConfig
} from './obsidian-config.ts';
import { ensureNonNullable } from './type-guards.ts';

interface MockEnv {
  APPDATA: string | undefined;
}

const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());
const mockWriteFileSync = vi.hoisted(() => vi.fn<(path: string, content: string) => void>());
const mockPlatform = vi.hoisted(() => ({ value: 'win32' }));
const mockEnv = vi.hoisted((): MockEnv => ({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync
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
  vaults: {
    '5e01ed323ddcc367': { path: 'F:\\Obsidian', ts: 1774321021398 },
    'abc123': { open: true, path: 'F:\\dev\\test-vault', ts: 1774322353409 }
  }
});

beforeEach(() => {
  mockWriteFileSync.mockReset();
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

  it('should honor XDG_CONFIG_HOME on Linux when set', () => {
    mockPlatform.value = 'linux';
    const savedAppData = mockEnv.APPDATA;
    const savedXdg = process.env['XDG_CONFIG_HOME'];
    mockEnv.APPDATA = undefined;
    process.env['XDG_CONFIG_HOME'] = '/custom/xdg';
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    isVaultRegistered('F:\\Obsidian');
    expect(mockReadFileSync).toHaveBeenLastCalledWith(
      expect.stringMatching(/custom.xdg.obsidian/),
      'utf-8'
    );
    if (savedXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = savedXdg;
    }
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

describe('removeVaultFromConfig', () => {
  it('should remove a vault entry by path', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);

    const result = removeVaultFromConfig('F:\\Obsidian');

    expect(result).toBe(true);
    const writtenContent = getLastWrittenContent();
    expect(writtenContent).not.toContain('F:\\\\Obsidian');
  });

  it('should return false when vault path is not found', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);

    const result = removeVaultFromConfig('F:\\nonexistent');

    expect(result).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should return false when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = removeVaultFromConfig('F:\\Obsidian');

    expect(result).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should match case-insensitively on Windows', () => {
    mockPlatform.value = 'win32';
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);

    const result = removeVaultFromConfig('f:\\obsidian');

    expect(result).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

function getLastWrittenContent(): string {
  const calls = mockWriteFileSync.mock.calls;
  const lastCall = ensureNonNullable(calls[calls.length - 1]);
  return lastCall[1];
}
