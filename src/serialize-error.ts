/**
 * @file
 *
 * Serializes an error into a human-readable string with full stack trace
 * and recursive cause chain. Each nested cause is indented for readability.
 *
 * This function is serialized via `toString()` and injected into the
 * Obsidian process by {@link evalInObsidian}, so it must be self-contained.
 */

/* v8 ignore start -- Serialized via toString() and executed inside the Obsidian process. Covered by integration tests. */

const CAUSE_INDENT_SIZE = 2;

/**
 * Serializes an error into a string with its full stack trace and recursive
 * cause chain. Nested causes are indented by {@link CAUSE_INDENT_SIZE} spaces
 * per level.
 *
 * @param error - The error to serialize.
 * @param depth - The current nesting depth (used for indentation).
 * @returns A formatted error string.
 */
export function serializeError(error: unknown, depth = 0): string {
  const indent = ' '.repeat(depth * CAUSE_INDENT_SIZE);

  if (!(error instanceof Error)) {
    return `${indent}${String(error)}`;
  }

  const stackOrMessage = error.stack ?? `${error.name}: ${error.message}`;
  let result = stackOrMessage.split('\n').map((line) => `${indent}${line}`).join('\n');

  if (error.cause !== undefined) {
    result += `\n${indent}[cause]:`;
    result += `\n${serializeError(error.cause, depth + 1)}`;
  }

  return result;
}

/* v8 ignore stop */
