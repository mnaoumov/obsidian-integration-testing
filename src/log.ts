/**
 * @file
 *
 * Internal logging helper that prepends ISO timestamps to integration-setup messages.
 */

/* v8 ignore start -- Thin logging wrapper, covered by integration tests. */

/**
 * Logs a timestamped message to stderr via `console.warn`.
 *
 * @param message - The message to log.
 */
export function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] ${message}`);
}

/* v8 ignore stop */
