import {
  describe,
  expect,
  it
} from 'vitest';

import type { AdbDevicesFailure } from './adb-devices-failure.ts';
import type { HostQueryFailure } from './host-process-query-verdict.ts';

import {
  AdbDevicesFailedError,
  buildAdbDevicesFailureMessage,
  checkIsAdbDevicesFailureTransient,
  describeAdbDevicesFailure,
  resolveAdbDevicesFailure,
  STATUS_DLL_INIT_FAILED
} from './adb-devices-failure.ts';
import { castTo } from './type-guards.ts';

const BUDGET_IN_MILLISECONDS = 5000;

function makeFailure(overrides: Partial<AdbDevicesFailure>): AdbDevicesFailure {
  return {
    elapsedInMilliseconds: 1200,
    exitCode: null,
    outcome: 'crashed',
    signal: null,
    standardError: '',
    timeoutInMilliseconds: BUDGET_IN_MILLISECONDS,
    ...overrides
  };
}

describe('resolveAdbDevicesFailure', () => {
  it('should classify a listing killed by its budget as timed out, keeping the signal', () => {
    expect(resolveAdbDevicesFailure({
      elapsedInMilliseconds: 5012,
      errorCode: null,
      isKilled: true,
      signal: 'SIGTERM',
      standardError: '',
      timeoutInMilliseconds: BUDGET_IN_MILLISECONDS
    })).toEqual({
      elapsedInMilliseconds: 5012,
      exitCode: null,
      outcome: 'timed-out',
      signal: 'SIGTERM',
      standardError: '',
      timeoutInMilliseconds: BUDGET_IN_MILLISECONDS
    });
  });

  it('should classify a silent non-zero exit as crashed, keeping the exit code', () => {
    const failure = resolveAdbDevicesFailure({
      elapsedInMilliseconds: 40,
      errorCode: STATUS_DLL_INIT_FAILED,
      isKilled: false,
      signal: undefined,
      standardError: '',
      timeoutInMilliseconds: BUDGET_IN_MILLISECONDS
    });

    expect(failure.outcome).toBe('crashed');
    expect(failure.exitCode).toBe(STATUS_DLL_INIT_FAILED);
    expect(failure.signal).toBeNull();
  });

  it('should classify a missing executable as not found, with no exit code', () => {
    const failure = resolveAdbDevicesFailure({
      elapsedInMilliseconds: 3,
      errorCode: 'ENOENT',
      isKilled: false,
      signal: null,
      standardError: '',
      timeoutInMilliseconds: BUDGET_IN_MILLISECONDS
    });

    expect(failure.outcome).toBe('not-found');
    expect(failure.exitCode).toBeNull();
  });

  it('should treat an absent error code as null', () => {
    expect(
      resolveAdbDevicesFailure({
        elapsedInMilliseconds: 3,
        errorCode: undefined,
        isKilled: false,
        signal: null,
        standardError: 'error: protocol fault',
        timeoutInMilliseconds: BUDGET_IN_MILLISECONDS
      }).outcome
    ).toBe('refused');
  });
});

describe('describeAdbDevicesFailure', () => {
  it('should name the budget and the signal for a timeout, not a missing adb', () => {
    const description = describeAdbDevicesFailure(makeFailure({ elapsedInMilliseconds: 5012, outcome: 'timed-out', signal: 'SIGTERM' }));

    expect(description).toContain('5.0s budget');
    expect(description).toContain('SIGTERM');
    expect(description).toContain('too busy');
    expect(description).not.toContain('PATH');
  });

  it('should quote what adb said before a timeout', () => {
    const description = describeAdbDevicesFailure(makeFailure({
      outcome: 'timed-out',
      standardError: '* daemon not running; starting now at tcp:5037\n'
    }));

    expect(description).toContain('adb had said: * daemon not running; starting now at tcp:5037.');
  });

  it('should leave the signal out of a timeout that carried none', () => {
    expect(describeAdbDevicesFailure(makeFailure({ outcome: 'timed-out' }))).toContain('killed after 1.2s.');
  });

  it('should name the desktop heap for STATUS_DLL_INIT_FAILED', () => {
    const description = describeAdbDevicesFailure(makeFailure({ exitCode: STATUS_DLL_INIT_FAILED }));

    expect(description).toContain('0xC0000142');
    expect(description).toContain('desktop heap');
  });

  it('should report another silent exit as a crash with its code', () => {
    expect(describeAdbDevicesFailure(makeFailure({ exitCode: 1 }))).toBe('adb died after 1.2s without explaining itself (exit 1, nothing on stderr).');
  });

  it('should quote a refusal', () => {
    expect(describeAdbDevicesFailure(makeFailure({ exitCode: 1, outcome: 'refused', standardError: 'error: protocol fault' })))
      .toBe('adb exited 1 after 1.2s: error: protocol fault.');
  });

  it('should keep the PATH question for a missing executable only', () => {
    expect(describeAdbDevicesFailure(makeFailure({ outcome: 'not-found' }))).toContain('Is ADB installed and in PATH?');
  });

  it('should name an output overrun', () => {
    expect(describeAdbDevicesFailure(makeFailure({ outcome: 'output-overran' }))).toContain('buffer');
  });

  it('should throw rather than invent a line for an outcome it does not recognize', () => {
    expect(() => describeAdbDevicesFailure(makeFailure({ outcome: castTo<HostQueryFailure>('probably-fine') }))).toThrow(
      'Unhandled value: probably-fine'
    );
  });
});

describe('buildAdbDevicesFailureMessage', () => {
  it('should open on the command that failed', () => {
    expect(buildAdbDevicesFailureMessage(makeFailure({ exitCode: 1 }))).toMatch(/^Failed to run 'adb devices': adb died/);
  });
});

describe('checkIsAdbDevicesFailureTransient', () => {
  it.each(['crashed', 'refused', 'timed-out'] as const)('should retry a %s listing', (outcome) => {
    expect(checkIsAdbDevicesFailureTransient(makeFailure({ outcome }))).toBe(true);
  });

  it.each(['not-found', 'output-overran'] as const)('should not retry a %s listing', (outcome) => {
    expect(checkIsAdbDevicesFailureTransient(makeFailure({ outcome }))).toBe(false);
  });
});

describe('AdbDevicesFailedError', () => {
  it('should carry the failure and its message', () => {
    const failure = makeFailure({ exitCode: 1 });
    const error = new AdbDevicesFailedError(failure);

    expect(error.failure).toBe(failure);
    expect(error.message).toBe(buildAdbDevicesFailureMessage(failure));
    expect(error.name).toBe('AdbDevicesFailedError');
  });
});
