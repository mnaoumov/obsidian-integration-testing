import {
  describe,
  expect,
  it
} from 'vitest';

import type {
  BuildHostProcessQueryMessageParams,
  HostProcessQueryOutcome
} from './host-process-query-verdict.ts';

import {
  buildHostProcessQueryMessage,
  resolveHostProcessQueryOutcome
} from './host-process-query-verdict.ts';
import { castTo } from './type-guards.ts';

const COMMAND = 'tasklist /FO CSV /NH';
const CONSEQUENCE = 'Teardown falls back to `adb devices` alone and has no PID to escalate to.';
const TIMEOUT_IN_MILLISECONDS = 30_000;

/**
 * The fields a case is about, over {@link buildParams}' defaults.
 */
interface BuildParamsOptions {
  /**
  How long the call took.
   */
  readonly elapsedInMilliseconds?: number | undefined;

  /**
  The child's exit code.
   */
  readonly exitCode?: null | number | undefined;

  /**
  How many rows the output parsed to.
   */
  readonly partialRowCount?: number | undefined;

  /**
  The signal the child was killed with.
   */
  readonly signal?: null | string | undefined;

  /**
  Whatever the child wrote to stderr.
   */
  readonly standardError?: string | undefined;
}

/**
 * Builds message params with the fields a case does not care about filled in.
 *
 * @param outcome - The outcome under test.
 * @param options - The fields the case is about.
 * @returns The params.
 */
function buildParams(outcome: HostProcessQueryOutcome, options: BuildParamsOptions = {}): BuildHostProcessQueryMessageParams {
  return {
    command: COMMAND,
    elapsedInMilliseconds: options.elapsedInMilliseconds ?? 30_051,
    exitCode: options.exitCode ?? null,
    outcome,
    partialRowCount: options.partialRowCount ?? 0,
    signal: options.signal ?? null,
    standardError: options.standardError ?? '',
    timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
  };
}

describe('resolveHostProcessQueryOutcome', () => {
  it('should report a clean call that parsed rows as listed', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: null,
      hasFailed: false,
      hasReportedNoMatch: false,
      isKilled: false,
      rowCount: 528,
      standardError: ''
    })).toBe('listed');
  });

  /*
   * A host always has processes, so this is a failed query however it exited —
   * the one case the zero-row check exists for.
   */
  it('should report a clean call that parsed nothing as zero-rows', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: null,
      hasFailed: false,
      hasReportedNoMatch: false,
      isKilled: false,
      rowCount: 0,
      standardError: ''
    })).toBe('zero-rows');
  });

  /*
   * A filtered `tasklist` that matches nothing exits 0 and says so on stdout —
   * the one empty answer that is an answer.
   */
  it('should report a clean call that parsed nothing but reported no match as listed', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: null,
      hasFailed: false,
      hasReportedNoMatch: true,
      isKilled: false,
      rowCount: 0,
      standardError: ''
    })).toBe('listed');
  });

  it('should not let a no-match notice rescue a call that failed', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: null,
      hasFailed: true,
      hasReportedNoMatch: true,
      isKilled: true,
      rowCount: 0,
      standardError: ''
    })).toBe('timed-out');
  });

  it('should report a command that never ran as not-found', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: 'ENOENT',
      hasFailed: true,
      hasReportedNoMatch: false,
      isKilled: false,
      rowCount: 0,
      standardError: ''
    })).toBe('not-found');
  });

  it('should report a listing that overran the buffer as output-overran', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      hasFailed: true,
      hasReportedNoMatch: false,
      isKilled: false,
      rowCount: 0,
      standardError: ''
    })).toBe('output-overran');
  });

  /*
   * The shape measured on this host, 2026-09-23: `killed` with a `null` exit
   * code and nothing on stderr, at ~30s of a 30s budget. Traced without a
   * budget the same call ran to 92.2s, so this is a real timeout and not a
   * near miss.
   */
  it('should report a killed call as timed-out', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: null,
      hasFailed: true,
      hasReportedNoMatch: false,
      isKilled: true,
      rowCount: 297,
      standardError: ''
    })).toBe('timed-out');
  });

  it('should report a non-zero exit that explained itself on stderr as refused', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: 1,
      hasFailed: true,
      hasReportedNoMatch: false,
      isKilled: false,
      rowCount: 0,
      standardError: 'ERROR: The search filter cannot be recognized.\r\r\n'
    })).toBe('refused');
  });

  /*
   * `tasklist` writes `ERROR: <reason>` to stderr for every refusal it has —
   * verified on this host against a bad filter and an unreachable host — so
   * silence means the child never got to object. That is the distinction the
   * single `error.message` line could not draw.
   */
  it('should report a silent non-zero exit as crashed rather than refused', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: 3_221_225_477,
      hasFailed: true,
      hasReportedNoMatch: false,
      isKilled: false,
      rowCount: 0,
      standardError: ''
    })).toBe('crashed');
  });

  it('should treat whitespace-only stderr as no explanation at all', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: 1,
      hasFailed: true,
      hasReportedNoMatch: false,
      isKilled: false,
      rowCount: 0,
      standardError: '  \r\n  '
    })).toBe('crashed');
  });

  it('should prefer not-found over the kill it was reported with', () => {
    expect(resolveHostProcessQueryOutcome({
      errorCode: 'ENOENT',
      hasFailed: true,
      hasReportedNoMatch: false,
      isKilled: true,
      rowCount: 0,
      standardError: ''
    })).toBe('not-found');
  });
});

