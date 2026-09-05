import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  checkIsHarnessOwnedAppiumServer,
  clearAppiumServerMarker,
  readAppiumServerMarker,
  recordAppiumServerStopAttempt,
  writeAppiumServerMarker
} from './appium-server-marker.ts';

interface ErrnoError extends Error {
  code: string;
}

const PORT = 4723;
const MARKER_DIR = join('/tmp', 'obsidian-integration-testing');
const MARKER_PATH = join(MARKER_DIR, '4723.appium-server.json');
const NOW_IN_MILLISECONDS = 1_700_000_000_000;
const EARLIER_IN_MILLISECONDS = 1_699_999_000_000;

const mockMkdirSync = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => void>());
const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());
const mockRmSync = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => void>());
const mockWriteFileSync = vi.hoisted(() => vi.fn<(path: string, content: string) => void>());

vi.mock('node:fs', () => ({
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  rmSync: mockRmSync,
  writeFileSync: mockWriteFileSync
}));

vi.mock('node:os', () => ({
  tmpdir: (): string => '/tmp'
}));

const mockKill = vi.hoisted(() => vi.fn<(pid: number, signal: number) => void>());

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return {
    ...actual,
    default: {
      ...actual,
      kill: mockKill
    }
  };
});

const mockLog = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock('./log.ts', () => ({
  log: mockLog
}));

function makeErrnoError(code: string): ErrnoError {
  const error = new Error(code) as ErrnoError;
  error.code = code;
  return error;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_IN_MILLISECONDS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('writeAppiumServerMarker', () => {
  it('should stamp the marker with the PID, port and start time', () => {
    writeAppiumServerMarker({ pid: 12_345, port: PORT });

    expect(mockMkdirSync).toHaveBeenCalledWith(MARKER_DIR, { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      MARKER_PATH,
      JSON.stringify({ pid: 12_345, port: PORT, startedAtInMilliseconds: NOW_IN_MILLISECONDS })
    );
  });

  it('should log rather than throw when the marker cannot be written', () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(() => {
      writeAppiumServerMarker({ pid: 12_345, port: PORT });
    }).not.toThrow();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Could not record the server on port 4723: EACCES'));
  });

  it('should log a non-error failure', () => {
    mockWriteFileSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Deliberately not an Error: this is the `String(error)` fallback under test.
      throw 'disk full';
    });

    writeAppiumServerMarker({ pid: 12_345, port: PORT });

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});

describe('readAppiumServerMarker', () => {
  it('should read back a marker written for the same port', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ pid: 12_345, port: PORT, startedAtInMilliseconds: NOW_IN_MILLISECONDS }));

    expect(readAppiumServerMarker(PORT)).toEqual({ pid: 12_345, port: PORT, startedAtInMilliseconds: NOW_IN_MILLISECONDS });
    expect(mockReadFileSync).toHaveBeenCalledWith(MARKER_PATH, 'utf-8');
  });

  it('should return undefined when there is no marker', () => {
    mockReadFileSync.mockImplementation(() => {
      throw makeErrnoError('ENOENT');
    });

    expect(readAppiumServerMarker(PORT)).toBeUndefined();
  });

  it('should return undefined for a malformed marker', () => {
    mockReadFileSync.mockReturnValue('{ not json');

    expect(readAppiumServerMarker(PORT)).toBeUndefined();
  });

  it('should return undefined for a non-object marker', () => {
    mockReadFileSync.mockReturnValue('null');

    expect(readAppiumServerMarker(PORT)).toBeUndefined();
  });

  it('should return undefined when the marker describes another port', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ pid: 12_345, port: 4724, startedAtInMilliseconds: NOW_IN_MILLISECONDS }));

    expect(readAppiumServerMarker(PORT)).toBeUndefined();
  });

  it('should return undefined when a field has the wrong type', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ pid: 'nope', port: PORT, startedAtInMilliseconds: NOW_IN_MILLISECONDS }));
    expect(readAppiumServerMarker(PORT)).toBeUndefined();

    mockReadFileSync.mockReturnValue(JSON.stringify({ pid: 12_345, port: PORT, startedAtInMilliseconds: 'nope' }));
    expect(readAppiumServerMarker(PORT)).toBeUndefined();
  });

  it('should carry a recorded stop attempt through', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 12_345, port: PORT, startedAtInMilliseconds: EARLIER_IN_MILLISECONDS, stopAttemptedAtInMilliseconds: NOW_IN_MILLISECONDS })
    );

    expect(readAppiumServerMarker(PORT)).toEqual({
      pid: 12_345,
      port: PORT,
      startedAtInMilliseconds: EARLIER_IN_MILLISECONDS,
      stopAttemptedAtInMilliseconds: NOW_IN_MILLISECONDS
    });
  });

  it('should ignore a stop-attempt stamp of the wrong type', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 12_345, port: PORT, startedAtInMilliseconds: NOW_IN_MILLISECONDS, stopAttemptedAtInMilliseconds: 'nope' })
    );

    expect(readAppiumServerMarker(PORT)).toEqual({ pid: 12_345, port: PORT, startedAtInMilliseconds: NOW_IN_MILLISECONDS });
  });
});

