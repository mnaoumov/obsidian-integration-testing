/**
 * @file
 *
 * Generates a JavaScript expression that calls a serialized function with serialized arguments.
 */

import { getFunctionExpressionString } from './function-expression.ts';
import { jsonWithFunctions } from './json-with-functions.ts';

/**
 * Generates a JavaScript expression string that immediately invokes the given
 * function with the given arguments.
 *
 * The function is serialized via {@link getFunctionExpressionString} and the
 * arguments are serialized via {@link jsonWithFunctions}, producing a
 * self-contained IIFE of the form `(fnExpr)(argsExpr)`.
 *
 * @param fn - The function to call.
 * @param args - The arguments to pass. When omitted, the function is called with no arguments.
 * @returns A JavaScript expression string.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- We need to use `Function` type.
export function generateFunctionCall(fn: Function, args?: unknown): string {
  const fnExpr = getFunctionExpressionString(fn);
  if (args === undefined) {
    return `(${fnExpr})()`;
  }
  return `(${fnExpr})(${jsonWithFunctions(args)})`;
}
