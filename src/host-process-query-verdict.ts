/**
 * @file
 *
 * Pure classification of the host process listing — deciding, from how
 * `tasklist` / `ps` ended, *which* way it failed, and saying so in one line.
 *
 * The listing is what names the emulator backend a run owns, and therefore the
 * only PID teardown can escalate to (**L56**). It is best-effort by design: a
 * listing that cannot be produced yields no PIDs rather than failing the run.
 * What it must never be is **unexplained**, and for three weeks it was:
 *
 * ```text
 * Warning: could not list host processes (`tasklist`): Command failed: tasklist /FO CSV /NH
 *
 * Warning: `tasklist` listed no processes.
 * ```
 *
 * Two defects in four lines. The pair is *contradictory* — the first says the
 * command failed, the second says it ran and found nothing — and they were
 * emitted together for a single failure, because a failed call resolves `''`
 * and an empty string parses to zero rows. `zero-rows` exists to catch a
 * listing that succeeded and yet returned nothing, which on a real host can
 * only be a failed query; it is not a second opinion on a call that already
 * reported an error.
 *
 * And the surviving diagnostic is `error.message` alone, which for `execFile`
 * is `Command failed: <cmd>\n<stderr>` — so the log carried the command back
 * to the reader and threw away everything that identifies the failure:
 * `error.code`, `error.killed`, `error.signal`, and how long the call took.
 * Measured 2026-09-23 on this host, that discarded evidence is decisive:
 *
 * - `tasklist` **always** writes `ERROR: <reason>` to stderr when it objects —
 *   a bad filter, an unreachable host — and exits 1. So a non-zero exit with
 *   **empty** stderr is not `tasklist` refusing; it is the host killing the
 *   child, and `crashed` says so.
 * - The exact spawn the harness makes succeeds 39 times out of 39 from an idle
 *   Node process (0.6-4.3s, 26 KB, ~530 rows, against a 30s budget and an 8 MB
 *   ceiling). So "the spawn is wrong" — a missing shell, a PATH the child did
 *   not inherit, an undersized buffer — is ruled out: each has its **own** message
 *   (`spawn tasklist ENOENT`, `stdout maxBuffer length exceeded`), and none of
 *   them is the one observed.
 * - Under an emulator boot the same call inflates to ~9x its idle cost, which
 *   is the contention `HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS` is sized
 *   for and the failure the old line could not distinguish from a crash.
 *
 * This is the same fault `avd-probe-verdict.ts` was written for — a probe that
 * discarded its error, leaving "never answered" indistinguishable from "the
 * answer is no" — and it is fixed the same way: classify, name the
 * consequence, and keep the classification pure so it is unit-testable while
 * the `execFile` glue stays in the integration-only caller.
 */

import { assertNever } from './type-guards.ts';

/**
 * The lowest exit code Windows reserves for an `NTSTATUS` failure.
 *
 * A child killed by the OS — an access violation, a stack overflow — exits with
 * its `NTSTATUS` as the code, and `0xC0000005` is unreadable in decimal
 * (`3221225477`). Codes at or above this are therefore reported in hex, which
 * is the only form a reader can look up.
 */
const NTSTATUS_FAILURE_FLOOR = 0xC0_00_00_00;

/**
 * The base an `NTSTATUS` exit code is rendered in.
 */
const HEXADECIMAL_RADIX = 16;

/**
 * Milliseconds in a second, for rendering a duration.
 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Parameters for {@link buildHostProcessQueryMessage}.
 */
export interface BuildHostProcessQueryMessageParams {
  /**
  The command that was run, for the reader to try by hand — e.g. `tasklist /FO CSV /NH`.
   */
  readonly command: string;

  /**
  What the failure costs the caller, closing the line. Defaults to the teardown consequence, which is what the harness's own listing loses; the wedge probe states what *it* loses instead.
   */
  readonly consequence?: string | undefined;

  /**
  How long the call took before it ended, in milliseconds.
   */
  readonly elapsedInMilliseconds: number;

  /**
  The child's exit code, when it exited rather than failing to start or being killed.
   */
  readonly exitCode: null | number;

