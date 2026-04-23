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
   * The device UDID (e.g. `'emulator-5554'`).
   */
  deviceId: string;

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

declare module 'vitest' {
  interface EnvironmentOptions {
    /**
     * Configures the transport used by `obsidian-integration-testing` to
     * communicate with a running Obsidian instance.
     *
     * When omitted, defaults to the CLI transport (`obsidian-cli`).
     */
    obsidianTransport?: ObsidianTransportOptions;
  }

  interface ProvidedContext {
    /**
     * Transport options provided by the global setup, consumed by
     * `evalInObsidian` and other library functions via `inject()`.
     */
    obsidianTransport?: ObsidianTransportOptions;

    /**
     * Path to the temporary vault created by the global setup.
     */
    tempVaultPath: string;
  }
}
