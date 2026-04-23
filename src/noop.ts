/**
 * @file
 *
 * No-op functions.
 */

/* v8 ignore start -- Empty-bodied functions are not instrumented by v8 coverage. */

/**
 * No-op function.
 */
export function noop(): void {
  // No-op
}

/**
 * No-op async function.
 *
 * @returns A promise that resolves when the function is complete.
 */
export async function noopAsync(): Promise<void> {
  // No-op
}

/* v8 ignore stop */
