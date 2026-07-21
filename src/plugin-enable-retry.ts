/**
 * @file
 *
 * Pure helpers for retrying the plugin-enable step, plus resolving the retry
 * knobs from the transport options. Kept separate from the integration-only
 * `global-setup-core` orchestration so the decision logic and default
 * resolution stay unit-testable (the orchestration itself needs a real
 * transport and is excluded from unit tests).
 *
 * When the harness auto-starts an Android emulator (cold boot) and immediately
 * syncs the vault and enables the plugin, the plugin can land in the enabled set
 * but fail to load — the freshly booted guest's plugin subsystem isn't settled
 * and the single-shot enable races it. Device-idle and `layoutReady` are already
 * gated upstream, so the residual gap is narrow; retrying the enable a few times
 * with backoff recovers the transient race while still failing fast on a genuine
 * plugin bug (a captured load error, which retrying cannot fix).
 */

import type { EnablePluginResult } from './enable-plugin.ts';
import type { ObsidianTransportOptions } from './transport-options.ts';

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.pluginEnableRetryCount}.
 */
export const DEFAULT_PLUGIN_ENABLE_RETRY_COUNT = 3;

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.pluginEnableRetryDelayInMilliseconds}.
 */
export const DEFAULT_PLUGIN_ENABLE_RETRY_DELAY_IN_MILLISECONDS = 2000;

/**
 * The per-retry multiplier for the exponential backoff: each retry waits twice as
 * long as the previous one.
 */
const EXPONENTIAL_BACKOFF_BASE = 2;

/**
 * Computes the exponential backoff delay for a given retry, from a base delay.
 *
 * `attemptIndex` is 0-based: the first retry waits the base delay, the second
 * twice that, the third four times, and so on.
 *
 * @param baseDelayInMilliseconds - The base delay.
 * @param attemptIndex - The 0-based retry index.
 * @returns The delay in milliseconds for this retry.
 */
export function computeBackoffDelayInMilliseconds(baseDelayInMilliseconds: number, attemptIndex: number): number {
  return baseDelayInMilliseconds * (EXPONENTIAL_BACKOFF_BASE ** attemptIndex);
}

/**
 * Resolves the number of extra plugin-enable attempts, applying the default when
 * the option is omitted. Only the Android transport carries the knob; every
 * other transport (and `undefined`) falls back to the default — harmless there,
 * since a plugin that loads on the first try never enters the retry path.
 *
 * A value of `0` disables retry (a single attempt).
 *
 * @param options - The resolved transport options.
 * @returns The retry count.
 */
export function resolvePluginEnableRetryCount(options: null | ObsidianTransportOptions): number {
  return options?.type === 'obsidian-android-appium'
    ? (options.pluginEnableRetryCount ?? DEFAULT_PLUGIN_ENABLE_RETRY_COUNT)
    : DEFAULT_PLUGIN_ENABLE_RETRY_COUNT;
}

/**
 * Resolves the base backoff delay between plugin-enable attempts, applying the
 * default when the option is omitted. See {@link resolvePluginEnableRetryCount}
 * for the transport handling.
 *
 * @param options - The resolved transport options.
 * @returns The base delay in milliseconds.
 */
export function resolvePluginEnableRetryDelayInMilliseconds(options: null | ObsidianTransportOptions): number {
  return options?.type === 'obsidian-android-appium'
    ? (options.pluginEnableRetryDelayInMilliseconds ?? DEFAULT_PLUGIN_ENABLE_RETRY_DELAY_IN_MILLISECONDS)
    : DEFAULT_PLUGIN_ENABLE_RETRY_DELAY_IN_MILLISECONDS;
}

/**
 * Decides whether a failed plugin-enable is a retryable cold-boot race.
 *
 * Retry only the transient swallow signature — the plugin is in the enabled set
 * but not loaded and no cause was captured (neither the `loadPlugin`
 * monkey-patch nor the renderer console surfaced an error). A captured error is
 * a deterministic bug that retrying cannot fix, so it is not retryable.
 *
 * @param result - The enable result from a single attempt.
 * @returns `true` when the enable should be retried.
 */
export function shouldRetryPluginEnable(result: EnablePluginResult): boolean {
  return !result.isLoaded && !result.errorMessage && !result.rendererConsoleErrors;
}
