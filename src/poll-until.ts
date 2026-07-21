/**
 * @file
 *
 * Pure poll-until-satisfied loop: repeatedly runs an async `attempt`, returning
 * its result once `until` accepts it, or throwing when a timeout elapses.
 *
 * Extracted from the integration-only {@link pollInObsidian} wrapper (which binds
 * `attempt` to an `evalInObsidian` call and is excluded from unit tests) so the
 * timing/timeout logic stays unit-testable. The clock and sleep are injected so
 * the loop is deterministic under test.
 */

/**
 * Parameters for {@link pollUntil}.
 */
export interface PollUntilParams<Result> {
  /** Runs one attempt and resolves with its result. */
  attempt(this: void): Promise<Result>;

  /** Delay between attempts, in milliseconds. */
  readonly intervalInMilliseconds: number;

  /** Returns the current time in milliseconds (injected for deterministic tests). */
  nowInMilliseconds(this: void): number;

  /** Sleeps for the given number of milliseconds (injected for deterministic tests). */
  sleep(this: void, milliseconds: number): Promise<void>;

  /** Total budget before the poll rejects, in milliseconds. */
  readonly timeoutInMilliseconds: number;

  /** Optional detail appended to the timeout error message. */
  readonly timeoutMessage?: string;

  /** Whether a given attempt result is acceptable (stops the poll). */
  until(this: void, result: Result): boolean;
}

/**
 * Runs `attempt` immediately, then repeatedly every `intervalInMilliseconds`,
 * until `until(result)` is truthy — resolving with that result — or the
 * `timeoutInMilliseconds` budget elapses, at which point it rejects. At least one
 * attempt always runs; the timeout is checked after each unsatisfied attempt, so
 * a slow single attempt cannot be interrupted mid-flight but no further attempt
 * starts past the deadline.
 *
 * @param params - The poll parameters.
 * @returns A {@link Promise} that resolves with the first accepted attempt result.
 */
export async function pollUntil<Result>(params: PollUntilParams<Result>): Promise<Result> {
  const { attempt, intervalInMilliseconds, nowInMilliseconds, sleep, timeoutInMilliseconds, timeoutMessage, until } = params;
  const deadline = nowInMilliseconds() + timeoutInMilliseconds;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Loop exits via return or throw.
  while (true) {
    const result = await attempt();
    if (until(result)) {
      return result;
    }
    if (nowInMilliseconds() >= deadline) {
      const suffix = timeoutMessage === undefined ? '' : `: ${timeoutMessage}`;
      throw new Error(`pollInObsidian timed out after ${String(timeoutInMilliseconds)} milliseconds${suffix}`);
    }
    await sleep(intervalInMilliseconds);
  }
}
