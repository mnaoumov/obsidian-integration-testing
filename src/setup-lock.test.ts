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
  heartbeatAtInMilliseconds: number;
  hostname: string;
  label: string;
  pid: number;
}

const POLL_INTERVAL_IN_MILLISECONDS = 500;
const HEARTBEAT_INTERVAL_IN_MILLISECONDS = 5000;
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

const mockLog = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock('./log.ts', () => ({
  log: mockLog
}));

function lockInfoJson(overrides?: Partial<LockInfo>): string {
  return JSON.stringify({
    acquiredAtInMilliseconds: Date.now(),
    heartbeatAtInMilliseconds: Date.now(),
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

  it('steals a lock whose pid is alive but whose heartbeat is stale (recycled pid)', async () => {
    const THREE_MINUTES_IN_MILLISECONDS = 3 * 60 * 1000;
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    mockReadFileSync.mockReturnValue(
      lockInfoJson({ heartbeatAtInMilliseconds: Date.now() - THREE_MINUTES_IN_MILLISECONDS })
    );
    // The pid exists, but it was recycled by an unrelated process — the real
    // Holder died without releasing, so its heartbeat stopped.
    mockKill.mockReturnValue(undefined);

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
      lockInfoJson({
        acquiredAtInMilliseconds: Date.now() - THIRTY_ONE_MINUTES_IN_MILLISECONDS,
        heartbeatAtInMilliseconds: Date.now() - THIRTY_ONE_MINUTES_IN_MILLISECONDS,
        hostname: 'other-host'
      })
    );

    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    expect(mockRmSync).toHaveBeenCalled();
    expect(mockKill).not.toHaveBeenCalled();
    expect(lock).toHaveProperty('release');
  });

  it('keeps waiting while the holder is still beating', async () => {
    const ONE_MINUTE_IN_MILLISECONDS = 60 * 1000;
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    // Silent for a minute — well inside the threshold, so the holder is alive.
    mockReadFileSync.mockReturnValue(lockInfoJson({ heartbeatAtInMilliseconds: Date.now() - ONE_MINUTE_IN_MILLISECONDS }));
    mockKill.mockReturnValue(undefined);

    const promise = acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_IN_MILLISECONDS);
    await promise;

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('ages out a legacy lock that carries no heartbeat at all', async () => {
    const THREE_MINUTES_IN_MILLISECONDS = 3 * 60 * 1000;
    mockWriteFileSync
      .mockImplementationOnce(() => {
        throw makeErrnoError('EEXIST');
      })
      .mockImplementationOnce(() => undefined);
    // Written by an older version of the package: pid and acquire time, no heartbeat.
    mockReadFileSync.mockReturnValue(JSON.stringify({
      acquiredAtInMilliseconds: Date.now() - THREE_MINUTES_IN_MILLISECONDS,
      hostname: HOST,
      label: 'obsidian-cli',
      pid: 9999
    }));
    mockKill.mockReturnValue(undefined);

    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    expect(mockRmSync).toHaveBeenCalledWith(LOCK_PATH, { force: true });
    expect(lock).toHaveProperty('release');
  });

  it('refreshes the heartbeat while the lock is held', async () => {
    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    const acquiredInfo = JSON.parse(ensureString(mockWriteFileSync.mock.calls[0]?.[1])) as LockInfo;

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_IN_MILLISECONDS);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    const beatCall = mockWriteFileSync.mock.calls[1];
    // The refresh rewrites a file that already exists, so it must not use `wx`.
    expect(beatCall?.[2]).toBeUndefined();
    const beatInfo = JSON.parse(ensureString(beatCall?.[1])) as LockInfo;
    expect(beatInfo.heartbeatAtInMilliseconds).toBeGreaterThan(acquiredInfo.heartbeatAtInMilliseconds);
    expect(beatInfo.acquiredAtInMilliseconds).toBe(acquiredInfo.acquiredAtInMilliseconds);

    lock.release();
  });

  it('keeps beating while the lock file still names this run', async () => {
    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    mockReadFileSync.mockReturnValue(lockInfoJson({ pid: OWN_PID }));

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_IN_MILLISECONDS);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining('no longer ours'));

    lock.release();
  });

  it('stops beating when the lock file names this pid on a different host', async () => {
    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    // Same pid number, different machine — a shared temp directory makes that
    // Collision possible, and it is not our lock.
    mockReadFileSync.mockReturnValue(lockInfoJson({ hostname: 'other-host', pid: OWN_PID }));

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_IN_MILLISECONDS);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('no longer ours'));

    lock.release();
  });

  it('stops beating once another run has taken the lock over', async () => {
    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    // The lock file now names a different holder.
    mockReadFileSync.mockReturnValue(lockInfoJson());

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_IN_MILLISECONDS * 3);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('no longer ours'));

    lock.release();
  });

  it('logs a failed heartbeat refresh and keeps beating', async () => {
    mockWriteFileSync
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw makeErrnoError('EPERM');
      });
    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_IN_MILLISECONDS * 2);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Failed to refresh the setup lock heartbeat'));
    expect(mockWriteFileSync).toHaveBeenCalledTimes(3);

    lock.release();
  });

  it('does not remove a lock file that now belongs to another run', async () => {
    const lock = await acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop' });
    mockReadFileSync.mockReturnValue(lockInfoJson());

    lock.release();

    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Leaving the'));
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

  it('re-logs the wait every 30 seconds with the elapsed and remaining time', async () => {
    const TIMEOUT_IN_MILLISECONDS = 70_000;
    const SIXTY_SECONDS_IN_MILLISECONDS = 60_000;
    const ELEVEN_SECONDS_IN_MILLISECONDS = 11_000;
    mockWriteFileSync.mockImplementation(() => {
      throw makeErrnoError('EEXIST');
    });
    mockReadFileSync.mockReturnValue(lockInfoJson());
    mockKill.mockReturnValue(undefined);

    const rejection = expect(
      acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop', timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS })
    ).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(SIXTY_SECONDS_IN_MILLISECONDS);

    const waitMessages = mockLog.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes('Waiting for the'));
    expect(waitMessages).toHaveLength(3);
    expect(waitMessages[0]).toContain('waited 0s');
    expect(waitMessages[1]).toContain('waited 30s');
    expect(waitMessages[2]).toContain('waited 1m 0s');
    expect(waitMessages[2]).toContain('giving up in 10s');

    await vi.advanceTimersByTimeAsync(ELEVEN_SECONDS_IN_MILLISECONDS);
    await rejection;
  });

  it('gives up on the deadline even while it keeps stealing a lock that reappears', async () => {
    const TIMEOUT_IN_MILLISECONDS = 1000;
    mockWriteFileSync.mockImplementation(() => {
      throw makeErrnoError('EEXIST');
    });
    mockReadFileSync.mockReturnValue(lockInfoJson());
    // A dead holder, so every attempt steals — and a competing run keeps
    // Recreating the file, so the steal never lets this run in.
    mockKill.mockImplementation(() => {
      throw makeErrnoError('ESRCH');
    });
    // Stealing is not free: let the clock run while it happens.
    mockRmSync.mockImplementation(() => {
      vi.advanceTimersByTime(TIMEOUT_IN_MILLISECONDS);
    });

    await expect(
      acquireSetupLock({ label: 'obsidian-cli', scope: 'desktop', timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS })
    ).rejects.toThrow(/Timed out after 1000ms/);
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
