import { Buffer } from 'node:buffer';
import {
  describe,
  expect,
  it
} from 'vitest';

import type {
  BuildPortOwnerQueryMessageParams,
  PortOwnerQueryOutcome,
  ResolvePortOwnerQueryOutcomeParams
} from './port-owner-query-verdict.ts';

import {
  buildPortOwnerQueryMessage,
  normalizeSyncExecError,
  resolvePortOwnerQueryOutcome
} from './port-owner-query-verdict.ts';
import { castTo } from './type-guards.ts';

const COMMAND = 'lsof -ti tcp:4723';
const CONSEQUENCE = 'Nothing is known about what still holds port 4723, so the escalation has no PID to kill — this is not the same as nothing holding it.';
const PORT = 4723;
const SUBJECT = `\`${COMMAND}\` (asking who listens on port 4723)`;

/**
 * Builds message params with the fields a case does not care about filled in.
 *
 * @param outcome - The outcome under test.
 * @param overrides - The fields the case is about.
 * @returns The params.
 */
function buildMessageParams(outcome: PortOwnerQueryOutcome, overrides: Partial<BuildPortOwnerQueryMessageParams> = {}): BuildPortOwnerQueryMessageParams {
  return {
    command: COMMAND,
    elapsedInMilliseconds: 30_012,
    exitCode: null,
    outcome,
    port: PORT,
    signal: null,
    standardError: '',
    timeoutInMilliseconds: 30_000,
    ...overrides
  };
}

/**
 * Builds outcome params with the fields a case does not care about filled in.
 *
 * @param overrides - The fields the case is about.
 * @returns The params.
 */
function buildOutcomeParams(overrides: Partial<ResolvePortOwnerQueryOutcomeParams>): ResolvePortOwnerQueryOutcomeParams {
  return {
    errorCode: null,
    hasFailed: false,
    isKilled: false,
    platform: 'linux',
    standardError: '',
    standardOutput: '',
    ...overrides
  };
}

