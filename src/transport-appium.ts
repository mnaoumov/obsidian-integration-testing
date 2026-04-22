/**
 * @file
 *
 * Appium transport — evaluates expressions inside Obsidian Mobile via WebView
 * JavaScript injection. Manages vault lifecycle via file push and app restart.
 *
 * This transport works with any Appium client (e.g. WebDriverIO's `remote()`)
 * that satisfies the {@link AppiumBrowser} interface. No `webdriverio` dependency
 * is required in this library — the consumer provides the browser instance.
 *
 * Usage:
 * ```typescript
 * import { remote } from 'webdriverio';
 * import { AppiumTransport } from 'obsidian-integration-testing/transport-appium';
 * import { setTransport } from 'obsidian-integration-testing';
 *
 * const browser = await remote({
 *   hostname: 'localhost',
 *   port: 4723,
 *   capabilities: {
 *     platformName: 'Android',
 *     'appium:automationName': 'UiAutomator2',
 *     'appium:app': '/path/to/obsidian.apk',
 *   },
 * });
 * setTransport(new AppiumTransport({ browser, platform: 'android' }));
 * ```
 *
 * For BrowserStack, point the WebDriverIO `remote()` at the BrowserStack hub URL
 * with the appropriate capabilities — the transport itself is hub-agnostic.
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

/**
 * Minimal interface for an Appium browser/driver instance.
 *
 * Satisfied by WebDriverIO's `Browser` object returned from `remote()`.
 * Only the methods used by the transport are required.
 */
export interface AppiumBrowser {
  /**
   * Launches (or brings to foreground) an app by its package/bundle ID.
   *
   * @param appId - The application identifier.
   */
  activateApp(appId: string): Promise<void>;

  /**
   * Ends the Appium session and releases the device.
   */
  deleteSession(): Promise<void>;

  /**
   * Executes a JavaScript snippet in the current context (NATIVE or WEBVIEW).
   *
   * In a WEBVIEW context, this evaluates JS in the WebView's page.
   *
   * @param script - The script body (function body string).
   * @param args - Arguments passed as `arguments[0]`, `arguments[1]`, etc.
   * @returns The script's return value.
   */
  execute<T>(script: string, args?: unknown[]): Promise<T>;

  /**
   * Returns the list of available contexts (e.g. `['NATIVE_APP', 'WEBVIEW_md.obsidian']`).
   *
   * @returns An array of context identifiers.
   */
  getContexts(): Promise<string[]>;

  /**
   * Pushes a file to the device.
   *
   * @param path - The device-side file path.
   * @param base64Content - The file content as a base64-encoded string.
   */
  pushFile(path: string, base64Content: string): Promise<void>;

  /**
   * Queries the state of an app.
   *
   * Returns a numeric state:
   * - `0` — not installed
   * - `1` — not running
   * - `2` — running in background (suspended)
   * - `3` — running in background
   * - `4` — running in foreground
   *
   * @param appId - The application identifier.
   * @returns The app state code.
   */
  queryAppState(appId: string): Promise<number>;

  /**
   * Switches the driver context (e.g. from NATIVE_APP to WEBVIEW).
   *
   * @param contextId - The context identifier.
   */
  switchContext(contextId: string): Promise<void>;

  /**
   * Stops a running app.
   *
   * @param appId - The application identifier.
   */
  terminateApp(appId: string): Promise<void>;
}

/**
 * Configuration for the Appium transport.
 */
export interface AppiumTransportConfig {
  /**
   * App package (Android) or bundle ID (iOS).
   * Defaults to `'md.obsidian'`.
   */
  appId?: string;

  /**
   * The Appium browser/driver instance.
   * Created by the consumer via e.g. WebDriverIO's `remote()`.
   */
  browser: AppiumBrowser;

  /**
   * Target platform. Determines WebView context naming and device file paths.
   */
  platform: 'android' | 'ios';

  /**
   * Base path on the device where Obsidian stores vaults.
   *
   * Defaults:
   * - Android: `/sdcard/Documents/Obsidian/`
   * - iOS: `@md.obsidian:documents/`
   */
  vaultBasePath?: string;
}

const NO_OUTPUT = '(no output)';
const APP_STATE_FOREGROUND = 4;
const WEBVIEW_POLL_INTERVAL_MS = 500;
const WEBVIEW_POLL_TIMEOUT_MS = 30000;
const LAYOUT_READY_POLL_INTERVAL_MS = 500;
const LAYOUT_READY_POLL_TIMEOUT_MS = 30000;
const APP_RESTART_DELAY_MS = 2000;
const DEFAULT_APP_ID = 'md.obsidian';

const DEFAULT_VAULT_BASE_PATH: Record<string, string> = {
  android: '/sdcard/Documents/Obsidian/',
  ios: '@md.obsidian:documents/'
};

/**
 * Transport that communicates with Obsidian Mobile via Appium WebView JS injection.
 *
 * Evaluates expressions by switching to the Obsidian WebView context and
 * calling `execute()`. Manages vaults by pushing files to the device and
 * restarting the app.
 */
export class AppiumTransport implements ObsidianTransport {
  private readonly appId: string;
  private readonly browser: AppiumBrowser;
  private readonly platform: 'android' | 'ios';
  private readonly vaultBasePath: string;

  /**
   * Creates a new Appium transport.
   *
   * @param config - Appium transport configuration.
   */
  public constructor(config: AppiumTransportConfig) {
    this.browser = config.browser;
    this.platform = config.platform;
    this.appId = config.appId ?? DEFAULT_APP_ID;
    this.vaultBasePath = config.vaultBasePath ?? DEFAULT_VAULT_BASE_PATH[this.platform] ?? '/sdcard/Documents/Obsidian/';
  }

