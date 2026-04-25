/**
 * @file
 *
 * Appium transport — evaluates expressions inside Obsidian Mobile via WebView
 * JavaScript injection. Manages vault lifecycle via localStorage and file push.
 *
 * Configured via `environmentOptions.obsidianTransport` in vitest config:
 *
 * ```typescript
 * // vitest.config.ts
 * environmentOptions: {
 *   obsidianTransport: {
 *     type: 'obsidian-android-appium',
 *     appiumUrl: 'http://localhost:4723',
 *     deviceId: 'emulator-5554',
 *   },
 * }
 * ```
 *
 * For BrowserStack, set `appiumUrl` to the BrowserStack hub URL
 * — the transport itself is hub-agnostic.
 *
 * ## How vault registration works on mobile
 *
 * Obsidian Mobile stores its vault registry in the WebView's `localStorage`:
 *
 * - `mobile-external-vaults` — JSON array of registered vault paths
 * - `mobile-selected-vault` — the currently active vault path
 * - `enable-plugin-<vaultPath>` — `"true"` to enable the plugin system for the vault
 *
 * To register a vault programmatically (without UI interaction):
 *
 * 1. Push vault files to the device (e.g. `/sdcard/Documents/<Name>/.obsidian/app.json`)
 * 2. Switch to `WEBVIEW_md.obsidian` context
 * 3. Set the localStorage entries
 * 4. Call `location.reload()` — Obsidian re-reads localStorage and opens the vault
 *
 * This avoids the onboarding flow entirely.
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import type { Browser } from 'webdriverio';

import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { log } from './log.ts';

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
  browser: Browser;

  /**
   * Target platform. Determines WebView context naming and device file paths.
   */
  platform: 'android' | 'ios';

  /**
   * Base path on the device where Obsidian stores vaults.
   *
   * Defaults:
   * - Android: `/sdcard/Documents/`
   * - iOS: `@md.obsidian:documents/`
   */
  vaultBasePath?: string;
}

const NO_OUTPUT = '(no output)';
const APP_STATE_FOREGROUND = 4;
const WEBVIEW_CONTEXT_PREFIX = 'WEBVIEW_md.obsidian';
const WEBVIEW_POLL_INTERVAL_IN_MILLISECONDS = 500;
const WEBVIEW_POLL_TIMEOUT_IN_MILLISECONDS = 30000;
const LAYOUT_READY_POLL_INTERVAL_IN_MILLISECONDS = 500;
const LAYOUT_READY_POLL_TIMEOUT_IN_MILLISECONDS = 30000;
const APP_RESTART_DELAY_IN_MILLISECONDS = 2000;
const DEFAULT_APP_ID = 'md.obsidian';

const DEFAULT_VAULT_BASE_PATH: Record<string, string> = {
  android: '/sdcard/Documents/',
  ios: '@md.obsidian:documents/'
};

/**
 * Transport that communicates with Obsidian Mobile via Appium WebView JS injection.
 *
 * Evaluates expressions by switching to the `WEBVIEW_md.obsidian` context and
 * calling `execute()`. Manages vaults by writing to the WebView's `localStorage`
 * (which Obsidian uses as its vault registry on mobile) and pushing files to the device.
 */
