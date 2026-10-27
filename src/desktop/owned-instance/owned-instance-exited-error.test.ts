import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { OwnedInstanceExitMarker } from './owned-instance-exit-marker.ts';

import {
  buildOwnedInstanceExitedErrorFromMarker,
  OwnedInstanceExitedError
} from './owned-instance-exited-error.ts';

const CDP_URL = 'http://127.0.0.1:51888';
const NOW_IN_MILLISECONDS = 1_700_000_000_000;
const EXITED_AT_IN_MILLISECONDS = NOW_IN_MILLISECONDS - 42_000;

function makeMarker(overrides?: Partial<OwnedInstanceExitMarker>): OwnedInstanceExitMarker {
  return {
    code: 0,
    exitedAtInMilliseconds: EXITED_AT_IN_MILLISECONDS,
    outputTail: '',
    pid: 44_828,
    port: 51_888,
    signal: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_IN_MILLISECONDS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OwnedInstanceExitedError', () => {
  it('should name the instance, its exit code and when it died', () => {
    const error = new OwnedInstanceExitedError({
      cdpUrl: CDP_URL,
      code: 0,
      exitedAtInMilliseconds: EXITED_AT_IN_MILLISECONDS,
      pid: 44_828,
      signal: null
    });

    expect(error.name).toBe('OwnedInstanceExitedError');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`The harness-owned Obsidian instance at ${CDP_URL} is gone`);
    expect(error.message).toContain('its process (pid 44828) exited with code 0 42s ago, at 2023-11-14T22:12:38.000Z');
    expect(error.message).toContain('these failures are not test results');
  });

  it('should expose the exit details as fields for callers that match on them', () => {
    const error = new OwnedInstanceExitedError({
      cdpUrl: CDP_URL,
      code: null,
      exitedAtInMilliseconds: EXITED_AT_IN_MILLISECONDS,
      signal: 'SIGKILL'
    });

    expect(error.cdpUrl).toBe(CDP_URL);
    expect(error.code).toBeNull();
    expect(error.exitedAtInMilliseconds).toBe(EXITED_AT_IN_MILLISECONDS);
    expect(error.signal).toBe('SIGKILL');
  });

  it('should report a terminating signal instead of a code', () => {
    const error = new OwnedInstanceExitedError({ cdpUrl: CDP_URL, code: null, signal: 'SIGKILL' });

    expect(error.message).toContain('it was terminated by signal SIGKILL');
  });

  it('should report a spawn failure as never having started', () => {
    const error = new OwnedInstanceExitedError({ cdpUrl: CDP_URL, spawnError: 'ENOENT' });

    expect(error.message).toContain('it failed to start (ENOENT)');
  });

  it('should say an exit code was absent when the process left neither code nor signal', () => {
    const error = new OwnedInstanceExitedError({ cdpUrl: CDP_URL, code: null, signal: null });

    expect(error.message).toContain('it exited with no exit code');
  });

  it('should still name the instance when nothing about the death is known', () => {
    const error = new OwnedInstanceExitedError({ cdpUrl: CDP_URL });

    expect(error.message).toContain('it exited at some point during this run, and the harness recorded nothing about how');
    expect(error.message).not.toContain('Obsidian output');
  });

  it('should append the captured output tail when there is one', () => {
    const error = new OwnedInstanceExitedError({ cdpUrl: CDP_URL, code: 133, outputTail: '  FATAL: out of memory\n  ' });

    expect(error.message).toContain('Obsidian output (tail):\nFATAL: out of memory');
  });

  it('should omit the output section when nothing was captured', () => {
    const error = new OwnedInstanceExitedError({ cdpUrl: CDP_URL, code: 0, outputTail: ' '.repeat(3) });

    expect(error.message).not.toContain('Obsidian output');
  });

  it('should never report a negative age when the clock moves backwards', () => {
    const error = new OwnedInstanceExitedError({ cdpUrl: CDP_URL, code: 0, exitedAtInMilliseconds: NOW_IN_MILLISECONDS + 5000 });

    expect(error.message).toContain('0s ago');
  });
});

describe('buildOwnedInstanceExitedErrorFromMarker', () => {
  it('should carry every detail the marker preserved', () => {
    const error = buildOwnedInstanceExitedErrorFromMarker(CDP_URL, makeMarker({ outputTail: 'FATAL: boom' }));

    expect(error.code).toBe(0);
    expect(error.exitedAtInMilliseconds).toBe(EXITED_AT_IN_MILLISECONDS);
    expect(error.message).toContain('its process (pid 44828) exited with code 0 42s ago');
    expect(error.message).toContain('Obsidian output (tail):\nFATAL: boom');
  });

  it('should carry a marked spawn failure', () => {
    const error = buildOwnedInstanceExitedErrorFromMarker(CDP_URL, makeMarker({ code: null, spawnError: 'ENOENT' }));

    expect(error.message).toContain('it failed to start (ENOENT)');
  });

  it('should build an error naming only the instance when there is no marker', () => {
    const error = buildOwnedInstanceExitedErrorFromMarker(CDP_URL, undefined);

    expect(error).toBeInstanceOf(OwnedInstanceExitedError);
    expect(error.message).toContain(CDP_URL);
    expect(error.code).toBeUndefined();
  });
});