describe('resolvePortOwnerQueryOutcome', () => {
  it('should report a clean call as answered, owners or not', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ standardOutput: '41928\n' }))).toBe('answered');
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ platform: 'win32' }))).toBe('answered');
  });

  // The case the old comment was right about: `lsof`'s own way of saying nothing holds the port.
  it('should report lsof\'s silent exit 1 as answered', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ errorCode: 1, hasFailed: true }))).toBe('answered');
  });

  // On Windows the query is `netstat -ano`, which has no "found nothing" exit — a silent non-zero exit is a crash there.
  it('should report a silent exit 1 on Windows as crashed', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ errorCode: 1, hasFailed: true, platform: 'win32' }))).toBe('crashed');
  });

  it('should not read a silent exit 1 that left output behind as nothing found', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ errorCode: 1, hasFailed: true, standardOutput: '41928\n' }))).toBe('crashed');
  });

  it('should report an exit 1 that explained itself on stderr as refused', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ errorCode: 1, hasFailed: true, standardError: 'lsof: status error on tcp:x' }))).toBe('refused');
  });

  it('should report a silent exit other than 1 as crashed', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ errorCode: 139, hasFailed: true }))).toBe('crashed');
  });

  // The failure the empty list used to hide: a contended host outrunning the budget is not "nothing holds the port".
  it('should report a killed call as timed-out, even one that exited silently with 1', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ errorCode: 1, hasFailed: true, isKilled: true }))).toBe('timed-out');
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ hasFailed: true, isKilled: true, platform: 'win32' }))).toBe('timed-out');
  });

  it('should report a missing executable as not-found', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ errorCode: 'ENOENT', hasFailed: true }))).toBe('not-found');
  });

  it('should report an overrun buffer as output-overran', () => {
    expect(resolvePortOwnerQueryOutcome(buildOutcomeParams({ errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', hasFailed: true, platform: 'win32' }))).toBe('output-overran');
  });
});

describe('buildPortOwnerQueryMessage', () => {
  it('should say nothing for an answered query', () => {
    expect(buildPortOwnerQueryMessage(buildMessageParams('answered'))).toBeUndefined();
  });

  it('should name the budget and the signal for a timeout, and say what it costs', () => {
    expect(buildPortOwnerQueryMessage(buildMessageParams('timed-out', { signal: 'SIGTERM' }))).toBe(
      `Warning: ${SUBJECT} did not finish within its 30.0s budget and was killed after 30.0s (SIGTERM). ${CONSEQUENCE}`
    );
  });

  it('should omit the signal from a timeout that was not reported with one', () => {
    expect(buildPortOwnerQueryMessage(buildMessageParams('timed-out', { elapsedInMilliseconds: 5003, timeoutInMilliseconds: 5000 }))).toBe(
      `Warning: ${SUBJECT} did not finish within its 5.0s budget and was killed after 5.0s. ${CONSEQUENCE}`
    );
  });

  it('should render an NTSTATUS exit code in hex for a crash', () => {
    expect(buildPortOwnerQueryMessage(buildMessageParams('crashed', { elapsedInMilliseconds: 412, exitCode: 0xC0_00_00_05 }))).toBe(
      `Warning: ${SUBJECT} died after 412ms without explaining itself (exit 0xC0000005, nothing on stderr). Suspect a crash or an interfering security product, and try the command by hand. ${CONSEQUENCE}`
    );
  });

  it('should quote what the command said when it refused', () => {
    expect(buildPortOwnerQueryMessage(buildMessageParams('refused', { elapsedInMilliseconds: 80, exitCode: 1, standardError: 'lsof: unacceptable port\n' }))).toBe(
      `Warning: ${SUBJECT} refused the request after 80ms (exit 1): lsof: unacceptable port. ${CONSEQUENCE}`
    );
  });

  it('should say the executable was missing', () => {
    expect(buildPortOwnerQueryMessage(buildMessageParams('not-found', { elapsedInMilliseconds: 3 }))).toBe(
      `Warning: ${SUBJECT} could not be run at all after 3ms: the executable was not found on PATH. ${CONSEQUENCE}`
    );
  });

  it('should point at the buffer when the output overran it', () => {
    expect(buildPortOwnerQueryMessage(buildMessageParams('output-overran', { elapsedInMilliseconds: 1500 }))).toBe(
      `Warning: ${SUBJECT} produced more output after 1.5s than the query's buffer allows, so none of it could be read. Raise the buffer. ${CONSEQUENCE}`
    );
  });

  it('should throw rather than invent a line for an outcome it does not recognize', () => {
    expect(() => buildPortOwnerQueryMessage(buildMessageParams(castTo<PortOwnerQueryOutcome>('probably-fine')))).toThrow('Unhandled value: probably-fine');
  });
});

describe('normalizeSyncExecError', () => {
  // The sync API names an expired budget with a code rather than `killed`; the classifier must still see a timeout.
  it('should read ETIMEDOUT as a kill, with no error code of its own', () => {
    expect(normalizeSyncExecError({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stderr: '', stdout: '' })).toEqual({
      errorCode: null,
      exitCode: null,
      isKilled: true,
      signal: 'SIGTERM',
      standardError: '',
      standardOutput: ''
    });
  });

  it('should translate ENOBUFS into the async API\'s buffer code', () => {
    expect(normalizeSyncExecError({ code: 'ENOBUFS', status: null }).errorCode).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });

  it('should keep a spawn error code such as ENOENT', () => {
    expect(normalizeSyncExecError({ code: 'ENOENT' }).errorCode).toBe('ENOENT');
  });

  it('should read the exit code from status, and buffered streams as text', () => {
    expect(normalizeSyncExecError({ status: 1, stderr: Buffer.from('lsof: bad\n'), stdout: Buffer.from('') })).toEqual({
      errorCode: 1,
      exitCode: 1,
      isKilled: false,
      signal: null,
      standardError: 'lsof: bad\n',
      standardOutput: ''
    });
  });

  it('should read an unrecognizable throw as a failure with no evidence', () => {
    expect(normalizeSyncExecError('boom')).toEqual({
      errorCode: null,
      exitCode: null,
      isKilled: false,
      signal: null,
      standardError: '',
      standardOutput: ''
    });
  });

  // End to end through the verdict: the sync lsof "nothing holds the port" must still read as an answer.
  it('should let a normalized lsof silent exit 1 resolve as answered', () => {
    expect(resolvePortOwnerQueryOutcome({ ...normalizeSyncExecError({ status: 1, stderr: '', stdout: '' }), hasFailed: true, platform: 'darwin' })).toBe('answered');
  });
});
