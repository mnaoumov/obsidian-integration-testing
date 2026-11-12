/**
 * @file
 *
 * Turns the reply to a desktop `Runtime.evaluate` carrying a caller's closure into its result string, or
 * into the error it stands for.
 *
 * A reply has three shapes: a protocol `error` (the command itself failed, e.g. `Promise was collected`
 * when the awaited promise was garbage-collected), `exceptionDetails` (the closure threw), or a `result`.
 * The first one used to be ignored, so a failed command read as a closure that returned nothing.
 */

import { CollectedPromiseError } from '../eval/collected-promise-error.ts';

/**
 * The reply fields this module reads.
 */
export interface CdpEvaluateResponse {
  readonly error?: CdpEvaluateResponseError;
  readonly result?: CdpEvaluateResponseResult;
}

/**
 * A protocol error: the command itself failed.
 */
export interface CdpEvaluateResponseError {
  readonly message: string;
}

/**
 * An exception the closure threw.
 */
export interface CdpEvaluateResponseExceptionDetails {
  readonly exception?: CdpEvaluateResponseExceptionObject;
  readonly text: string;
}

/**
 * The thrown value of an exception.
 */
export interface CdpEvaluateResponseExceptionObject {
  readonly description?: string;
}

/**
 * The `result` member of a reply.
 */
export interface CdpEvaluateResponseResult {
  readonly exceptionDetails?: CdpEvaluateResponseExceptionDetails;
  readonly result?: CdpEvaluateResponseValue;
}

/**
 * The value the closure returned.
 */
export interface CdpEvaluateResponseValue {
  readonly type: string;
  readonly value?: unknown;
}

/**
 * What a closure that returned `undefined` (or nothing) evaluates to.
 */
export const NO_OUTPUT = '(no output)';

const COLLECTED_PROMISE_MESSAGE_PATTERN = /promise was collected/i;
const TRANSPORT_NAME = 'desktop (CDP)';

/**
 * Reports whether a CDP protocol error says the awaited promise was garbage-collected.
 *
 * @param message - The protocol error's message.
 * @returns Whether it is the collected-promise error.
 */
export function checkIsCollectedPromiseMessage(message: string): boolean {
  return COLLECTED_PROMISE_MESSAGE_PATTERN.test(message);
}

/**
 * Reads the result string out of a `Runtime.evaluate` reply.
 *
 * @param response - The reply.
 * @returns The result as a string, or {@link NO_OUTPUT} when the closure returned `undefined`.
 * @throws {@link CollectedPromiseError} when the awaited promise was garbage-collected, and an `Error` for any
 *   other protocol error or for an exception the closure threw.
 */
export function resolveCdpEvaluateResult(response: CdpEvaluateResponse): string {
  if (response.error) {
    const { message } = response.error;
    const protocolError = new Error(`CDP Runtime.evaluate failed: ${message}`);
    if (checkIsCollectedPromiseMessage(message)) {
      throw new CollectedPromiseError({ cause: protocolError, transportName: TRANSPORT_NAME });
    }
    throw protocolError;
  }

  if (response.result?.exceptionDetails) {
    const description = response.result.exceptionDetails.exception?.description
      ?? response.result.exceptionDetails.text;
    throw new Error(`CDP evaluation error: ${description}`);
  }

  const resultObject = response.result?.result;
  return !resultObject || resultObject.type === 'undefined' ? NO_OUTPUT : String(resultObject.value);
}
