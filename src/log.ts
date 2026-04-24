/**
 * @file
 *
 * Internal logging helper that prepends local-timezone timestamps to integration-setup messages.
 */

/* v8 ignore start -- Thin logging wrapper, covered by integration tests. */

const DATE_COMPONENT_PAD_LENGTH = 2;
const MILLISECOND_PAD_LENGTH = 3;

/**
 * Logs a timestamped message to stderr via `console.warn`.
 *
 * Uses local timezone for readability.
 *
 * @param message - The message to log.
 */
export function log(message: string): void {
  const timestamp = formatLocalTimestamp(new Date());
  console.warn(`[${timestamp}] ${message}`);
}

/**
 * Formats a date as a local-timezone timestamp string.
 *
 * @param date - The date to format.
 * @returns A string like `2026-04-24 16:41:31.609`.
 */
function formatLocalTimestamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(DATE_COMPONENT_PAD_LENGTH, '0');
  const day = String(date.getDate()).padStart(DATE_COMPONENT_PAD_LENGTH, '0');
  const hours = String(date.getHours()).padStart(DATE_COMPONENT_PAD_LENGTH, '0');
  const minutes = String(date.getMinutes()).padStart(DATE_COMPONENT_PAD_LENGTH, '0');
  const seconds = String(date.getSeconds()).padStart(DATE_COMPONENT_PAD_LENGTH, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(MILLISECOND_PAD_LENGTH, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/* v8 ignore stop */
