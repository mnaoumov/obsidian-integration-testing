/**
 * @file
 *
 * The error an evaluation raises when the promise it awaited was garbage-collected before it settled.
 *
 * A promise nothing references can never be resolved, so Chromium is free to collect it, and CDP then
 * answers `Runtime.evaluate` with the protocol error `Promise was collected` instead of a result. It is a
 * type of its own so a caller can `instanceof`-match it, and so the report names the real cause rather
 * than whatever later read the missing result.
 */

/**
 * Parameters for the {@link CollectedPromiseError} constructor.
 */
export interface CollectedPromiseErrorConstructorParams {
  /**
   * The protocol error the transport received, kept as the `cause`.
   */
  readonly cause?: unknown;

  /**
   * The transport that ran the evaluation, e.g. `'desktop (CDP)'`.
   */
  readonly transportName: string;
}

/**
 * Thrown when an evaluated closure awaited a promise that was garbage-collected, so it could never settle.
 */
export class CollectedPromiseError extends Error {
  /**
   * The transport that ran the evaluation.
   */
  public readonly transportName: string;

  /**
   * Creates the error for the transport that ran the evaluation.
   *
   * @param params - The transport name and the original protocol error.
   */
  public constructor(params: CollectedPromiseErrorConstructorParams) {
    const { cause, transportName } = params;
    super(
      `The closure evaluated on the ${transportName} transport awaited a promise that was garbage-collected, so it can never settle. `
        + 'A promise whose resolver nothing keeps (for example `await new Promise(() => undefined)`) is unreachable, and the browser may collect it '
        + 'while the evaluation waits. Keep a reference to the resolver, or await something that settles.',
      { cause }
    );
    this.name = 'CollectedPromiseError';
    this.transportName = transportName;
  }
}
