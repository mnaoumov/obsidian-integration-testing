/**
 * @file
 *
 * Converts an error into a human-readable string with its full stack trace,
 * recursive `cause` chain, and the aggregated errors of an `AggregateError`.
 *
 * Used Node-side by the framework global-setup/teardown to log non-fatal
 * cleanup errors. It is a hand-kept copy of `obsidian-dev-utils`' `errorToString`
 * (`src/error.ts`) — see the sync rule L17 — so the two stay behaviorally
 * identical without the harness taking a dependency on the utility library.
 */

/* v8 ignore start -- Hand-kept duplicate of obsidian-dev-utils' errorToString (see L17); its behavior is covered by that library's own unit tests, not repeated here. */

const STACK_TRACE_PREFIX = '    at';

/**
 * Converts an error to a string representation, including nested causes and the
 * aggregated errors of an `AggregateError`, with each nested error rendered as
 * `    at` separator lines so it blends into the surrounding stack.
 *
 * @param error - The error to convert to a string.
 * @returns The string representation of the error.
 */
export function errorToString(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  let message = error.stack ?? `${error.name}: ${error.message}`;
  if (error.cause !== undefined) {
    message = appendNestedError(message, error.cause, 'Caused by:');
  }
  if (error instanceof AggregateError) {
    const aggregatedErrors: readonly unknown[] = error.errors;
    for (const [index, aggregatedError] of aggregatedErrors.entries()) {
      message = appendNestedError(message, aggregatedError, `Aggregated error #${String(index + 1)}:`);
    }
  }
  return message;
}

function appendNestedError(message: string, nestedError: unknown, title: string): string {
  let result = `${message}\n${generateStackTraceLine(title)}`;
  for (const line of errorToString(nestedError).split('\n')) {
    if (!line.trim()) {
      continue;
    }
    result += line.startsWith(STACK_TRACE_PREFIX)
      ? `\n${line}`
      : `\n${generateStackTraceLine(line)}`;
  }
  return result;
}

function generateStackTraceLine(title: string): string {
  return `${STACK_TRACE_PREFIX} --- ${title} --- (0)`;
}

/* v8 ignore stop */
