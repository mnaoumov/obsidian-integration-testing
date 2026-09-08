import type { Dirent } from 'node:fs';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ObsidianTransport } from './transport.ts';

import { noopAsync } from './noop.ts';
import { strictProxy } from './strict-proxy.ts';
import { TemporaryVault } from './temporary-vault.ts';

const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockMkdtempSync = vi.hoisted(() => vi.fn<(prefix: string) => string>().mockReturnValue('/tmp/temp-vault-abc'));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockRegisterVault = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockUnregisterVault = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockLog = vi.hoisted(() => vi.fn<(message: string) => void>());
const mockGetOrCreateTransport = vi.hoisted(() => vi.fn<() => Promise<ObsidianTransport>>());
const mockGetTransportOptions = vi.hoisted(() => vi.fn<() => unknown>());
const mockReaddir = vi.hoisted(() => vi.fn<() => Promise<Dirent[]>>());
const mockReadFile = vi.hoisted(() => vi.fn<() => Promise<Uint8Array>>());

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
    readdir: mockReaddir,
    readFile: mockReadFile,
    rm: mockRm
  };
});

vi.mock('./vault-registry.ts', () => ({
  registerVault: mockRegisterVault,
  unregisterVault: mockUnregisterVault
}));

vi.mock('./transport-factory.ts', () => ({
  getOrCreateTransport: mockGetOrCreateTransport
}));

vi.mock('./context-provider.ts', () => ({
  getTransportOptions: mockGetTransportOptions
}));

vi.mock('./log.ts', () => ({
  log: mockLog
}));

/**
 * Builds a stand-in transport for the `register` tests.
 *
 * Only `pushFiles` is ever consulted on this path, and whether it is present is exactly what decides
 * between a mobile transport (the vault directory has to be carried to the device) and a desktop one
 * (the app already reads the host filesystem), so the rest of the interface is left off.
 *
 * @param pushFiles - The transport's `pushFiles`, or `undefined` for a transport that has none.
 * @returns The stand-in transport.
 */
function createTransportStub(pushFiles?: ObsidianTransport['pushFiles']): ObsidianTransport {
  // `pushFiles` is always an own key, so the proxy answers the presence check rather than throwing on it.
  return strictProxy<ObsidianTransport>({ pushFiles });
}

beforeEach(() => {
  mockMkdirSync.mockReset();
  mockMkdtempSync.mockReset().mockReturnValue('/tmp/temp-vault-abc');
  mockWriteFileSync.mockReset();
  mockRm.mockReset().mockResolvedValue(undefined);
  mockRegisterVault.mockReset().mockResolvedValue(undefined);
  mockUnregisterVault.mockReset().mockResolvedValue(undefined);
  mockLog.mockReset();
  mockReaddir.mockReset().mockResolvedValue([]);
  mockReadFile.mockReset().mockResolvedValue(new Uint8Array());
  mockGetTransportOptions.mockReset().mockReturnValue({});
  mockGetOrCreateTransport.mockReset().mockResolvedValue(createTransportStub());
  vi.restoreAllMocks();
});

describe('TemporaryVault constructor', () => {
  it('should create a temp directory when no path is provided', () => {
    const vault = new TemporaryVault();
    expect(vault.path).toBe('/tmp/temp-vault-abc');
    expect(mockMkdtempSync).toHaveBeenCalled();
  });

  it('should use the provided path', () => {
    const vault = new TemporaryVault('/my/vault');
    expect(vault.path).toBe('/my/vault');
    expect(mockMkdtempSync).not.toHaveBeenCalled();
  });
});

