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
  readonly appId?: string;

  /**
   * The Appium server URL (e.g. `'http://localhost:4723'`).
   */
  readonly appiumUrl: string;

  /**
   * The Android AVD (Android Virtual Device) name.
   *
   * The transport factory launches `emulator -avd <avdName>` as a background
   * process and polls until the device appears. The emulator is killed
   * on transport disposal.
   *
   * Run `emulator -list-avds` to see available AVD names.
   */
  readonly avdName: string;

  /**
   * The device UDID to reuse (e.g. `'emulator-5554'`).
   *
   * Populated automatically by the global setup after the Appium session is
   * established. When present alongside {@link sessionId}, the transport
   * factory skips emulator startup and attaches to the existing session.
   */
  readonly deviceId?: string;

  /**
   * An existing Appium session ID to reattach to.
   *
   * Populated automatically by the global setup and provided to test workers
   * via the framework's context mechanism (e.g. Vitest `provide`/`inject`).
   * When present, the transport factory uses WebDriverIO's `attach()` instead
   * of creating a new session, avoiding duplicate Appium/ADB connections.
   */
  readonly sessionId?: string;

  /**
   * Whether to automatically start the Appium server if it is not reachable.
   *
   * When `true` (the default), the transport factory spawns `npx appium`
   * as a background process when the preflight check fails, and kills it
   * on transport disposal.
   *
   * @default `true`
   */
  readonly shouldAutoStartAppium?: boolean;

  /**
   * Discriminant for the transport type.
   */
  readonly type: 'obsidian-android-appium';

  /**
   * Base path on the device where Obsidian stores vaults.
   *
   * Defaults:
   * - Android: `/sdcard/Documents/`
   * - iOS: `@md.obsidian:documents/`
   */
  readonly vaultBasePath?: string;

  /**
   * Timeout in milliseconds for waiting for the WebView context to become available.
   *
   * On slow emulators, the ChromeDriver proxy that handles WebView commands
   * may not be ready immediately after the Appium session starts. This timeout
   * controls how long to poll before giving up.
   *
   * @default `60000`
   */
  readonly webviewTimeoutInMilliseconds?: number;
}

/**
 * Transport options for desktop testing via Chrome DevTools Protocol.
 */
export interface ObsidianCdpTransportOptions {
  /**
   * Timeout in milliseconds for individual CDP commands.
   * Defaults to 30000
   */
  readonly commandTimeoutInMilliseconds?: number;

  /**
   * CDP host.
   * Defaults to `'localhost'`
   */
  readonly host?: string;

  /**
   * CDP port.
   * Defaults to 8315
   */
  readonly port?: number;

  /**
   * Discriminant for the transport type.
   */
  readonly type: 'obsidian-cdp';
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
  readonly type: 'obsidian-cli';
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
