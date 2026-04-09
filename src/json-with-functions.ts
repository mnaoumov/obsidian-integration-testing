/**
 * @file
 *
 * Serializes a value to JSON, preserving function bodies as raw source text.
 */

import { getFunctionExpressionString } from './function-expression.ts';

/**
 * Serializes a value to JSON with function bodies included as raw source text.
 *
 * Standard `JSON.stringify` omits functions entirely. This helper replaces
 * each function value with a unique placeholder during stringification,
 * then substitutes the placeholders with the real `toString()` output.
 *
 * @param value - The value to serialize.
 * @returns A JSON-like string where functions appear as their source text.
 */
export function jsonWithFunctions(value: unknown): string {
  const functionMap = new Map<string, string>();

  const JSON_INDENT = 2;
  const json = JSON.stringify(value, (_key: string, val: unknown): JSONValueF<unknown> => {
    if (typeof val === 'function') {
      const placeholder = `__fn_${String(functionMap.size)}__`;
      functionMap.set(placeholder, getFunctionExpressionString(val));
      return placeholder;
    }
    return val as JSONValueF<unknown>;
  }, JSON_INDENT);

  let result = json;
  for (const [placeholder, fnSource] of functionMap) {
    result = result.replace(`"${placeholder}"`, fnSource);
  }

  return result;
}
