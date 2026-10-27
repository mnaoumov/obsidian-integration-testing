/**
 * @file
 *
 * Converts an error into a human-readable string with its full stack trace,
 * recursive `cause` chain, and the aggregated errors of an `AggregateError`.
 *
 * Used Node-side by the framework global-setup/teardown to log non-fatal
 * cleanup errors. It is a hand-kept copy of `@mnaoumov/typescript-lib`'s `errorToString`
 * (`src/error.ts`) — see the sync rule L17 — so the two stay behaviorally
 * identical without the published package taking a runtime dependency on that library.
 */

/* v8 ignore start -- Hand-kept duplicate of @mnaoumov/typescript-lib's errorToString (see L17); fully covered in that library, with harness regressions beside this copy. */

const STACK_TRACE_PREFIX = '    at';

const STACK_HEADER_PROBE_MESSAGE = 'stack header probe';

interface ErrorLine {
  readonly isFrame: boolean;
  readonly text: string;
}

/**
 * Converts an error to a string representation, including nested causes and the aggregated errors of
 * an `AggregateError`, with indentation.
 *
 * Never throws: if the error cannot be formatted (a throwing getter, a malformed nested error), it falls back to the
 * error's own string and stack, so the error being reported is never hidden behind a failure to report it.
 *
 * @param error - The error to convert to a string.
 * @returns The string representation of the error.
 */
export function errorToString(error: unknown): string {
  try {
    return getErrorLines(error).map((line) => line.text).join('\n');
  } catch (formattingError) {
    return getFallbackErrorString(error, formattingError);
  }
}

function generateNestedErrorLines(nestedError: unknown, title: string): ErrorLine[] {
  const lines = [toTitleLine(title), ...getErrorLines(nestedError).filter((line) => line.text.trim() !== '')];
  return lines.map((line) => line.isFrame ? line : { isFrame: true, text: generateStackTraceLine(line.text) });
}

function generateStackTraceLine(title: string): string {
  return `${STACK_TRACE_PREFIX} --- ${title} --- (0)`;
}

/**
 * Builds the `Name: message` header the way V8 writes it into `.stack` (a bare `Name` for an empty message).
 *
 * @param error - The error.
 * @returns The header, which spans several lines when the message does.
 */
function getErrorHeader(error: Error): string {
  return error.message ? `${error.name}: ${error.message}` : error.name;
}

function getErrorLines(error: unknown): ErrorLine[] {
  if (!(error instanceof Error)) {
    return String(error).split('\n').map((text) => toTitleLine(text));
  }

  const lines = getOwnErrorLines(error);
  if (error.cause !== undefined) {
    lines.push(...generateNestedErrorLines(error.cause, 'Caused by:'));
  }
  // A subclass, a cross-realm instance or a re-wrapped one can pass `instanceof AggregateError` without an `errors` array.
  const aggregatedErrors: unknown = error instanceof AggregateError ? error.errors : undefined;
  if (Array.isArray(aggregatedErrors)) {
    for (const [index, aggregatedError] of aggregatedErrors.entries()) {
      lines.push(...generateNestedErrorLines(aggregatedError, `Aggregated error #${String(index + 1)}:`));
    }
  }
  return lines;
}

/**
 * Builds the last-resort representation of an error that {@link errorToString} failed to format.
 *
 * @param error - The error that could not be formatted.
 * @param formattingError - What the formatter threw.
 * @returns The error's string, its stack when it has one, and a note naming the formatting failure.
 */
function getFallbackErrorString(error: unknown, formattingError: unknown): string {
  const errorString = safeToString(() => String(error));
  const stack = safeToString(() => error instanceof Error ? error.stack ?? '' : '');
  const lines = stack.startsWith(errorString) ? [stack] : [errorString, stack];
  lines.push(`(errorToString could not format this error: ${safeToString(() => String(formattingError))})`);
  return lines.filter((line) => line !== '').join('\n');
}

function getOwnErrorLines(error: Error): ErrorLine[] {
  const headerLines = getErrorHeader(error).split('\n').map((text) => toTitleLine(text));
  if (error.stack === undefined) {
    return headerLines;
  }

  const stackLines = error.stack.split('\n');
  // On an engine without a header line, the `.stack` is frames only, in its own `name@url:line:col` form, so the message is nowhere in it:
  // Prepend the header, and take every stack line as a frame.
  return hasStackHeader()
    ? stackLines.map((text) => ({ isFrame: text.startsWith(STACK_TRACE_PREFIX), text }))
    : [...headerLines, ...stackLines.filter((text) => text.trim() !== '').map((text) => ({ isFrame: true, text }))];
}

/**
 * Answers whether this engine's `.stack` opens with the error's `Name: message` header line.
 *
 * V8 writes one; JavaScriptCore (every Apple platform, so Obsidian on iOS and iPadOS) and SpiderMonkey write frames only.
 * The answer belongs to the engine, not the platform, so it is probed rather than read off `Platform`. It is probed on every
 * call rather than cached, because `Error.prepareStackTrace` can reshape V8's stack at runtime, and one extra `Error` costs
 * nothing on a path that is already handling one.
 *
 * @returns `true` if `.stack` carries the header line.
 */
function hasStackHeader(): boolean {
  const firstLine = new Error(STACK_HEADER_PROBE_MESSAGE).stack?.split('\n', 1)[0];
  return firstLine === `Error: ${STACK_HEADER_PROBE_MESSAGE}`;
}

function safeToString(toString: () => string): string {
  try {
    return toString();
  } catch {
    return '<unprintable>';
  }
}

function toTitleLine(text: string): ErrorLine {
  return { isFrame: false, text };
}

/* v8 ignore stop */