  /**
  The verdict from {@link resolveHostProcessQueryOutcome}.
   */
  readonly outcome: HostProcessQueryOutcome;

  /**
  How many processes the output parsed to — the *partial* listing on a failure, which is the evidence that the command was working when it died.
   */
  readonly partialRowCount: number;

  /**
  The signal the child was killed with, when it was killed.
   */
  readonly signal: null | string;

  /**
  Whatever the child wrote to stderr — quoted for `refused`, and the emptiness that identifies `crashed`.
   */
  readonly standardError: string;

  /**
  The budget the call was given, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * How the host process listing ended.
 *
 * `listed` is the only success. The rest are distinct failures on purpose: they
 * need different fixes, and the line they used to share named none of them.
 */
export type HostProcessQueryOutcome = 'listed' | 'zero-rows' | HostQueryFailure;

/**
 * The ways a host query can fail, shared by every query that classifies its ending.
 */
export type HostQueryFailure = 'crashed' | 'not-found' | 'output-overran' | 'refused' | 'timed-out';

/**
 * Parameters for {@link resolveHostProcessQueryOutcome}.
 */
export interface ResolveHostProcessQueryOutcomeParams {
  /**
  `execFile`'s `error.code`: the numeric exit code, or a string like `ENOENT` when the child never ran.
   */
  readonly errorCode: null | number | string;

  /**
  Whether `execFile` reported an error at all.
   */
  readonly hasFailed: boolean;

  /**
  Whether a **filtered** query affirmatively reported that nothing matched (`checkIsNoMatchReported`) — the one way an empty answer is an answer.
   */
  readonly hasReportedNoMatch: boolean;

  /**
  `execFile`'s `error.killed`: whether the budget expired and the child was killed.
   */
  readonly isKilled: boolean;

  /**
  How many processes the output parsed to.
   */
  readonly rowCount: number;

