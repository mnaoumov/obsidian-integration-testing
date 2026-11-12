/* eslint-disable camelcase -- last_open is Obsidian's own obsidian.json field name. */
import { join } from 'node:path';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  acquirePersistentProfileLock,
  mergePersistentObsidianJson,
  PERSISTENT_PROFILE_LOCK_FILE_NAME,
  PersistentProfileInUseError,
  readPersistentProfileLock
} from './persistent-profile.ts';

const files = new Map<string, string>();
const aliveMock = vi.hoisted(() => vi.fn<(pid: number) => boolean>());

vi.mock('node:fs', () => ({
  readFileSync: (path: string): string => {
    const content = files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  },
  rmSync: (path: string): void => {
    files.delete(path);
  },
  writeFileSync: (path: string, content: string): void => {
    files.set(path, content);
  }
}));

vi.mock('../../process/process-liveness.ts', () => ({
  checkIsProcessAlive: aliveMock
}));

const PROFILE = join('/profiles', 'research');
const LOCK_PATH = join(PROFILE, PERSISTENT_PROFILE_LOCK_FILE_NAME);
const OTHER_PID = process.pid + 1;
const TS = 1_700_000_000_000;

beforeEach(() => {
  files.clear();
  aliveMock.mockReset();
});

describe('mergePersistentObsidianJson', () => {
  it('should reuse the id the registry already gives the vault and keep every other vault and key', () => {
    const existing = {
      cli: true,
      last_open: 'other',
      vaults: {
        other: { open: true, path: '/vaults/other', ts: 1 },
        research: { path: '/vaults/Research', sync: 'kept', ts: 2 }
      }
    };

    const result = mergePersistentObsidianJson({ existing, newVaultId: 'fresh', shouldAutoOpenVault: true, ts: TS, vaultPath: '/vaults/Research' });

    expect(result.vaultId).toBe('research');
    expect(result.json).toEqual({
      cli: true,
      last_open: 'research',
      updateDisabled: true,
      vaults: {
        other: { path: '/vaults/other', ts: 1 },
        research: { open: true, path: '/vaults/Research', sync: 'kept', ts: TS }
      }
    });
  });

  it('should register an unlisted vault under the new id', () => {
    const result = mergePersistentObsidianJson({ existing: undefined, newVaultId: 'fresh', shouldAutoOpenVault: true, ts: TS, vaultPath: '/v' });

    expect(result).toEqual({ json: { last_open: 'fresh', updateDisabled: true, vaults: { fresh: { open: true, path: '/v', ts: TS } } }, vaultId: 'fresh' });
  });

  it('should withhold both auto-open markers when asked to', () => {
    const existing = { last_open: 'a', vaults: { a: { open: true, path: '/v', ts: 1 }, broken: 'not an entry' } };

    const result = mergePersistentObsidianJson({ existing, newVaultId: 'fresh', shouldAutoOpenVault: false, ts: TS, vaultPath: '/v' });

    expect(result).toEqual({ json: { updateDisabled: true, vaults: { a: { path: '/v', ts: TS }, broken: 'not an entry' } }, vaultId: 'a' });
  });

  it('should read a registry whose vaults field is not an object as empty', () => {
    const result = mergePersistentObsidianJson({ existing: { vaults: [] }, newVaultId: 'fresh', shouldAutoOpenVault: false, ts: TS, vaultPath: '/v' });

    expect(result.json).toEqual({ updateDisabled: true, vaults: { fresh: { path: '/v', ts: TS } } });
  });
});

describe('acquirePersistentProfileLock', () => {
  it('should take a free profile and release it', () => {
    const release = acquirePersistentProfileLock(PROFILE);

    expect(readPersistentProfileLock(LOCK_PATH)?.pid).toBe(process.pid);
    release();
    expect(files.has(LOCK_PATH)).toBe(false);
  });

  it('should refuse a profile a live process holds', () => {
    files.set(LOCK_PATH, JSON.stringify({ pid: OTHER_PID, startedAtInMilliseconds: TS }));
    aliveMock.mockReturnValue(true);

    expect(() => acquirePersistentProfileLock(PROFILE)).toThrow(PersistentProfileInUseError);
    expect(() => acquirePersistentProfileLock(PROFILE)).toThrow(`process ${String(OTHER_PID)}`);
  });

  it('should steal a lock whose holder is gone', () => {
    files.set(LOCK_PATH, JSON.stringify({ pid: OTHER_PID, startedAtInMilliseconds: TS }));
    aliveMock.mockReturnValue(false);

    const release = acquirePersistentProfileLock(PROFILE);

    expect(readPersistentProfileLock(LOCK_PATH)?.pid).toBe(process.pid);
    release();
  });

  it('should not remove a lock another process stole on release', () => {
    const release = acquirePersistentProfileLock(PROFILE);
    files.set(LOCK_PATH, JSON.stringify({ pid: OTHER_PID, startedAtInMilliseconds: TS }));

    release();

    expect(readPersistentProfileLock(LOCK_PATH)?.pid).toBe(OTHER_PID);
  });

  it('should refuse a second holder in this same process, and release only once', () => {
    const release = acquirePersistentProfileLock(PROFILE);

    expect(() => acquirePersistentProfileLock(PROFILE)).toThrow(`process ${String(process.pid)}`);
    release();
    const second = acquirePersistentProfileLock(PROFILE);
    release();

    expect(readPersistentProfileLock(LOCK_PATH)?.pid).toBe(process.pid);
    second();
  });
});

describe('readPersistentProfileLock', () => {
  it('should read a malformed lock as absent', () => {
    files.set(LOCK_PATH, JSON.stringify({ pid: 'x' }));

    expect(readPersistentProfileLock(LOCK_PATH)).toBeNull();
  });

  it('should read a non-JSON lock as absent', () => {
    files.set(LOCK_PATH, 'nope');

    expect(readPersistentProfileLock(LOCK_PATH)).toBeNull();
  });

  it('should read a JSON null lock as absent', () => {
    files.set(LOCK_PATH, 'null');

    expect(readPersistentProfileLock(LOCK_PATH)).toBeNull();
  });
});

/* eslint-enable camelcase -- Paired with the file-level disable above. */
