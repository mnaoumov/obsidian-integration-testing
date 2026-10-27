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
  const json = JSON.stringify(value, (_key: string, value_: unknown): JSONValueF<unknown> => {
    if (typeof value_ === 'function') {
      const placeholder = `__fn_${String(functionMap.size)}__`;
      functionMap.set(placeholder, getFunctionExpressionString(value_));
      return placeholder;
    }
    return value_ as JSONValueF<unknown>;
  }, JSON_INDENT);

  let result = json;
  for (const [placeholder, functionSource] of functionMap) {
    /*
     * The replacer FUNCTION is required, not cosmetic: `fnSource` is arbitrary user function source, and a
     * string replacement would read any `$&` / `$'` / `` $` `` inside it as a substitution pattern and silently
     * corrupt the serialized function.
     */
    result = result.replace(`"${placeholder}"`, () => functionSource);
  }

  return result;
}