export class AppiumTransport implements ObsidianTransport {
  /** */
  public readonly isMobile = true;
  private readonly appId: string;
  private readonly browser: Browser;
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
    this.vaultBasePath = config.vaultBasePath ?? DEFAULT_VAULT_BASE_PATH[this.platform] ?? '/sdcard/Documents/';
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
   * Switches to the `WEBVIEW_md.obsidian` context, executes the expression,
   * and returns the result string.
   *
   * @param expression - The JavaScript expression to evaluate.
   * @param _options - Evaluation options (cwd is not used on mobile — vault targeting is via localStorage).
   * @returns The normalized result string.
   */
  public async evaluate(expression: string, _options: TransportEvalOptions): Promise<string> {
    await this.ensureWebViewContext();

    const result = await this.browser.execute<null | string | undefined, []>(
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
    log('[appium-transport] Running preflight check...');
    const state = await this.browser.queryAppState(this.appId);
    log(`[appium-transport] App state: ${String(state)} (need ${String(APP_STATE_FOREGROUND)}=foreground)`);
    if (state !== APP_STATE_FOREGROUND) {
      log(`[appium-transport] Activating app ${this.appId}...`);
      await this.browser.activateApp(this.appId);
      await delay(APP_RESTART_DELAY_IN_MILLISECONDS);
    }

    await this.ensureWebViewContext();
    log('[appium-transport] Preflight check passed.');
  }

  /**
   * Pushes vault files to the device.
   *
   * @param vaultPath - The vault path (used as the vault directory name on device).
   * @param files - Map of relative file paths to content strings.
   */
  public async pushFiles(vaultPath: string, files: Record<string, string>): Promise<void> {
    const deviceVaultPath = this.getDeviceVaultPath(vaultPath);

    for (const [filePath, content] of Object.entries(files)) {
      const deviceFilePath = `${deviceVaultPath}/${filePath.replace(/\\/g, '/')}`;
      const base64Content = Buffer.from(content, 'utf-8').toString('base64');
      await this.browser.pushFile(deviceFilePath, base64Content);
    }
  }

  /**
   * Registers a vault on mobile by pushing files and configuring localStorage.
   *
   * The registration flow:
   * 1. Push a minimal `.obsidian/app.json` to the device so Obsidian recognizes the vault
   * 2. Switch to the WebView context
   * 3. Add the vault to localStorage (`mobile-external-vaults`, `mobile-selected-vault`,
   *    `enable-plugin-<path>`)
   * 4. Trigger `location.reload()` so Obsidian re-reads localStorage and opens the vault
   * 5. Wait for `app.workspace.layoutReady`
   *
   * Existing vault registrations in localStorage are preserved (append, not overwrite).
   *
   * @param vaultPath - The absolute path to the vault on the host machine.
   */
  public async registerVault(vaultPath: string): Promise<void> {
    log(`[appium-transport] Registering vault: ${vaultPath}`);
    const deviceVaultPath = this.getDeviceVaultPath(vaultPath);

    // Push a minimal .obsidian directory so Obsidian recognizes it as a vault.
    const obsidianMarker = `${deviceVaultPath}/.obsidian/app.json`;
    const base64Content = Buffer.from('{}', 'utf-8').toString('base64');
    await this.browser.pushFile(obsidianMarker, base64Content);

    // Switch to WebView and configure localStorage.
    await this.ensureWebViewContext();

    await this.browser.execute((path: string) => {
      const existing = JSON.parse(localStorage.getItem('mobile-external-vaults') ?? '[]') as string[];
      if (!existing.includes(path)) {
        existing.push(path);
        localStorage.setItem('mobile-external-vaults', JSON.stringify(existing));
      }
      localStorage.setItem('mobile-selected-vault', path);
      localStorage.setItem(`enable-plugin-${path}`, 'true');
      location.reload();
    }, deviceVaultPath);

    // Wait for reload + vault initialization.
    await this.waitForLayoutReady();
  }

  /**
   * Unregisters a vault on mobile by removing it from localStorage.
   *
   * Preserves other vault registrations. If the unregistered vault was selected,
   * switches to the first remaining vault (or clears the selection).
   *
   * Note: Vault files on the device are not deleted. The test harness or CI
   * environment should handle device cleanup.
   *
   * @param vaultPath - The absolute path to the vault on the host machine.
   */
  public async unregisterVault(vaultPath: string): Promise<void> {
    const deviceVaultPath = this.getDeviceVaultPath(vaultPath);

    await this.ensureWebViewContext();

    await this.browser.execute((path: string) => {
      const existing = JSON.parse(localStorage.getItem('mobile-external-vaults') ?? '[]') as string[];
      const filtered = existing.filter((v) => v !== path);
      localStorage.setItem('mobile-external-vaults', JSON.stringify(filtered));
      localStorage.removeItem(`enable-plugin-${path}`);
      if (localStorage.getItem('mobile-selected-vault') === path) {
        if (filtered.length > 0) {
          localStorage.setItem('mobile-selected-vault', filtered[0] ?? '');
        } else {
          localStorage.removeItem('mobile-selected-vault');
        }
      }
    }, deviceVaultPath);
  }

  /**
   * Switches the driver to the `WEBVIEW_md.obsidian` context.
   *
   * Polls until the context becomes available (the app may still be loading).
   * Uses the `WEBVIEW_md.obsidian` context specifically to avoid connecting
   * to Chrome or other WebViews on the device.
   */
  private async ensureWebViewContext(): Promise<void> {
    const deadline = Date.now() + WEBVIEW_POLL_TIMEOUT_IN_MILLISECONDS;
    log(`[appium-transport] Waiting for ${WEBVIEW_CONTEXT_PREFIX} context (timeout=${String(WEBVIEW_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);

    while (Date.now() < deadline) {
      const contexts = await this.browser.getContexts();
      const obsidianContext = contexts.find((ctx): ctx is string => typeof ctx === 'string' && ctx.startsWith(WEBVIEW_CONTEXT_PREFIX));

      if (obsidianContext) {
        log(`[appium-transport] Found WebView context: ${obsidianContext}`);
        await this.browser.switchContext(obsidianContext);
        return;
      }

      log(`[appium-transport] WebView not ready, available contexts: ${JSON.stringify(contexts)}. Retrying...`);
      await delay(WEBVIEW_POLL_INTERVAL_IN_MILLISECONDS);
    }

    throw new Error(`No ${WEBVIEW_CONTEXT_PREFIX} context found within ${String(WEBVIEW_POLL_TIMEOUT_IN_MILLISECONDS)}ms. Is the Obsidian app fully loaded?`);
  }

  /**
   * Converts a host-side vault path to the device-side path.
   *
   * @param vaultPath - Absolute path on the host machine.
   * @returns The device-side vault path.
   */
  private getDeviceVaultPath(vaultPath: string): string {
    return `${this.vaultBasePath}${extractVaultName(vaultPath)}`;
  }

  /**
   * Polls until `app.workspace.layoutReady` is `true` in the WebView.
   */
  private async waitForLayoutReady(): Promise<void> {
    const deadline = Date.now() + LAYOUT_READY_POLL_TIMEOUT_IN_MILLISECONDS;
    log(`[appium-transport] Waiting for layout ready (timeout=${String(LAYOUT_READY_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);

    while (Date.now() < deadline) {
      try {
        const isReady = await this.browser.execute<boolean, []>(
          'return typeof app !== "undefined" && app.workspace && app.workspace.layoutReady === true'
        );
        if (isReady) {
          log('[appium-transport] Layout is ready.');
          return;
        }
      } catch {
        // App not ready yet (page may be reloading).
      }

      await delay(LAYOUT_READY_POLL_INTERVAL_IN_MILLISECONDS);
    }

    throw new Error(`Obsidian layout did not become ready within ${String(LAYOUT_READY_POLL_TIMEOUT_IN_MILLISECONDS)}ms`);
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
