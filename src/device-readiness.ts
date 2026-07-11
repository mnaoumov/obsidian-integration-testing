/**
 * @file
 *
 * Pure helpers for deciding when a freshly-booted Android emulator is idle
 * enough to establish an Appium session, plus resolving the idle-wait timeout
 * from the transport options. Kept separate from the integration-only
 * `transport-factory` so the parsing and default resolution stay unit-testable
 * (the factory itself needs a real emulator and is excluded from unit tests).
 *
 * `sys.boot_completed` fires *before* the guest is actually idle: package
 * optimization (`dex2oat`) and system services keep churning after it, so a
 * session established the instant it fires makes every one of UiAutomator2's
 * serialized `adb` round-trips contend with that work and inflate ~3x. Gating
 * the session on a later, quieter signal (the boot animation has stopped and
 * the package manager is serving) lets it run against an idle guest instead.
 */

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

const BOOT_ANIMATION_STOPPED_STATE = 'stopped';
const PACKAGE_LINE_PREFIX = 'package:';

/**
 * Default for {@link ObsidianAndroidAppiumTransportOptions.deviceIdleTimeoutInMilliseconds}.
 */
export const DEFAULT_DEVICE_IDLE_TIMEOUT_IN_MILLISECONDS = 60000;

/**
 * Parameters for {@link checkDeviceIdle}.
 */
export interface CheckDeviceIdleParams {
  /** Raw stdout of `adb shell getprop init.svc.bootanim`. */
  readonly bootAnimationProp: string;

  /** Raw stdout of `adb shell cmd package list packages`. */
  readonly packageListOutput: string;
}

/**
 * Decides whether a booted emulator is idle enough to start an Appium session,
 * from the raw output of the two probe commands.
 *
 * The guest is considered idle once the boot animation has stopped **and** the
 * package manager is serving (it lists at least one package). Both are binary,
 * later-than-`sys.boot_completed` signals, so this returns `true` well after the
 * premature boot-completed flag but without any latency thresholds.
 *
 * @param params - The sampled probe outputs.
 * @returns `true` when the guest is idle enough to proceed.
 */
export function checkDeviceIdle(params: CheckDeviceIdleParams): boolean {
  const isBootAnimationStopped = params.bootAnimationProp.trim() === BOOT_ANIMATION_STOPPED_STATE;
  const isPackageManagerReady = params.packageListOutput
    .split('\n')
    .some((line) => line.trim().startsWith(PACKAGE_LINE_PREFIX));
  return isBootAnimationStopped && isPackageManagerReady;
}

/**
 * Resolves the post-boot device-idle wait timeout, applying the default when
 * the option is omitted.
 *
 * This bounds how long the factory waits for a freshly-started emulator to
 * become idle (see {@link checkDeviceIdle}) before establishing the session. A
 * value of `0` skips the wait entirely.
 *
 * @param options - The Android Appium transport options.
 * @returns The timeout in milliseconds.
 */
export function resolveDeviceIdleTimeoutInMilliseconds(
  options: ObsidianAndroidAppiumTransportOptions
): number {
  return options.deviceIdleTimeoutInMilliseconds ?? DEFAULT_DEVICE_IDLE_TIMEOUT_IN_MILLISECONDS;
}
