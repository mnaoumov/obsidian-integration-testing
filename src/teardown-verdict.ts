/**
 * @file
 *
 * Pure verdict + message building for the auto-started-process teardown.
 *
 * The teardown used to log `Auto-started Appium server stopped.` on the
 * **attempt** — printed unconditionally right after the kill was issued, with
 * nothing asserting the process had actually exited. On 2026-09-02 both the
 * server and the emulator were still serving ten minutes after that line was
 * written, and the next run adopted them and died two seconds into its session
 * as they finally finished dying. A log that says the machine is clean when it
 * is not does not merely fail to help — it sends the next reader away from the
 * cause.
 *
 * So a stop is a claim that has to be earned: only {@link resolveTeardownOutcome}
 * may decide one was, and only the `stopped` outcomes are allowed to say so.
 */

import { assertNever } from './type-guards.ts';

/**
 * Parameters for {@link buildTeardownMessage}.
 */
export interface BuildTeardownMessageParams {
  /**
  What was checked, as a noun phrase — e.g. `port 4723`, `AVD "obsidian_test" on device emulator-5554`.
   */
  readonly evidence: string;

  /**
  The verdict from {@link resolveTeardownOutcome}.
   */
  readonly outcome: TeardownOutcome;

  /**
  What was being stopped — e.g. `Auto-started Appium server`.
   */
  readonly subject: string;

  /**
  The budget the stop was given, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * Parameters for {@link resolveTeardownOutcome}.
 */
export interface ResolveTeardownOutcomeParams {
  /**
  Whether the first kill was followed by a second, harder one.
   */
  readonly hasEscalated: boolean;

  /**
  Whether the process was **observed** to be gone, rather than merely asked to go.
   */
  readonly isStopped: boolean;
}

/**
 * What the teardown actually achieved.
 */
export type TeardownOutcome = 'still-running' | 'stopped-after-escalation' | 'stopped';

/**
 * Builds the line the teardown logs for an outcome.
 *
 * @param params - The outcome plus what was being stopped and what proved it.
 * @returns The log line.
 */
export function buildTeardownMessage(params: BuildTeardownMessageParams): string {
  switch (params.outcome) {
    case 'still-running': {
      return `WARNING: ${params.subject} did not exit within ${String(params.timeoutInMilliseconds)}ms and still holds ${params.evidence}; a later run may adopt it. Kill it before the next Android run.`;
    }
    case 'stopped': {
      return `${params.subject} stopped (verified: ${params.evidence} released).`;
    }
    case 'stopped-after-escalation': {
      return `${params.subject} stopped after escalation (verified: ${params.evidence} released).`;
    }
    default: {
      return assertNever(params.outcome);
    }
  }
}

/**
 * Decides what the teardown achieved, from what was observed after the kill.
 *
 * @param params - Whether the process is gone, and whether it took an escalation.
 * @returns The outcome.
 */
export function resolveTeardownOutcome(params: ResolveTeardownOutcomeParams): TeardownOutcome {
  if (!params.isStopped) {
    return 'still-running';
  }

  return params.hasEscalated ? 'stopped-after-escalation' : 'stopped';
}
