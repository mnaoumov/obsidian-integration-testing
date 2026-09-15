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

import { DEFAULT_EVAL_CAP_IN_MILLISECONDS } from './eval-cap.ts';

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.appiumStartTimeoutInMilliseconds}.
 */
export const DEFAULT_APPIUM_START_TIMEOUT_IN_MILLISECONDS = 180_000;

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.sessionConnectionRetryTimeoutInMilliseconds}.
 */
export const DEFAULT_SESSION_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS = 180_000;

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
  // eslint-disable-next-line obsidian-dev-utils/params-options-name-match -- Permanent: `ObsidianAndroidAppiumTransportOptions` is one transport options bag read by six helpers, so no per-owner name can satisfy them all.
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.appiumStartTimeoutInMilliseconds ?? DEFAULT_APPIUM_START_TIMEOUT_IN_MILLISECONDS;
}

/**
 * Resolves the per-script (per-`evalInObsidian`) timeout, applying the default
 * when the option is omitted.
 *
 * This is what `AppiumTransport.evaluate` enforces on the Node side; it is also
 * sent as the W3C `timeouts.script` capability, which was measured to be
 * accepted and never acted on. It is deliberately NOT the knob to reach for when
 * a closure times out: the closure is what should get shorter, with the waiting
 * moved to Node via `pollInObsidian`.
 *
 * The default is {@link DEFAULT_EVAL_CAP_IN_MILLISECONDS}, the shared per-eval
 * cap, rather than an Android-specific number: the protocol default WebDriver
 * would nominally apply was measured not to be applied at all on this driver, so
 * this is the only number that actually bounds an Android eval — which makes it
 * the same policy the desktop transport enforces, not a coincidence.
 *
 * @param options - The Android Appium transport options.
 * @returns The timeout in milliseconds.
 */
export function resolveScriptTimeoutInMilliseconds(
  // eslint-disable-next-line obsidian-dev-utils/params-options-name-match -- Permanent: `ObsidianAndroidAppiumTransportOptions` is one transport options bag read by six helpers, so no per-owner name can satisfy them all.
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.scriptTimeoutInMilliseconds ?? DEFAULT_EVAL_CAP_IN_MILLISECONDS;
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
  // eslint-disable-next-line obsidian-dev-utils/params-options-name-match -- Permanent: `ObsidianAndroidAppiumTransportOptions` is one transport options bag read by six helpers, so no per-owner name can satisfy them all.
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.sessionConnectionRetryTimeoutInMilliseconds ?? DEFAULT_SESSION_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS;
}