describe('buildHostProcessQueryMessage', () => {
  /*
   * The first half of the defect this module exists for: a successful listing
   * must be silent, and a failed one must produce exactly ONE line. The
   * predecessor logged `could not list host processes` and `listed no
   * processes` together for a single failure, which read as a successful run
   * that found nothing.
   */
  it('should say nothing at all for a successful listing', () => {
    expect(buildHostProcessQueryMessage(buildParams('listed', { partialRowCount: 528 }))).toBeUndefined();
  });

  it('should name the budget, the kill and the partial listing for a timeout', () => {
    expect(buildHostProcessQueryMessage(buildParams('timed-out', {
      elapsedInMilliseconds: 30_051,
      partialRowCount: 297,
      signal: 'SIGTERM'
    }))).toBe(
      `Warning: \`${COMMAND}\` did not finish within its 30.0s budget and was killed after 30.1s (SIGTERM), having listed 297 process(es) by then — so it was working, not refusing, and the budget is what ran out. The partial listing is discarded rather than used: the owned set is a *difference* between two listings, and a truncated one on either side would both miss a process this run owns and claim one it does not. ${CONSEQUENCE}`
    );
  });

  it('should omit the signal from a timeout that was not reported with one', () => {
    expect(buildHostProcessQueryMessage(buildParams('timed-out', { partialRowCount: 297 }))).toContain('was killed after 30.1s, having listed 297 process(es)');
  });

  /*
   * `0xC0000005` is unreadable as `3221225477`, and the hex form is the only
   * one a reader can look up.
   */
  it('should render an NTSTATUS exit code in hex for a crash', () => {
    expect(buildHostProcessQueryMessage(buildParams('crashed', {
      elapsedInMilliseconds: 240,
      exitCode: 3_221_225_477,
      partialRowCount: 12
    }))).toBe(
      `Warning: \`${COMMAND}\` died after 240ms without explaining itself (exit 0xC0000005, nothing on stderr, 12 process(es) listed) — it did not refuse the request, since it always explains a refusal on stderr. Suspect a crash or an interfering security product, and try the command by hand. ${CONSEQUENCE}`
    );
  });

  it('should render an ordinary exit code in decimal', () => {
    expect(buildHostProcessQueryMessage(buildParams('crashed', { exitCode: 1 }))).toContain('(exit 1, nothing on stderr,');
  });

  it('should admit it does not know the exit code of a child that never reported one', () => {
    expect(buildHostProcessQueryMessage(buildParams('crashed', { exitCode: null }))).toContain('(exit unknown, nothing on stderr,');
  });

  it('should quote what the command said when it refused', () => {
    expect(buildHostProcessQueryMessage(buildParams('refused', {
      elapsedInMilliseconds: 118,
      exitCode: 1,
      standardError: 'ERROR: The search filter cannot be recognized.\r\r\n'
    }))).toBe(
      `Warning: \`${COMMAND}\` refused the request after 118ms (exit 1): ERROR: The search filter cannot be recognized. ${CONSEQUENCE}`
    );
  });

  it('should supply the sentence break for a refusal that came without one', () => {
    expect(buildHostProcessQueryMessage(buildParams('refused', {
      exitCode: 1,
      standardError: 'ERROR: Access is denied'
    }))).toContain('(exit 1): ERROR: Access is denied. Teardown falls back');
  });

  it('should say the executable was missing rather than blaming the request', () => {
    expect(buildHostProcessQueryMessage(buildParams('not-found', { elapsedInMilliseconds: 6 }))).toBe(
      `Warning: \`${COMMAND}\` could not be run at all after 6ms: the executable was not found on PATH. ${CONSEQUENCE}`
    );
  });

  it('should point at the buffer when the output overran it', () => {
    expect(buildHostProcessQueryMessage(buildParams('output-overran', { elapsedInMilliseconds: 1500 }))).toBe(
      `Warning: \`${COMMAND}\` produced more output after 1.5s than the listing's buffer allows, so none of it could be read. Raise the buffer. ${CONSEQUENCE}`
    );
  });

  it('should call a clean call that listed nothing a failed query', () => {
    expect(buildHostProcessQueryMessage(buildParams('zero-rows', { elapsedInMilliseconds: 900 }))).toBe(
      `Warning: \`${COMMAND}\` exited cleanly after 900ms but its output parsed to no processes and carried no no-match notice — a whole-host listing cannot be empty on a running host, and a filtered one says so when nothing matches. Treating it as a failed query. ${CONSEQUENCE}`
    );
  });

  it('should throw rather than invent a line for an outcome it does not recognize', () => {
    expect(() => buildHostProcessQueryMessage(buildParams(castTo<HostProcessQueryOutcome>('probably-fine')))).toThrow('Unhandled value: probably-fine');
  });
});