describe('populate', () => {
  it('should write a file with content', () => {
    const vault = new TemporaryVault('/vault');
    vault.populate({ 'note.md': '# Hello' });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/note\.md$/),
      '# Hello'
    );
  });

  it('should create parent directories for nested files', () => {
    const vault = new TemporaryVault('/vault');
    vault.populate({ 'a/b/c.md': 'deep' });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/a.*b$/),
      { recursive: true }
    );
  });

  it('should create empty folders for paths ending with /', () => {
    const vault = new TemporaryVault('/vault');
    vault.populate({ 'empty-dir/': undefined });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/empty-dir/),
      { recursive: true }
    );
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should throw when folder path has defined content', () => {
    const vault = new TemporaryVault('/vault');
    expect(() => {
      vault.populate({ 'bad-dir/': 'not empty' });
    }).toThrow('Folder path "bad-dir/" must have undefined content');
  });

  it('should write binary files from Uint8Array', () => {
    const vault = new TemporaryVault('/vault');
    const binaryContent = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
    vault.populate({ 'image.png': binaryContent });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/image\.png$/),
      binaryContent
    );
  });

  it('should throw when file path has undefined content', () => {
    const vault = new TemporaryVault('/vault');
    expect(() => {
      vault.populate({ 'note.md': undefined });
    }).toThrow('File path "note.md" must have defined content; use a trailing "/" for folders');
  });

  it('should write multiple files', () => {
    const vault = new TemporaryVault('/vault');
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
  it('should call registerVault with the vault path and the resolved transport', async () => {
    const transport = createTransportStub();
    mockGetOrCreateTransport.mockResolvedValue(transport);

    const vault = new TemporaryVault('/vault');
    await vault.register();

    expect(mockRegisterVault).toHaveBeenCalledWith('/vault', transport);
  });

  it('should resolve the transport once and hand the same one to both steps', async () => {
    const pushFiles = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const transport = createTransportStub(pushFiles);
    mockGetOrCreateTransport.mockResolvedValue(transport);

    const vault = new TemporaryVault('/vault');
    await vault.register();

    // A second resolution could hand the push and the registration two different transports.
    expect(mockGetOrCreateTransport).toHaveBeenCalledTimes(1);
    expect(pushFiles).toHaveBeenCalledWith('/vault', {});
    expect(mockRegisterVault).toHaveBeenCalledWith('/vault', transport);
  });

  // The defect this ordering exists to prevent: registering first opens the vault on the device before
  // Its files are there, so the app reads an EMPTY vault and nothing is raised to say so.
  it('should push the vault directory BEFORE registering it', async () => {
    const calls: string[] = [];
    const pushFiles = vi.fn(async () => {
      calls.push('pushFiles');
      await Promise.resolve();
    });
    mockRegisterVault.mockImplementation(async () => {
      calls.push('registerVault');
      await Promise.resolve();
    });

    const vault = new TemporaryVault('/vault');
    await vault.register(createTransportStub(pushFiles));

    expect(calls).toStrictEqual(['pushFiles', 'registerVault']);
  });

  it('should skip the push on a transport that has no pushFiles', async () => {
    const vault = new TemporaryVault('/vault');
    await vault.register(createTransportStub());

    // Desktop: the app already reads the host filesystem, so there is nothing to collect or carry.
    expect(mockReaddir).not.toHaveBeenCalled();
    expect(mockRegisterVault).toHaveBeenCalledWith('/vault', expect.anything());
  });

  it('should not resolve a transport when handed an explicit one', async () => {
    const vault = new TemporaryVault('/vault');
    await vault.register(createTransportStub());

    expect(mockGetOrCreateTransport).not.toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('should unregister and remove a directory it created', async () => {
    const vault = new TemporaryVault();
    await vault.dispose();
    expect(mockUnregisterVault).toHaveBeenCalledWith('/tmp/temp-vault-abc', undefined);
    expect(mockRm).toHaveBeenCalledWith('/tmp/temp-vault-abc', { force: true, recursive: true });
  });

  it('should unregister but keep a directory it did not create', async () => {
    const vault = new TemporaryVault('/vault');
    await vault.dispose();
    expect(mockUnregisterVault).toHaveBeenCalledWith('/vault', undefined);
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('/vault'));
  });

  it('should remove a directory it did not create when told to explicitly', async () => {
    const vault = new TemporaryVault('/vault', { shouldRemoveDirectoryOnDispose: true });
    await vault.dispose();
    expect(mockRm).toHaveBeenCalledWith('/vault', { force: true, recursive: true });
  });

  it('should keep a directory it created when told to explicitly', async () => {
    const vault = new TemporaryVault(undefined, { shouldRemoveDirectoryOnDispose: false });
    await vault.dispose();
    expect(mockUnregisterVault).toHaveBeenCalledWith('/tmp/temp-vault-abc', undefined);
    expect(mockRm).not.toHaveBeenCalled();
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

    const vault = new TemporaryVault();
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
      return realDateNow() + 20_000;
    });

    mockRm.mockRejectedValue(new Error('EBUSY'));

    const vault = new TemporaryVault();
    await expect(vault.dispose()).rejects.toThrow('EBUSY');
  });
});

describe('Symbol.asyncDispose', () => {
  it('should dispose when used with await using', async () => {
    {
      await using _vault = new TemporaryVault();
    }
    expect(mockUnregisterVault).toHaveBeenCalledWith('/tmp/temp-vault-abc', undefined);
    expect(mockRm).toHaveBeenCalled();
  });
});
