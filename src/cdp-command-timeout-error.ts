/**
 * @file
 *
 * The distinct error the desktop CDP transport raises when a single CDP command
 * gets no response within `commandTimeoutInMilliseconds`.
 *
 * It exists as a type rather than a bare `Error` so ONE caller can tell it apart:
 * `evaluate()`, which is the only `Runtime.evaluate` carrying a test's own
 * closure, re-reports it as `EvalCapExceededError`. The harness's other
 * `Runtime.evaluate` calls — the trust dialog, the parent-liveness watchdog, the
 * boot probes — time out for reasons that have nothing to do with a test waiting
 * too long, and matching them on the method name would produce exactly the
 * misdiagnosis this work removes, pointing the other way.
 */

/**
 * Parameters for the {@link CdpCommandTimeoutError} constructor.
 */
export interface CdpCommandTimeoutErrorConstructorParams {
  /**
  The CDP method that got no response, e.g. `'Runtime.evaluate'`.
   */
  readonly method: string;

  /**
  The per-command budget that elapsed, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * Thrown when a CDP command gets no response within the transport's per-command
 * timeout. Carries the method and the budget so a caller can `instanceof`-match
 * and re-report it in its own terms.
 */
export class CdpCommandTimeoutError extends Error {
  /**
  The CDP method that got no response.
   */
  public readonly method: string;

  /**
  The per-command budget that elapsed, in milliseconds.
   */
  public readonly timeoutInMilliseconds: number;

  /**
   * Creates the error from the method and the elapsed budget.
   *
   * @param params - The CDP method and the per-command timeout.
   */
  public constructor(params: CdpCommandTimeoutErrorConstructorParams) {
    const { method, timeoutInMilliseconds } = params;
    super(`CDP command timed out after ${String(timeoutInMilliseconds)}ms: ${method}`);
    this.name = 'CdpCommandTimeoutError';
    this.method = method;
    this.timeoutInMilliseconds = timeoutInMilliseconds;
  }
}
