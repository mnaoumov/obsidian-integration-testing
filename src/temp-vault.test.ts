import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { noopAsync } from './noop.ts';
import { TempVault } from './temp-vault.ts';

const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockMkdtempSync = vi.hoisted(() => vi.fn<(prefix: string) => string>().mockReturnValue('/tmp/temp-vault-abc'));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockRegisterVault = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockUnregisterVault = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: mockMkdirSync,
    mkdtempSync: mockMkdtempSync,
    writeFileSync: mockWriteFileSync
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: mockRm
  };
});

vi.mock('./vault-registry.ts', () => ({
  registerVault: mockRegisterVault,
  unregisterVault: mockUnregisterVault
}));

beforeEach(() => {
  mockMkdirSync.mockReset();
  mockMkdtempSync.mockReset().mockReturnValue('/tmp/temp-vault-abc');
  mockWriteFileSync.mockReset();
  mockRm.mockReset().mockResolvedValue(undefined);
  mockRegisterVault.mockReset().mockResolvedValue(undefined);
  mockUnregisterVault.mockReset().mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

describe('TempVault constructor', () => {
  it('should create a temp directory when no path is provided', () => {
    const vault = new TempVault();
    expect(vault.path).toBe('/tmp/temp-vault-abc');
    expect(mockMkdtempSync).toHaveBeenCalled();
  });

  it('should use the provided path', () => {
    const vault = new TempVault('/my/vault');
    expect(vault.path).toBe('/my/vault');
    expect(mockMkdtempSync).not.toHaveBeenCalled();
  });
});

describe('populate', () => {
  it('should write a file with content', () => {
    const vault = new TempVault('/vault');
    vault.populate({ 'note.md': '# Hello' });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/note\.md$/),
      '# Hello'
    );
  });

  it('should create parent directories for nested files', () => {
    const vault = new TempVault('/vault');
    vault.populate({ 'a/b/c.md': 'deep' });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/a.*b$/),
      { recursive: true }
    );
  });

  it('should create empty folders for paths ending with /', () => {
    const vault = new TempVault('/vault');
    vault.populate({ 'empty-dir/': '' });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/empty-dir/),
      { recursive: true }
    );
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should throw when folder path has non-empty content', () => {
    const vault = new TempVault('/vault');
    expect(() => {
      vault.populate({ 'bad-dir/': 'not empty' });
    }).toThrow('Folder path "bad-dir/" must have empty content');
  });

  it('should write multiple files', () => {
    const vault = new TempVault('/vault');
    vault.populate({
      'a.md': 'aaa',
      'b.md': 'bbb'
    });
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    expect(mockWriteFileSync).toHaveBeenCalledWith(expect.stringMatching(/a\.md$/), 'aaa');
    expect(mockWriteFileSync).toHaveBeenCalledWith(expect.stringMatching(/b\.md$/), 'bbb');
  });
});

describe('register', () => {
  it('should call registerVault with the vault path', async () => {
    const vault = new TempVault('/vault');
    await vault.register();
    expect(mockRegisterVault).toHaveBeenCalledWith('/vault');
  });
});

describe('dispose', () => {
  it('should unregister and remove the vault directory', async () => {
    const vault = new TempVault('/vault');
    await vault.dispose();
    expect(mockUnregisterVault).toHaveBeenCalledWith('/vault');
    expect(mockRm).toHaveBeenCalledWith('/vault', { force: true, recursive: true });
  });

  it('should retry rm when it fails temporarily', async () => {
    let callCount = 0;
    mockRm.mockImplementation(async () => {
      await noopAsync();
      callCount++;
      if (callCount === 1) {
        throw new Error('EBUSY');
      }
    });

    const vault = new TempVault('/vault');
    await vault.dispose();
    expect(mockRm).toHaveBeenCalledTimes(2);
  });

  it('should throw after retry timeout', async () => {
    // Make Date.now() jump past the deadline after first rm attempt
    const realDateNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // First call: set deadline. Second call: still within deadline.
      // Third call onward: past deadline.
      if (callCount <= 2) {
        return realDateNow();
      }
      return realDateNow() + 20000;
    });

    mockRm.mockRejectedValue(new Error('EBUSY'));

    const vault = new TempVault('/vault');
    await expect(vault.dispose()).rejects.toThrow('EBUSY');
  });
});

describe('Symbol.asyncDispose', () => {
  it('should dispose when used with await using', async () => {
    {
      await using _vault = new TempVault('/vault');
    }
    expect(mockUnregisterVault).toHaveBeenCalledWith('/vault');
    expect(mockRm).toHaveBeenCalled();
  });
});
