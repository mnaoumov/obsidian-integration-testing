/**
 * @file
 *
 * Discriminated union types for configuring the Obsidian transport
 * via vitest `environmentOptions`.
 */

/**
 * Transport options for Android testing via Appium WebView injection.
 */
export interface ObsidianAndroidAppiumTransportOptions {
  /**
   * App package (Android) or bundle ID (iOS).
   * Defaults to `'md.obsidian'`
   */
  appId?: string;

  /**
   * The Appium server URL (e.g. `'http://localhost:4723'`).
   */
  appiumUrl: string;

  /**
   * The Android AVD (Android Virtual Device) name to auto-start if
   * the device specified by {@link deviceId} is not connected.
   *
   * When provided and the device is not found via `adb devices`, the
   * transport factory launches `emulator -avd <avdName>` as a background
   * process and polls until the device appears. The emulator is killed
   * on transport disposal.
   *
   * Run `emulator -list-avds` to see available AVD names.
   */
  avdName?: string;

  /**
   * The device UDID (e.g. `'emulator-5554'`).
   */
  deviceId: string;

  /**
   * Whether to automatically start the Appium server if it is not reachable.
   *
   * When `true` (the default), the transport factory spawns `npx appium`
   * as a background process when the preflight check fails, and kills it
   * on transport disposal.
   *
   * @default `true`
   */
  shouldAutoStartAppium?: boolean;

  /**
   * Discriminant for the transport type.
   */
  type: 'obsidian-android-appium';

  /**
   * Base path on the device where Obsidian stores vaults.
   *
   * Defaults:
   * - Android: `/sdcard/Documents/`
   * - iOS: `@md.obsidian:documents/`
   */
  vaultBasePath?: string;

  /**
   * Timeout in milliseconds for waiting for the WebView context to become available.
   *
   * On slow emulators, the ChromeDriver proxy that handles WebView commands
   * may not be ready immediately after the Appium session starts. This timeout
   * controls how long to poll before giving up.
   *
   * @default `60000`
   */
  webviewTimeoutInMilliseconds?: number;
}

/**
 * Transport options for desktop testing via Chrome DevTools Protocol.
 */
export interface ObsidianCdpTransportOptions {
  /**
   * Timeout in milliseconds for individual CDP commands.
   * Defaults to 30000
   */
  commandTimeoutInMilliseconds?: number;

  /**
   * CDP host.
   * Defaults to `'localhost'`
   */
  host?: string;

  /**
   * CDP port.
   * Defaults to 8315
   */
  port?: number;

  /**
   * Discriminant for the transport type.
   */
  type: 'obsidian-cdp';
}

/**
 * Transport options for desktop testing via the Obsidian CLI.
 *
 * This is the default transport when no `obsidianTransport` is configured.
 */
export interface ObsidianCliTransportOptions {
  /**
   * Discriminant for the transport type.
   */
  type: 'obsidian-cli';
}

/**
 * Discriminated union of all supported transport configurations.
 *
 * Used in vitest `environmentOptions.obsidianTransport` to select and
 * configure the transport for integration tests.
 */
export type ObsidianTransportOptions =
  | ObsidianAndroidAppiumTransportOptions
  | ObsidianCdpTransportOptions
  | ObsidianCliTransportOptions;
