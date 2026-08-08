/**
 * @file
 *
 * Converts a function into a string that is a valid function expression.
 */

/**
 * Converts a function into a string that is a valid function expression.
 *
 * `Function.prototype.toString()` on a shorthand method like `{ callback() {} }`
 * returns `"callback() {}"`, which is not a valid expression.
 * This helper detects that form and prefixes it with `function `.
 *
 * @param callback - The function to convert.
 * @returns A string that is a valid function expression.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- We need to use `Function` type.
export function getFunctionExpressionString(callback: Function): string {
  const functionString = callback.toString();

  if (FUNCTION_EXPRESSION_RE.test(functionString)) {
    return functionString;
  }

  const asyncMatch = ASYNC_KEYWORD_RE.exec(functionString);
  if (asyncMatch) {
    return `async function ${functionString.slice(asyncMatch[0].length)}`;
  }

  return `function ${functionString}`;
}

/**
 * Matches strings that are already valid function expressions:
 * - `function ...` (keyword, not identifier like `function1`)
 * - `(` (arrow function)
 * - `async\b` followed by `function\b` or `(` (async function/arrow)
 */
const FUNCTION_EXPRESSION_RE = /^(?:function\b|async\b\s*(?:function\b|\()|\()/;

/**
 * Matches the `async` keyword (word boundary, not `async1`) followed by optional whitespace.
 * Used to strip the `async` prefix from async shorthand methods before re-adding `async function`.
 */
const ASYNC_KEYWORD_RE = /^async\b\s*/;
