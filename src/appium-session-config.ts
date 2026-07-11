/**
 * @file
 *
 * Resolves tunable Appium server-start and session-establishment timeouts from
 * the transport options, applying defaults. Kept separate from the
 * integration-only `transport-factory` so the default resolution stays
 * unit-testable (the factory itself needs a real Appium server and is excluded
 * from unit tests).
 */

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.appiumStartTimeoutInMilliseconds}.
 */
export const DEFAULT_APPIUM_START_TIMEOUT_IN_MILLISECONDS = 180000;

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.sessionConnectionRetryTimeoutInMilliseconds}.
 */
export const DEFAULT_SESSION_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS = 180000;

/**
 * Resolves the auto-started Appium server readiness timeout, applying the
 * default when the option is omitted.
 *
 * This governs how long the factory polls the auto-started Appium server's
 * `/status` endpoint before giving up. Only relevant when the harness
 * auto-starts the server; when attaching to an already-running server the wait
 * is skipped entirely.
 *
 * @param options - The Android Appium transport options.
 * @returns The timeout in milliseconds.
 */
export function resolveAppiumStartTimeoutInMilliseconds(
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.appiumStartTimeoutInMilliseconds ?? DEFAULT_APPIUM_START_TIMEOUT_IN_MILLISECONDS;
}

/**
 * Resolves the Appium session connection retry timeout, applying the default
 * when the option is omitted.
 *
 * This governs how long WebDriverIO's `remote()` waits for the session to be
 * established (UiAutomator2 server install + app launch) — empirically the
 * largest and most load-sensitive step of the Android setup, so it is the knob
 * to raise when session establishment times out on a cold or contended emulator.
 *
 * @param options - The Android Appium transport options.
 * @returns The timeout in milliseconds.
 */
export function resolveSessionConnectionRetryTimeoutInMilliseconds(
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.sessionConnectionRetryTimeoutInMilliseconds ?? DEFAULT_SESSION_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS;
}
