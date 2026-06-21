import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { acquireSetupLock } from './setup-lock.ts';

interface ErrnoError extends Error {
  code: string;
}

interface LockInfo {
  acquiredAtInMilliseconds: number;
  hostname: string;
  label: string;
  pid: number;
}

const POLL_INTERVAL_IN_MILLISECONDS = 500;
const HOST = vi.hoisted(() => 'test-host');
const OWN_PID = vi.hoisted(() => 4242);
const LOCK_DIR = join('/tmp', 'obsidian-integration-testing');
const LOCK_PATH = join(LOCK_DIR, 'desktop.setup.lock');

const mockMkdirSync = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => void>());
const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());
const mockRmSync = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => void>());
const mockWriteFileSync = vi.hoisted(() => vi.fn<(path: string, content: string, options?: unknown) => void>());

vi.mock('node:fs', () => ({
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  rmSync: mockRmSync,
  writeFileSync: mockWriteFileSync
}));

vi.mock('node:os', () => ({
  hostname: (): string => HOST,
  tmpdir: (): string => '/tmp'
}));

const mockKill = vi.hoisted(() => vi.fn<(pid: number, signal: number) => void>());

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return {
    ...actual,
    default: {
      ...actual,
      kill: mockKill,
      pid: OWN_PID
    }
  };
});

vi.mock('./log.ts', () => ({
  log: vi.fn()
}));

function lockInfoJson(overrides?: Partial<LockInfo>): string {
  return JSON.stringify({
    acquiredAtInMilliseconds: Date.now(),
    hostname: HOST,
    label: 'obsidian-cli',
    pid: 9999,
    ...overrides
  });
}

function makeErrnoError(code: string): ErrnoError {
  const error = new Error(code) as ErrnoError;
  error.code = code;
  return error;
}

describe('acquireSetupLock', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires immediately when the lock file does not exist', async () => {
    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    expect(mockMkdirSync).toHaveBeenCalledWith(LOCK_DIR, { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(LOCK_PATH, expect.any(String), { flag: 'wx' });
    expect(lock).toHaveProperty('release');
  });

  it('writes its own pid and host into the lock file', async () => {
    await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    const written = JSON.parse(ensureString(mockWriteFileSync.mock.calls[0]?.[1])) as LockInfo;
    expect(written.pid).toBe(OWN_PID);
    expect(written.hostname).toBe(HOST);
  });

  it('rethrows file-system errors that are not EEXIST', async () => {
    mockWriteFileSync.mockImplementationOnce(() => {
      throw makeErrnoError('EACCES');
    });

    await expect(acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' })).rejects.toThrow('EACCES');
  });

  it('waits for a live holder to release, then acquires', async () => {
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    mockReadFileSync.mockReturnValue(lockInfoJson());
    // The holder process is alive (kill does not throw).
    mockKill.mockReturnValue(undefined);

    const promise = acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_IN_MILLISECONDS);
    const lock = await promise;

    expect(lock).toHaveProperty('release');
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
  });

  it('treats EPERM from the liveness probe as a live holder', async () => {
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    mockReadFileSync.mockReturnValue(lockInfoJson());
    mockKill.mockImplementation(() => {
      throw makeErrnoError('EPERM');
    });

    const promise = acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_IN_MILLISECONDS);
    await promise;

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('steals a stale lock whose holder process is dead (same host)', async () => {
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    mockReadFileSync.mockReturnValue(lockInfoJson());
    mockKill.mockImplementation(() => {
      throw makeErrnoError('ESRCH');
    });

    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    expect(mockRmSync).toHaveBeenCalledWith(LOCK_PATH, { force: true });
    expect(lock).toHaveProperty('release');
  });

  it('treats a code-less liveness-probe error as a dead holder and steals the lock', async () => {
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    mockReadFileSync.mockReturnValue(lockInfoJson());
    mockKill.mockImplementation(() => {
      throw new Error('no code on this error');
    });

    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    expect(mockRmSync).toHaveBeenCalledWith(LOCK_PATH, { force: true });
    expect(lock).toHaveProperty('release');
  });

  it('steals a lock from another host once it exceeds the stale age', async () => {
    const THIRTY_ONE_MINUTES_IN_MILLISECONDS = 31 * 60 * 1000;
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    mockReadFileSync.mockReturnValue(
      lockInfoJson({ acquiredAtInMilliseconds: Date.now() - THIRTY_ONE_MINUTES_IN_MILLISECONDS, hostname: 'other-host' })
    );

    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    expect(mockRmSync).toHaveBeenCalled();
    expect(mockKill).not.toHaveBeenCalled();
    expect(lock).toHaveProperty('release');
  });

  it('waits (does not steal) for a fresh lock from another host', async () => {
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    mockReadFileSync.mockReturnValue(lockInfoJson({ hostname: 'other-host' }));

    const promise = acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_IN_MILLISECONDS);
    await promise;

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('keeps waiting when the lock file cannot be read (corrupt or mid-write)', async () => {
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    mockReadFileSync.mockImplementation(() => {
      throw makeErrnoError('ENOENT');
    });

    const promise = acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_IN_MILLISECONDS);
    await promise;

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('throws after the timeout while a live holder keeps the lock', async () => {
    const TIMEOUT_IN_MILLISECONDS = 1000;
    mockWriteFileSync.mockImplementation(() => {
      throw makeErrnoError('EEXIST');
    });
    mockReadFileSync.mockReturnValue(lockInfoJson());
    mockKill.mockReturnValue(undefined);

    const rejection = expect(
      acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop', timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS })
    ).rejects.toThrow(/Timed out after 1000ms waiting for the 'desktop' integration-test setup lock held by pid 9999/);

    await vi.advanceTimersByTimeAsync(TIMEOUT_IN_MILLISECONDS + POLL_INTERVAL_IN_MILLISECONDS);
    await rejection;
  });

  it('names the holder generically in the timeout error when the lock file is unreadable', async () => {
    const TIMEOUT_IN_MILLISECONDS = 1000;
    mockWriteFileSync.mockImplementation(() => {
      throw makeErrnoError('EEXIST');
    });
    mockReadFileSync.mockImplementation(() => {
      throw makeErrnoError('ENOENT');
    });

    const rejection = expect(
      acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop', timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS })
    ).rejects.toThrow(/held by another run/);

    await vi.advanceTimersByTimeAsync(TIMEOUT_IN_MILLISECONDS + POLL_INTERVAL_IN_MILLISECONDS);
    await rejection;
  });

  it('removes the lock file on release, and is idempotent', async () => {
    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    lock.release();
    lock.release();

    expect(mockRmSync).toHaveBeenCalledTimes(1);
    expect(mockRmSync).toHaveBeenCalledWith(LOCK_PATH, { force: true });
  });
});

function ensureString(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('Expected a string');
  }
  return value;
}