  /**
   * Ends the Appium session.
   */
  public async dispose(): Promise<void> {
    await this.browser.deleteSession();
  }

  /**
   * Evaluates a JavaScript expression inside Obsidian Mobile's WebView.
   *
   * Switches to the WebView context, executes the expression, and returns
   * the result string.
   *
   * @param expression - The JavaScript expression to evaluate.
   * @param _options - Evaluation options (cwd is not used on mobile — vault targeting is via app state).
   * @returns The normalized result string.
   */
  public async evaluate(expression: string, _options: TransportEvalOptions): Promise<string> {
    await this.ensureWebViewContext();

    const result = await this.browser.execute<null | string | undefined>(
      `return (${expression})`
    );

    if (result === undefined || result === null) {
      return NO_OUTPUT;
    }

    return result;
  }

  /**
   * Verifies that the Obsidian app is running and the WebView is available.
   *
   * @param _vaultPath - Not used on mobile.
   */
  public async preflightCheck(_vaultPath: string): Promise<void> {
    const state = await this.browser.queryAppState(this.appId);
    if (state !== APP_STATE_FOREGROUND) {
      await this.browser.activateApp(this.appId);
      await delay(APP_RESTART_DELAY_MS);
    }

    await this.ensureWebViewContext();
  }

  /**
   * Pushes vault files to the device and restarts Obsidian to pick them up.
   *
   * @param vaultPath - The vault path (used as the vault directory name on device).
   * @param files - Map of relative file paths to content strings.
   */
  public async pushFiles(vaultPath: string, files: Record<string, string>): Promise<void> {
    const vaultName = extractVaultName(vaultPath);
    const deviceVaultPath = `${this.vaultBasePath}${vaultName}`;

    for (const [filePath, content] of Object.entries(files)) {
      const deviceFilePath = `${deviceVaultPath}/${filePath}`;
      const base64Content = Buffer.from(content, 'utf-8').toString('base64');
      await this.browser.pushFile(deviceFilePath, base64Content);
    }
  }

  /**
   * Registers a vault on mobile by pushing files and restarting the app.
   *
   * On mobile, vault registration works by:
   * 1. Pushing vault files to the device's Obsidian vault directory
   * 2. Restarting the app so it discovers the new vault
   * 3. Waiting for the WebView and layout to become ready
   *
   * @param vaultPath - The absolute path to the vault on the host machine.
   */
  public async registerVault(vaultPath: string): Promise<void> {
    // Push a minimal .obsidian directory so Obsidian recognizes it as a vault.
    const vaultName = extractVaultName(vaultPath);
    const deviceVaultPath = `${this.vaultBasePath}${vaultName}`;
    const obsidianMarker = `${deviceVaultPath}/.obsidian/app.json`;
    const base64Content = Buffer.from('{}', 'utf-8').toString('base64');
    await this.browser.pushFile(obsidianMarker, base64Content);

    // Restart Obsidian so it discovers the vault.
    await this.restartApp();

    // Wait for the WebView to become available and layout ready.
    await this.ensureWebViewContext();
    await this.waitForLayoutReady();
  }

  /**
   * Unregisters a vault on mobile by restarting the app.
   *
   * Note: File cleanup on the device is not performed automatically.
   * The test harness or CI environment should handle device cleanup.
   *
   * @param _vaultPath - The vault path (not used for cleanup on mobile).
   */
  public async unregisterVault(_vaultPath: string): Promise<void> {
    await this.restartApp();
  }

  /**
   * Switches the driver to the Obsidian WebView context.
   *
   * Polls until a WEBVIEW context becomes available (the app may still be loading).
   */
  private async ensureWebViewContext(): Promise<void> {
    const deadline = Date.now() + WEBVIEW_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const contexts = await this.browser.getContexts();
      const webviewContext = contexts.find((ctx) => ctx.startsWith('WEBVIEW'));

      if (webviewContext) {
        await this.browser.switchContext(webviewContext);
        return;
      }

      await delay(WEBVIEW_POLL_INTERVAL_MS);
    }

    throw new Error(`No WebView context found within ${String(WEBVIEW_POLL_TIMEOUT_MS)}ms. Is the Obsidian app fully loaded?`);
  }

  /**
   * Terminates and relaunches the Obsidian app.
   */
  private async restartApp(): Promise<void> {
    await this.browser.terminateApp(this.appId);
    await delay(APP_RESTART_DELAY_MS);
    await this.browser.activateApp(this.appId);
    await delay(APP_RESTART_DELAY_MS);
  }

  /**
   * Polls until `app.workspace.layoutReady` is `true` in the WebView.
   */
  private async waitForLayoutReady(): Promise<void> {
    const deadline = Date.now() + LAYOUT_READY_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const isReady = await this.browser.execute<boolean>(
          'return typeof app !== "undefined" && app.workspace && app.workspace.layoutReady === true'
        );
        if (isReady) {
          return;
        }
      } catch {
        // App not ready yet.
      }

      await delay(LAYOUT_READY_POLL_INTERVAL_MS);
    }

    throw new Error(`Obsidian layout did not become ready within ${String(LAYOUT_READY_POLL_TIMEOUT_MS)}ms`);
  }
}

/**
 * Returns a promise that resolves after the given delay.
 *
 * @param ms - The delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Extracts the vault directory name from a host-side vault path.
 *
 * @param vaultPath - Absolute path on the host machine.
 * @returns The last path segment (vault directory name).
 */
function extractVaultName(vaultPath: string): string {
  const normalized = vaultPath.replace(/[\\/]+$/, '');
  const lastSep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return normalized.slice(lastSep + 1);
}

/* v8 ignore stop */
