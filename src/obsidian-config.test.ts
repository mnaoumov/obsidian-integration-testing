import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  didRemoveVaultFromConfig,
  getVaultId,
  isVaultRegistered
} from './obsidian-config.ts';
import { ensureNonNullable } from './type-guards.ts';

interface MockEnv {
  APPDATA: string | undefined;
}

const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());
const mockWriteFileSync = vi.hoisted(() => vi.fn<(path: string, content: string) => void>());
const mockPlatform = vi.hoisted(() => ({ value: 'win32' }));
const mockEnv = vi.hoisted((): MockEnv => ({ APPDATA: String.raw`C:\Users\test\AppData\Roaming` }));

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
    '5e01ed323ddcc367': { path: String.raw`F:\Obsidian`, ts: 1_774_321_021_398 },
    'abc123': { open: true, path: String.raw`F:\dev\test-vault`, ts: 1_774_322_353_409 }
  }
});

beforeEach(() => {
  mockWriteFileSync.mockReset();
});

describe('isVaultRegistered', () => {
  it('should return true when vault path is in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultRegistered(String.raw`F:\Obsidian`)).toBe(true);
  });

  it('should return false when vault path is not in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultRegistered(String.raw`F:\nonexistent`)).toBe(false);
  });

  it('should return false when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isVaultRegistered(String.raw`F:\Obsidian`)).toBe(false);
  });

  it('should normalize path comparison case-insensitively on Windows', () => {
    mockPlatform.value = 'win32';
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultRegistered(String.raw`f:\obsidian`)).toBe(true);
    expect(isVaultRegistered(String.raw`F:\OBSIDIAN`)).toBe(true);
  });

  it('should use macOS config path on darwin', () => {
    mockPlatform.value = 'darwin';
    const savedAppData = mockEnv.APPDATA;
    mockEnv.APPDATA = undefined;
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    isVaultRegistered(String.raw`F:\Obsidian`);
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
    isVaultRegistered(String.raw`F:\Obsidian`);
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
    isVaultRegistered(String.raw`F:\Obsidian`);
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
    isVaultRegistered(String.raw`F:\Obsidian`);
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
    expect(isVaultRegistered(String.raw`F:\Obsidian`)).toBe(false);
  });

  it('should normalize path separators', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultRegistered('F:/Obsidian')).toBe(true);
  });
});

describe('getVaultId', () => {
  it('should return the vault ID when vault path is in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(getVaultId(String.raw`F:\Obsidian`)).toBe('5e01ed323ddcc367');
  });

  it('should return undefined when vault path is not in obsidian.json', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(getVaultId(String.raw`F:\nonexistent`)).toBeUndefined();
  });

  it('should return undefined when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(getVaultId(String.raw`F:\Obsidian`)).toBeUndefined();
  });

  it('should match case-insensitively on Windows', () => {
    mockPlatform.value = 'win32';
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(getVaultId(String.raw`f:\obsidian`)).toBe('5e01ed323ddcc367');
  });
});

describe('didRemoveVaultFromConfig', () => {
  it('should remove a vault entry by path', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);

    const isVaultRemoved = didRemoveVaultFromConfig(String.raw`F:\Obsidian`);

    expect(isVaultRemoved).toBe(true);
    const writtenContent = getLastWrittenContent();
    expect(writtenContent).not.toContain(String.raw`F:\\Obsidian`);
  });

  it('should return false when vault path is not found', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);

    const isVaultRemoved = didRemoveVaultFromConfig(String.raw`F:\nonexistent`);

    expect(isVaultRemoved).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should return false when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const isVaultRemoved = didRemoveVaultFromConfig(String.raw`F:\Obsidian`);

    expect(isVaultRemoved).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should match case-insensitively on Windows', () => {
    mockPlatform.value = 'win32';
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);

    const isVaultRemoved = didRemoveVaultFromConfig(String.raw`f:\obsidian`);

    expect(isVaultRemoved).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

function getLastWrittenContent(): string {
  const calls = mockWriteFileSync.mock.calls;
  const lastCall = ensureNonNullable(calls.at(-1));
  return lastCall[1];
}