  /**
  Whatever the child wrote to stderr.
   */
  readonly standardError: string;
}

/**
 * Parameters for {@link resolveHostQueryFailure}.
 */
export type ResolveHostQueryFailureParams = Pick<ResolveHostProcessQueryOutcomeParams, 'errorCode' | 'isKilled' | 'standardError'>;

/**
 * Builds the single line the listing logs for an outcome.
 *
 * One line, never two: the contradictory pair in this file's header is the
 * defect this replaces. `listed` has nothing to report, so it returns
 * `undefined` rather than a cheerful line on the hot path.
 *
 * @param params - The outcome plus the command, the budget and what the child left behind.
 * @returns The warning to log, or `undefined` when the listing succeeded.
 */
export function buildHostProcessQueryMessage(params: BuildHostProcessQueryMessageParams): string | undefined {
  const cost = `after ${formatDuration(params.elapsedInMilliseconds)}`;
  const consequence = params.consequence ?? 'Teardown falls back to `adb devices` alone and has no PID to escalate to.';

  switch (params.outcome) {
    case 'crashed': {
      return `Warning: \`${params.command}\` died ${cost} without explaining itself (exit ${formatExitCode(params.exitCode)}, nothing on stderr, ${String(params.partialRowCount)} process(es) listed) — it did not refuse the request, since it always explains a refusal on stderr. Suspect a crash or an interfering security product, and try the command by hand. ${consequence}`;
    }
    case 'listed': {
      return undefined;
    }
    case 'not-found': {
      return `Warning: \`${params.command}\` could not be run at all ${cost}: the executable was not found on PATH. ${consequence}`;
    }
    case 'output-overran': {
      return `Warning: \`${params.command}\` produced more output ${cost} than the listing's buffer allows, so none of it could be read. Raise the buffer. ${consequence}`;
    }
    case 'refused': {
      return `Warning: \`${params.command}\` refused the request ${cost} (exit ${formatExitCode(params.exitCode)}): ${formatRefusal(params.standardError)} ${consequence}`;
    }
    case 'timed-out': {
      return `Warning: \`${params.command}\` did not finish within its ${formatDuration(params.timeoutInMilliseconds)} budget and was killed ${cost}${params.signal === null ? '' : ` (${params.signal})`}, having listed ${String(params.partialRowCount)} process(es) by then — so it was working, not refusing, and the budget is what ran out. The partial listing is discarded rather than used: the owned set is a *difference* between two listings, and a truncated one on either side would both miss a process this run owns and claim one it does not. ${consequence}`;
    }
    case 'zero-rows': {
      return `Warning: \`${params.command}\` exited cleanly ${cost} but its output parsed to no processes and carried no no-match notice — a whole-host listing cannot be empty on a running host, and a filtered one says so when nothing matches. Treating it as a failed query. ${consequence}`;
    }
    default: {
      return assertNever(params.outcome);
    }
  }
}

/**
 * Renders a millisecond duration for a log line.
 *
 * @param durationInMilliseconds - The duration.
 * @returns Whole milliseconds under a second, and seconds to one decimal above it.
 */
export function formatDuration(durationInMilliseconds: number): string {
  return durationInMilliseconds < MILLISECONDS_PER_SECOND
    ? `${String(durationInMilliseconds)}ms`
    : `${(durationInMilliseconds / MILLISECONDS_PER_SECOND).toFixed(1)}s`;
}

/**
 * Renders a child's exit code, in the base a reader can look it up in.
 *
 * @param exitCode - The exit code, or `null` when the child was killed before exiting.
 * @returns The code in hex when it is an `NTSTATUS` failure, in decimal otherwise.
 */
export function formatExitCode(exitCode: null | number): string {
  if (exitCode === null) {
    return 'unknown';
  }

  return exitCode >= NTSTATUS_FAILURE_FLOOR ? `0x${exitCode.toString(HEXADECIMAL_RADIX).toUpperCase()}` : String(exitCode);
}

/**
 * Renders what the command said when it refused, as one sentence.
 *
 * `tasklist` ends its own `ERROR: …` with a period and a `\r\r\n`, so quoting it
 * verbatim and adding the sentence break this line needs produced `recognized..`
 * — the terminator is supplied only when the tool did not supply one.
 *
 * @param standardError - Whatever the child wrote to stderr.
 * @returns The refusal, trimmed, ending in exactly one period.
 */
export function formatRefusal(standardError: string): string {
  const refusal = standardError.trim();

  return refusal.endsWith('.') ? refusal : `${refusal}.`;
}

/**
 * Decides how the listing ended, from what `execFile` reported.
 *
 * The order of the branches is the order of specificity: the two failures Node
 * names itself (`ENOENT`, the buffer ceiling) are recognized before the ones
 * that have to be inferred from the child's exit, and `crashed` is last
 * because it is defined by the *absence* of an explanation on stderr.
 *
 * @param params - What `execFile` reported, and how many rows the output parsed to.
 * @returns The outcome.
 */
export function resolveHostProcessQueryOutcome(params: ResolveHostProcessQueryOutcomeParams): HostProcessQueryOutcome {
  if (!params.hasFailed) {
    /*
     * A host always has processes, so a whole-host listing that parses to nothing is a failed query however it
     * exited. A filtered one may legitimately match nothing — but only when it says so; silence is still a failure.
     */
    return params.rowCount === 0 && !params.hasReportedNoMatch ? 'zero-rows' : 'listed';
  }

  return resolveHostQueryFailure(params);
}

/**
 * Decides which way a host query that **did** fail failed.
 *
 * Split out of {@link resolveHostProcessQueryOutcome} so a sibling query whose
 * success rules differ — the port-owner query, where zero owners is an answer —
 * can share one definition of each failure without inheriting `listed` and
 * `zero-rows`.
 *
 * @param params - What `execFile` reported for the failed call.
 * @returns The failure outcome.
 */
export function resolveHostQueryFailure(params: ResolveHostQueryFailureParams): HostQueryFailure {
  if (params.errorCode === 'ENOENT') {
    return 'not-found';
  }

  if (params.errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'output-overran';
  }

  if (params.isKilled) {
    return 'timed-out';
  }

  // `tasklist` and `ps` both explain a refusal on stderr, so silence means the child never got to object.
  return params.standardError.trim() === '' ? 'crashed' : 'refused';
}
