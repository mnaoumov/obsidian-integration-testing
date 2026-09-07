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
  clearOwnedInstanceExitMarker,
  readOwnedInstanceExitMarker,
  writeOwnedInstanceExitMarker
} from './owned-instance-exit-marker.ts';

interface ErrnoError extends Error {
  code: string;
}

const PORT = 51_888;
const MARKER_DIR = join('/tmp', 'obsidian-integration-testing');
const MARKER_PATH = join(MARKER_DIR, '51888.owned-instance-exit.json');
const NOW_IN_MILLISECONDS = 1_700_000_000_000;

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

describe('writeOwnedInstanceExitMarker', () => {
  it('should stamp the marker with the exit details and the current time', () => {
    writeOwnedInstanceExitMarker({ code: 0, outputTail: 'bye', pid: 44_828, port: PORT, signal: null });

    expect(mockMkdirSync).toHaveBeenCalledWith(MARKER_DIR, { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      MARKER_PATH,
      JSON.stringify({
        code: 0,
        exitedAtInMilliseconds: NOW_IN_MILLISECONDS,
        outputTail: 'bye',
        pid: 44_828,
        port: PORT,
        signal: null
      })
    );
  });

  it('should record a spawn failure when there is one', () => {
    writeOwnedInstanceExitMarker({ code: null, outputTail: '', pid: undefined, port: PORT, signal: null, spawnError: 'ENOENT' });

    expect(mockWriteFileSync).toHaveBeenCalledWith(MARKER_PATH, expect.stringContaining('"spawnError":"ENOENT"'));
  });

  it('should log rather than throw when the marker cannot be written', () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(() => {
      writeOwnedInstanceExitMarker({ code: 0, outputTail: '', pid: 1, port: PORT, signal: null });
    }).not.toThrow();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Could not record the exit on port 51888: EACCES'));
  });

  it('should log a non-error failure', () => {
    mockWriteFileSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Deliberately not an Error: this is the `String(error)` fallback under test.
      throw 'disk full';
    });

    writeOwnedInstanceExitMarker({ code: 0, outputTail: '', pid: 1, port: PORT, signal: null });

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});

describe('readOwnedInstanceExitMarker', () => {
  it('should read back a marker written for the same port', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      code: 0,
      exitedAtInMilliseconds: NOW_IN_MILLISECONDS,
      outputTail: 'bye',
      pid: 44_828,
      port: PORT,
      signal: null,
      spawnError: 'ENOENT'
    }));

    expect(readOwnedInstanceExitMarker(PORT)).toEqual({
      code: 0,
      exitedAtInMilliseconds: NOW_IN_MILLISECONDS,
      outputTail: 'bye',
      pid: 44_828,
      port: PORT,
      signal: null,
      spawnError: 'ENOENT'
    });
    expect(mockReadFileSync).toHaveBeenCalledWith(MARKER_PATH, 'utf-8');
  });

  it('should read back a signal-terminated exit', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      code: null,
      exitedAtInMilliseconds: NOW_IN_MILLISECONDS,
      outputTail: '',
      pid: 44_828,
      port: PORT,
      signal: 'SIGKILL'
    }));

    expect(readOwnedInstanceExitMarker(PORT)?.signal).toBe('SIGKILL');
  });

  it('should return undefined when there is no marker', () => {
    mockReadFileSync.mockImplementation(() => {
      throw makeErrnoError('ENOENT');
    });

    expect(readOwnedInstanceExitMarker(PORT)).toBeUndefined();
  });

  it('should return undefined for a malformed marker', () => {
    mockReadFileSync.mockReturnValue('{ not json');

    expect(readOwnedInstanceExitMarker(PORT)).toBeUndefined();
  });

  it('should return undefined for a non-object marker', () => {
    mockReadFileSync.mockReturnValue('null');

    expect(readOwnedInstanceExitMarker(PORT)).toBeUndefined();
  });

  it('should return undefined for a marker without an exit time', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ code: 0, port: PORT, signal: null }));

    expect(readOwnedInstanceExitMarker(PORT)).toBeUndefined();
  });

  it('should return undefined for a marker describing another port', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      code: 0,
      exitedAtInMilliseconds: NOW_IN_MILLISECONDS,
      outputTail: '',
      pid: 1,
      port: 4723,
      signal: null
    }));

    expect(readOwnedInstanceExitMarker(PORT)).toBeUndefined();
  });

  it('should fall back to empty details for a marker with the wrong field types', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      code: 'nought',
      exitedAtInMilliseconds: NOW_IN_MILLISECONDS,
      outputTail: 42,
      pid: 'first',
      port: PORT,
      signal: 7,
      spawnError: 99
    }));

    expect(readOwnedInstanceExitMarker(PORT)).toEqual({
      code: null,
      exitedAtInMilliseconds: NOW_IN_MILLISECONDS,
      outputTail: '',
      pid: undefined,
      port: PORT,
      signal: null
    });
  });
});

describe('clearOwnedInstanceExitMarker', () => {
  it('should remove the marker for the port', () => {
    clearOwnedInstanceExitMarker(PORT);

    expect(mockRmSync).toHaveBeenCalledWith(MARKER_PATH, { force: true });
  });

  it('should log rather than throw when the marker cannot be removed', () => {
    mockRmSync.mockImplementation(() => {
      throw new Error('EBUSY');
    });

    expect(() => {
      clearOwnedInstanceExitMarker(PORT);
    }).not.toThrow();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Could not remove the marker for port 51888: EBUSY'));
  });

  it('should log a non-error failure', () => {
    mockRmSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Deliberately not an Error: this is the `String(error)` fallback under test.
      throw 'locked';
    });

    clearOwnedInstanceExitMarker(PORT);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('locked'));
  });
});
