/**
 * @file
 *
 * Pure classification of a failed `adb devices` — which way it failed, whether
 * a retry can help, and one line that says so.
 *
 * Two Android release pre-flight runs failed in a row on 2026-10-22 with nothing but
 *
 * ```text
 * Error: Failed to run 'adb devices': Command failed: adb devices
 * . Is ADB installed and in PATH?
 * ```
 *
 * ADB was installed, the emulator had registered as `emulator-5554`, and both
 * re-runs passed 40 minutes later. The line kept `error.message`, which for
 * `execFile` is `Command failed: <cmd>\n<stderr>`, and threw away what tells the
 * failures apart: `error.killed` (the 5s budget ran out), `error.code` (an exit
 * code — on Windows an `NTSTATUS` such as `0xC0000142` when the child could not
 * even initialize), the signal and the elapsed time. Each of those needs a
 * different fix, and the closing question names the one cause it could not be.
 *
 * The failure kinds are the host-query ones (`host-process-query-verdict.ts`),
 * shared so `crashed`, `timed-out` and `refused` mean one thing everywhere.
 */

import type { HostQueryFailure } from './host-process-query-verdict.ts';

import {
  formatDuration,
  formatExitCode,
  formatRefusal,
  resolveHostQueryFailure
} from './host-process-query-verdict.ts';
import { assertNever } from './type-guards.ts';

/**
 * `STATUS_DLL_INIT_FAILED`, the exit code of a Windows process whose DLLs could not initialize.
 *
 * It is what a process gets when the desktop heap is exhausted, which a host
 * starting many processes at once reaches for a while and then leaves again.
 */
export const STATUS_DLL_INIT_FAILED = 0xC0_00_01_42;

/**
 * How a failed `adb devices` failed, with the evidence a reader needs.
 */
export interface AdbDevicesFailure {
  /**
  How long the call took before it ended, in milliseconds.
   */
  readonly elapsedInMilliseconds: number;

  /**
  The child's exit code, when it exited.
   */
  readonly exitCode: null | number;

  /**
  Which way it failed.
   */
  readonly outcome: HostQueryFailure;

  /**
  The signal the child was killed with, when it was killed.
   */
  readonly signal: null | string;

  /**
  Whatever adb wrote to stderr.
   */
  readonly standardError: string;

  /**
  The budget the call was given, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * Parameters for {@link resolveAdbDevicesFailure}.
 */
export interface ResolveAdbDevicesFailureParams {
  /**
  How long the call took, in milliseconds.
   */
  readonly elapsedInMilliseconds: number;

  /**
  `execFile`'s `error.code`: the numeric exit code, or a string like `ENOENT` when the child never ran.
   */
  readonly errorCode: null | number | string | undefined;

  /**
  `execFile`'s `error.killed`.
   */
  readonly isKilled: boolean;

  /**
  `execFile`'s `error.signal`.
   */
  readonly signal: null | string | undefined;

  /**
  Whatever adb wrote to stderr.
   */
  readonly standardError: string;

  /**
  The budget the call was given, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * A failed `adb devices`, carrying its classification.
 */
export class AdbDevicesFailedError extends Error {
  /**
   * Creates the error.
   *
   * @param failure - The classified failure.
   */
  public constructor(public readonly failure: AdbDevicesFailure) {
    super(buildAdbDevicesFailureMessage(failure));
    this.name = 'AdbDevicesFailedError';
  }
}

/**
 * Builds the error message for a failed `adb devices`.
 *
 * @param failure - The classified failure.
 * @returns The message, opening on `Failed to run 'adb devices'` as it always did.
 */
export function buildAdbDevicesFailureMessage(failure: AdbDevicesFailure): string {
  return `Failed to run 'adb devices': ${describeAdbDevicesFailure(failure)}`;
}

/**
 * Checks whether running `adb devices` again could succeed.
 *
 * A missing executable and an oversized output fail the same way every time;
 * everything else depends on the state of the host or the adb server.
 *
 * @param failure - The classified failure.
 * @returns `true` when a retry is worth making.
 */
export function checkIsAdbDevicesFailureTransient(failure: AdbDevicesFailure): boolean {
  return failure.outcome !== 'not-found' && failure.outcome !== 'output-overran';
}

/**
 * Describes a failed `adb devices` in one clause.
 *
 * @param failure - The classified failure.
 * @returns The description, naming the evidence for its verdict.
 */
export function describeAdbDevicesFailure(failure: AdbDevicesFailure): string {
  const cost = `after ${formatDuration(failure.elapsedInMilliseconds)}`;

  switch (failure.outcome) {
    case 'crashed': {
      return failure.exitCode === STATUS_DLL_INIT_FAILED
        ? `adb could not start ${cost} (exit ${formatExitCode(failure.exitCode)}, STATUS_DLL_INIT_FAILED). `
          + 'On Windows that is the desktop heap running out while the host starts many processes at once; it is the host, not adb, and it passes once the load does.'
        : `adb died ${cost} without explaining itself (exit ${formatExitCode(failure.exitCode)}, nothing on stderr).`;
    }
    case 'not-found': {
      return `the \`adb\` executable was not found ${cost}. Is ADB installed and in PATH?`;
    }
    case 'output-overran': {
      return `the listing produced more output ${cost} than its buffer allows.`;
    }
    case 'refused': {
      return `adb exited ${formatExitCode(failure.exitCode)} ${cost}: ${formatRefusal(failure.standardError)}`;
    }
    case 'timed-out': {
      const signal = failure.signal === null ? '' : `, ${failure.signal}`;
      const standardError = failure.standardError.trim() === '' ? '' : ` adb had said: ${formatRefusal(failure.standardError)}`;
      return `no answer within its ${formatDuration(failure.timeoutInMilliseconds)} budget, so it was killed ${cost}${signal}. `
        + `The adb server, or the host under it, was too busy to answer a listing.${standardError}`;
    }
    default: {
      return assertNever(failure.outcome);
    }
  }
}

/**
 * Classifies a failed `adb devices`.
 *
 * @param params - What `execFile` reported, plus the timing.
 * @returns The classified failure.
 */
export function resolveAdbDevicesFailure(params: ResolveAdbDevicesFailureParams): AdbDevicesFailure {
  const errorCode = params.errorCode ?? null;

  return {
    elapsedInMilliseconds: params.elapsedInMilliseconds,
    exitCode: typeof errorCode === 'number' ? errorCode : null,
    outcome: resolveHostQueryFailure({ errorCode, isKilled: params.isKilled, standardError: params.standardError }),
    signal: params.signal ?? null,
    standardError: params.standardError,
    timeoutInMilliseconds: params.timeoutInMilliseconds
  };
}
