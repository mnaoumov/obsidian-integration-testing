/**
 * @file
 *
 * Pure helpers for deciding whether the harness must auto-install the Appium
 * dependencies (the `uiautomator2` driver) before it auto-starts the Appium
 * server, plus resolving the auto-install opt-out from the transport options.
 * Kept separate from the integration-only `transport-factory` so the parsing and
 * default resolution stay unit-testable (the factory itself shells out to `npm`
 * / `npx` and is excluded from unit tests).
 */

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

/**
 * The Appium driver name required to automate Obsidian Mobile on Android.
 */
export const UIAUTOMATOR2_DRIVER_NAME = 'uiautomator2';

/**
 * Parameters for {@link checkIsAppiumDriverInstalled}.
 */
export interface CheckIsAppiumDriverInstalledParams {
  /**
   * Raw stdout of `appium driver list --installed --json` — a JSON object keyed
   * by installed driver name (`{}` when none are installed).
   */
  readonly driverListJson: string;

  /** The driver name to look for (e.g. {@link UIAUTOMATOR2_DRIVER_NAME}). */
  readonly driverName: string;
}

/**
 * Decides whether a given Appium driver is installed, from the raw JSON output
 * of `appium driver list --installed --json`.
 *
 * `--installed` restricts the listing to installed drivers, so a driver is
 * present exactly when its name is a key of the parsed object. Malformed or
 * non-object output (an empty string, a log line that leaked onto stdout, a
 * JSON primitive, `null`) is treated as "not installed" so the caller proceeds
 * to install — the install command is only issued when this returns `false`.
 *
 * @param params - The sampled driver-list output and the driver name to check.
 * @returns `true` when the driver is listed as installed.
 */
export function checkIsAppiumDriverInstalled(params: CheckIsAppiumDriverInstalledParams): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.driverListJson);
  } catch {
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return false;
  }

  return params.driverName in parsed;
}

/**
 * Resolves whether the harness may auto-install missing Appium dependencies,
 * applying the default when the option is omitted.
 *
 * This only governs the machine-mutating install step (a global `npm install -g
 * appium` and an `appium driver install`); it is a no-op unless the harness is
 * also auto-starting the Appium server ({@link
 * ObsidianAndroidAppiumTransportOptions.shouldAutoStartAppium}). Set it to
 * `false` to manage the Appium toolchain yourself.
 *
 * @param options - The Android Appium transport options.
 * @returns Whether missing Appium dependencies may be auto-installed.
 */
export function resolveShouldAutoInstallAppiumDependencies(
  options: ObsidianAndroidAppiumTransportOptions
): boolean {
  return options.shouldAutoInstallAppiumDependencies ?? true;
}
