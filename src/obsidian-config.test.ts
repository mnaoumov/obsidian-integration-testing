import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  enableCliInConfig,
  getAnyOpenVaultPath,
  getAnyRegisteredVaultPath,
  getRegisteredVaults,
  getVaultId,
  isCliEnabled,
  isVaultOpen,
  isVaultRegistered,
  registerVaultInConfig,
  removeVaultFromConfig
} from './obsidian-config.ts';
import { ensureNonNullable } from './type-guards.ts';

interface MockEnv {
  APPDATA: string | undefined;
}

interface VaultEntryShape {
  ts: number;
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

vi.mock('node:crypto', () => ({
  randomBytes: (): Buffer => Buffer.from('a1b2c3d4e5f6a7b8', 'hex')
}));

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

describe('getAnyOpenVaultPath', () => {
  it('should return the first vault path whose open flag is true', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(getAnyOpenVaultPath()).toBe('F:\\dev\\test-vault');
  });

  it('should return undefined when no vault is open', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      vaults: {
        a: { path: 'F:\\a' },
        b: { open: false, path: 'F:\\b' }
      }
    }));
    expect(getAnyOpenVaultPath()).toBeUndefined();
  });

  it('should return undefined when obsidian.json cannot be read', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(getAnyOpenVaultPath()).toBeUndefined();
  });
});

describe('getRegisteredVaults', () => {
  it('should return all registered vaults with their IDs and open status', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    const vaults = getRegisteredVaults();
    expect(vaults).toEqual([
      { id: '5e01ed323ddcc367', open: false, path: 'F:\\Obsidian' },
      { id: 'abc123', open: true, path: 'F:\\dev\\test-vault' }
    ]);
  });

  it('should return empty array when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(getRegisteredVaults()).toEqual([]);
  });
});

describe('isVaultOpen', () => {
  it('should return true when vault is marked as open', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultOpen('F:\\dev\\test-vault')).toBe(true);
  });

  it('should return false when vault is not marked as open', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultOpen('F:\\Obsidian')).toBe(false);
  });

  it('should return false when vault is not registered', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultOpen('F:\\nonexistent')).toBe(false);
  });

  it('should return false when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isVaultOpen('F:\\Obsidian')).toBe(false);
  });

  it('should match case-insensitively on Windows', () => {
    mockPlatform.value = 'win32';
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);
    expect(isVaultOpen('f:\\dev\\test-vault')).toBe(true);
  });
});

describe('enableCliInConfig', () => {
  it('should set cli to true in existing config', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ cli: false, vaults: {} }));

    enableCliInConfig();

    const writtenContent = getLastWrittenContent();
    const config = JSON.parse(writtenContent) as Record<string, unknown>;
    expect(config['cli']).toBe(true);
  });

  it('should create config with cli enabled when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    enableCliInConfig();

    const writtenContent = getLastWrittenContent();
    const config = JSON.parse(writtenContent) as Record<string, unknown>;
    expect(config['cli']).toBe(true);
  });
});

describe('registerVaultInConfig', () => {
  it('should add a vault entry to existing config', () => {
    mockReadFileSync.mockReturnValue(OBSIDIAN_JSON);

    registerVaultInConfig('F:\\new-vault');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('obsidian.json'),
      expect.stringContaining('F:\\\\new-vault')
    );
  });

  it('should create config with vault entry when obsidian.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    registerVaultInConfig('F:\\new-vault');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('obsidian.json'),
      expect.stringContaining('F:\\\\new-vault')
    );
  });

  it('should generate a random hex vault ID', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ vaults: {} }));

    registerVaultInConfig('F:\\new-vault');

    const writtenContent = getLastWrittenContent();
    const config = JSON.parse(writtenContent) as Record<string, unknown>;
    const vaults = config['vaults'] as Record<string, unknown>;
    const keys = Object.keys(vaults);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[\da-f]{16}$/);
  });

  it('should enable cli in the config', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ vaults: {} }));

    registerVaultInConfig('F:\\new-vault');

    const writtenContent = getLastWrittenContent();
    const config = JSON.parse(writtenContent) as Record<string, unknown>;
    expect(config['cli']).toBe(true);
  });

  it('should include a timestamp in the vault entry', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ vaults: {} }));

    registerVaultInConfig('F:\\new-vault');

    const writtenContent = getLastWrittenContent();
    const config = JSON.parse(writtenContent) as Record<string, unknown>;
    const vaults = config['vaults'] as Record<string, VaultEntryShape>;
    const entry = Object.values(vaults)[0];
    expect(entry?.ts).toBeTypeOf('number');
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
