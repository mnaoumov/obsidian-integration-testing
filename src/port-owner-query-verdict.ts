/**
 * @file
 *
 * Pure classification of the port-owner query — `netstat -ano` on Windows,
 * `lsof -ti tcp:<port>` elsewhere — deciding, from how it ended, whether it
 * **answered** or **failed**, and saying which failure in one line.
 *
 * The query is the only real escalation the Appium teardown has: the PID the
 * harness holds is the `shell: true` wrapper it spawned, so what survives a kill
 * is found by asking who still listens on the port (**L46**). It used to resolve
 * an empty list for every error, which made three different endings one silent
 * value:
 *
 * - `lsof` exiting 1 with nothing on either stream — which is how it says
 *   nothing holds the port*, a legitimate empty answer;
 * - the budget running out on a contended host;
 * - the child dying.
 *
 * Only the first is an answer. The other two disarm the escalation exactly the
 * way a silently failed process listing disarmed the emulator's
 * (`host-process-query-verdict.ts`), so they are classified by the same rules
 * and reported, not swallowed.
 *
 * **Why a module of its own rather than an option on the process-listing
 * verdict.** The two queries disagree in two places, not one. Zero owners is a
 * legitimate answer here, so `zero-rows` never applies; and `lsof`'s silent exit
 * 1 means *nothing listens*, where for `tasklist` a silent non-zero exit is a
 * crash. The failure branches themselves are delegated to
 * {@link resolveHostQueryFailure}, so there is still one definition of
 * `crashed`, `timed-out` and `refused`.
 */

import { Buffer } from 'node:buffer';

import type { HostQueryFailure } from './host-process-query-verdict.ts';

import {
  formatDuration,
  formatExitCode,
  formatRefusal,
  resolveHostQueryFailure
} from './host-process-query-verdict.ts';
import { assertNever } from './type-guards.ts';

/**
 * The exit code `lsof` uses for "found nothing", which it reports on neither stream.
 */
const LSOF_NOTHING_FOUND_EXIT_CODE = 1;

/**
 * Parameters for {@link buildPortOwnerQueryMessage}.
 */
export interface BuildPortOwnerQueryMessageParams {
  /**
  The command that was run, for the reader to try by hand — e.g. `netstat -ano`.
   */
  readonly command: string;

  /**
  How long the call took before it ended, in milliseconds.
   */
  readonly elapsedInMilliseconds: number;

  /**
  The child's exit code, when it exited rather than failing to start or being killed.
   */
  readonly exitCode: null | number;

  /**
  The verdict from {@link resolvePortOwnerQueryOutcome}.
   */
  readonly outcome: PortOwnerQueryOutcome;

  /**
  The port whose owners were asked for.
   */
  readonly port: number;

  /**
  The signal the child was killed with, when it was killed.
   */
  readonly signal: null | string;

  /**
  Whatever the child wrote to stderr.
   */
  readonly standardError: string;

  /**
  The budget the call was given, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * The fields {@link normalizeSyncExecError} extracts from an `execFileSync` throw.
 */
export interface NormalizedSyncExecError {
  /**
  The error code in `execFile`'s vocabulary: the numeric exit code, or a string such as `ENOENT` or `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
   */
  readonly errorCode: null | number | string;

  /**
  The child's exit code, when it exited.
   */
  readonly exitCode: null | number;

  /**
  Whether the budget expired and the child was killed.
   */
  readonly isKilled: boolean;

  /**
  The signal the child was killed with.
   */
  readonly signal: null | string;

  /**
  Whatever the child wrote to stderr.
   */
  readonly standardError: string;

  /**
  Whatever the child wrote to stdout before it ended.
   */
  readonly standardOutput: string;
}

/**
 * How the port-owner query ended.
 *
 * `answered` covers both a listener found and none found — the query succeeded
 * either way. The rest are {@link resolveHostQueryFailure}'s failures.
 */
export type PortOwnerQueryOutcome = 'answered' | HostQueryFailure;

/**
 * Parameters for {@link resolvePortOwnerQueryOutcome}.
 */
export interface ResolvePortOwnerQueryOutcomeParams {
  /**
  `execFile`'s `error.code`: the numeric exit code, or a string like `ENOENT` when the child never ran.
   */
  readonly errorCode: null | number | string;

  /**
  Whether `execFile` reported an error at all.
   */
  readonly hasFailed: boolean;

  /**
  `execFile`'s `error.killed`: whether the budget expired and the child was killed.
   */
  readonly isKilled: boolean;