/*
 * A server the harness tried and failed to stop must stay convictable. Clearing
 * the marker instead makes the leftover read as a foreign, user-managed server
 * to the next run — one it is not allowed to touch — which is precisely the
 * server it is most entitled to kill.
 */
describe('recordAppiumServerStopAttempt', () => {
  it('should stamp the existing marker with the failed stop, keeping its identity', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ pid: 12_345, port: PORT, startedAtInMilliseconds: EARLIER_IN_MILLISECONDS }));

    recordAppiumServerStopAttempt(PORT);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      MARKER_PATH,
      JSON.stringify({ pid: 12_345, port: PORT, startedAtInMilliseconds: EARLIER_IN_MILLISECONDS, stopAttemptedAtInMilliseconds: NOW_IN_MILLISECONDS })
    );
  });

  it('should do nothing when there is no marker to stamp', () => {
    mockReadFileSync.mockImplementation(() => {
      throw makeErrnoError('ENOENT');
    });

    recordAppiumServerStopAttempt(PORT);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('clearAppiumServerMarker', () => {
  it('should remove the marker file', () => {
    clearAppiumServerMarker(PORT);

    expect(mockRmSync).toHaveBeenCalledWith(MARKER_PATH, { force: true });
  });

  it('should log rather than throw when the marker cannot be removed', () => {
    mockRmSync.mockImplementation(() => {
      throw new Error('EBUSY');
    });

    expect(() => {
      clearAppiumServerMarker(PORT);
    }).not.toThrow();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Could not remove the marker for port 4723: EBUSY'));
  });
});

describe('checkIsHarnessOwnedAppiumServer', () => {
  const marker = { pid: 12_345, port: PORT, startedAtInMilliseconds: NOW_IN_MILLISECONDS };

  it('should be false without a marker', () => {
    expect(checkIsHarnessOwnedAppiumServer(undefined)).toBe(false);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('should be true when the marked process is alive', () => {
    expect(checkIsHarnessOwnedAppiumServer(marker)).toBe(true);
    expect(mockKill).toHaveBeenCalledWith(12_345, 0);
  });

  it('should be true when the marked process belongs to another user', () => {
    mockKill.mockImplementation(() => {
      throw makeErrnoError('EPERM');
    });

    expect(checkIsHarnessOwnedAppiumServer(marker)).toBe(true);
  });

  it('should be false when the marked process is gone', () => {
    mockKill.mockImplementation(() => {
      throw makeErrnoError('ESRCH');
    });

    expect(checkIsHarnessOwnedAppiumServer(marker)).toBe(false);
  });

  it('should be false when the probe fails without an errno code', () => {
    mockKill.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(checkIsHarnessOwnedAppiumServer(marker)).toBe(false);
  });
});
