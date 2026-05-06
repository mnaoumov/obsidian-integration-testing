/**
 * @file
 *
 * Generates a JavaScript expression that calls a serialized function with serialized arguments.
 */

import type { App } from 'obsidian';
import type { Promisable } from 'type-fest';

import { getFunctionExpressionString } from './function-expression.ts';
import { jsonWithFunctions } from './json-with-functions.ts';

/**
 * Parameters with `ensureLayoutReady` function.
 */
export interface EnsureLayoutReadyParams {
  /**
   * Waits for the Obsidian workspace layout to be ready.
   *
   * @param params - Parameters including the `app` instance.
   * @returns A promise that resolves when the layout is ready.
   */
  ensureLayoutReady(params: GenerateFunctionCallParams): Promise<void>;
}

/**
 * Parameters for `generateFunctionCall`.
 *
 * @typeParam Params - The type of the additional parameters to pass to the function being called.
 */
export type GenerateFunctionCallParams<Params = unknown> = AppParams & Params;

interface AppParams {
  app: App;
}

/* v8 ignore start -- Serialized via toString() and executed inside Obsidian, not callable in unit tests. */
/**
 * Waits for the Obsidian workspace layout to be ready.
 *
 * @param params - The parameters, including the `app` instance.
 * @returns A promise that resolves when the layout is ready.
 */
export async function ensureLayoutReady(params: GenerateFunctionCallParams): Promise<void> {
  await new Promise<void>((resolve) => {
    params.app.workspace.onLayoutReady(resolve);
  });
}
/* v8 ignore stop */

/**
 * Generates a JavaScript expression string that immediately invokes the given
 * function with the given arguments.
 *
 * The function is serialized via {@link getFunctionExpressionString} and the
 * arguments are serialized via {@link jsonWithFunctions}, producing a
 * self-contained IIFE of the form `(fnExpr)(argsExpr)`.
 *
 * @param fn - The function to call.
 * @param params - The arguments to pass. When omitted, the function is called with no arguments.
 * @returns A JavaScript expression string.
 */

/**
 * Generates a JavaScript expression string that immediately invokes the given
 * function with the given arguments.
 *
 * @param fn - The function to call.
 * @param params - The arguments to pass.
 * @returns A JavaScript expression string.
 */
export function generateFunctionCall<Params>(fn: (params: GenerateFunctionCallParams<Params>) => Promisable<unknown>, params: Params): string {
  const fnExpr = getFunctionExpressionString(fn);
  const serializedParams = jsonWithFunctions(params);
  return `(${fnExpr})(Object.assign(${serializedParams}, { app: window.app }))`;
}