  /**
  The host platform, which decides whether a silent exit 1 is `lsof` saying *nothing listens*.
   */
  readonly platform: NodeJS.Platform;

  /**
  Whatever the child wrote to stderr.
   */
  readonly standardError: string;

  /**
  Whatever the child wrote to stdout.
   */
  readonly standardOutput: string;
}

/**
 * Builds the single line the query logs for an outcome.
 *
 * @param params - The outcome plus the command, the port, the budget and what the child left behind.
 * @returns The warning to log, or `undefined` when the query answered.
 */
export function buildPortOwnerQueryMessage(params: BuildPortOwnerQueryMessageParams): string | undefined {
  const cost = `after ${formatDuration(params.elapsedInMilliseconds)}`;
  const subject = `\`${params.command}\` (asking who listens on port ${String(params.port)})`;
  const consequence = `Nothing is known about what still holds port ${String(params.port)}, so the escalation has no PID to kill — this is not the same as nothing holding it.`;

  switch (params.outcome) {
    case 'answered': {
      return undefined;
    }
    case 'crashed': {
      return `Warning: ${subject} died ${cost} without explaining itself (exit ${formatExitCode(params.exitCode)}, nothing on stderr). Suspect a crash or an interfering security product, and try the command by hand. ${consequence}`;
    }
    case 'not-found': {
      return `Warning: ${subject} could not be run at all ${cost}: the executable was not found on PATH. ${consequence}`;
    }
    case 'output-overran': {
      return `Warning: ${subject} produced more output ${cost} than the query's buffer allows, so none of it could be read. Raise the buffer. ${consequence}`;
    }
    case 'refused': {
      return `Warning: ${subject} refused the request ${cost} (exit ${formatExitCode(params.exitCode)}): ${formatRefusal(params.standardError)} ${consequence}`;
    }
    case 'timed-out': {
      return `Warning: ${subject} did not finish within its ${formatDuration(params.timeoutInMilliseconds)} budget and was killed ${cost}${params.signal === null ? '' : ` (${params.signal})`}. ${consequence}`;
    }
    default: {
      return assertNever(params.outcome);
    }
  }
}

/**
 * Extracts what an `execFileSync` throw carries, in `execFile`'s vocabulary.
 *
 * The synchronous API reports the same endings with different fields: an
 * expired budget is `code: 'ETIMEDOUT'` rather than `killed: true`, an overrun
 * buffer is `ENOBUFS`, and the exit code is `status` rather than `code`.
 * Normalizing here lets the sync teardown classify with the same verdict as the
 * async one.
 *
 * @param error - Whatever `execFileSync` threw.
 * @returns The normalized fields; an unrecognizable throw reads as a crash with no evidence.
 */
export function normalizeSyncExecError(error: unknown): NormalizedSyncExecError {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const code = typeof record['code'] === 'string' ? record['code'] : undefined;
  const status = typeof record['status'] === 'number' ? record['status'] : null;
  const signal = typeof record['signal'] === 'string' ? record['signal'] : null;
  const isKilled = code === 'ETIMEDOUT';

  let errorCode: null | number | string = status;
  if (code === 'ENOBUFS') {
    errorCode = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  } else if (code !== undefined && !isKilled) {
    errorCode = code;
  }

  return {
    errorCode,
    exitCode: status,
    isKilled,
    signal,
    standardError: toText(record['stderr']),
    standardOutput: toText(record['stdout'])
  };
}

/**
 * Decides how the port-owner query ended.
 *
 * @param params - What `execFile` reported, and the platform it ran on.
 * @returns The outcome.
 */
export function resolvePortOwnerQueryOutcome(params: ResolvePortOwnerQueryOutcomeParams): PortOwnerQueryOutcome {
  return !params.hasFailed || (params.platform !== 'win32'
      && !params.isKilled
      && params.errorCode === LSOF_NOTHING_FOUND_EXIT_CODE
      && params.standardError.trim() === ''
      && params.standardOutput.trim() === '')
    ? 'answered'
    : resolveHostQueryFailure(params);
}

/**
 * Reads a child's captured stream, whichever form `execFileSync` left it in.
 *
 * @param stream - A string, a `Buffer`, or nothing.
 * @returns The text, or an empty string.
 */
function toText(stream: unknown): string {
  if (typeof stream === 'string') {
    return stream;
  }

  return Buffer.isBuffer(stream) ? stream.toString('utf-8') : '';
}
