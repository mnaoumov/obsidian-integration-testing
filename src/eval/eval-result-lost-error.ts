/**
 * @file
 *
 * The error an evaluation raises when the transport hands back no result at all.
 *
 * The harness's `evalWrapper` answers every closure with a JSON envelope, an `undefined` result
 * included, so a transport that returns nothing means the wrapper never answered: the page that ran the
 * closure was replaced (a reload, or a renderer that died under it) while the closure ran. Before this
 * type existed `evalInObsidian` handed the test `undefined`, and the failure surfaced later as an
 * unrelated `Cannot read properties of undefined`.
 */

/**
 * Parameters for the {@link EvalResultLostError} constructor.
 */
export interface EvalResultLostErrorConstructorParams {
  /**
   * What the transport found when it looked at the page afterwards, or `null` when it cannot look.
   */
  readonly diagnosis: null | string;

  /**
   * How long the evaluation ran before the transport answered with nothing.
   */
  readonly elapsedInMilliseconds: number;
}

/**
 * Thrown when an evaluation's result never came back, because the page that ran it went away.
 */
export class EvalResultLostError extends Error {
  /**
   * What the transport found when it looked at the page afterwards, or `null` when it cannot look.
   */
  public readonly diagnosis: null | string;

  /**
   * Creates the error.
   *
   * @param params - The transport's diagnosis and how long the evaluation ran.
   */
  public constructor(params: EvalResultLostErrorConstructorParams) {
    const { diagnosis, elapsedInMilliseconds } = params;
    super(
      `evalInObsidian: the closure's result was lost after ${String(elapsedInMilliseconds)}ms: the transport answered with no result, `
        + `which the harness wrapper never does, so the page that ran the closure went away (a reload, or a renderer that died) before it answered. ${diagnosis ?? 'The transport cannot inspect the page to say more.'}`
    );
    this.name = 'EvalResultLostError';
    this.diagnosis = diagnosis;
  }
}
