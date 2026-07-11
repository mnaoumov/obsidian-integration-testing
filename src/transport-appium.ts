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
 *     avdName: 'obsidian_test',
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

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { exec } from './exec.ts';
import { log } from './log.ts';

/**
 * Session connection info returned by {@link AppiumTransport.getSessionInfo},
 * used to reattach from another process.
 */
export interface AppiumSessionInfo {
  /** The device UDID (e.g. `'emulator-5554'`). */
  deviceId: string;

  /** The Appium/WebDriver session ID. */
  sessionId: string;
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
  browser: Browser;

  /**
   * The device UDID (e.g. `'emulator-5554'`).
   * Used for `adb` commands when pushing files to the device.
   */
  deviceId: string;

  /**
   * Whether this transport owns the Appium session and should delete it on
   * {@link AppiumTransport.dispose}.
   *
   * `true` for sessions created via `remote()` (global setup).
   * `false` for sessions reattached via `attach()` (test workers).
   *
   * @default `true`
   */
  isSessionOwner?: boolean;

  /**
   * Timeout in milliseconds for waiting for `app.workspace.layoutReady` after
   * the vault is (re)opened.
   *
   * @default `90000`
   */
  layoutReadyTimeoutInMilliseconds?: number;

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

  /**
   * Timeout in milliseconds for waiting for the WebView context to become available.
   *
   * @default `60000`
   */
  webviewTimeoutInMilliseconds?: number;
}

const NO_OUTPUT = '(no output)';
const APP_STATE_FOREGROUND = 4;
const WEBVIEW_CONTEXT_PREFIX = 'WEBVIEW_md.obsidian';
const WEBVIEW_POLL_INTERVAL_IN_MILLISECONDS = 500;
const DEFAULT_WEBVIEW_POLL_TIMEOUT_IN_MILLISECONDS = 60000;
const LAYOUT_READY_POLL_INTERVAL_IN_MILLISECONDS = 500;
const DEFAULT_LAYOUT_READY_POLL_TIMEOUT_IN_MILLISECONDS = 90000;
const APP_RESTART_DELAY_IN_MILLISECONDS = 2000;
const DEFAULT_APP_ID = 'md.obsidian';

const DEFAULT_VAULT_BASE_PATH: Record<string, string> = {
  android: '/sdcard/Documents/',
  ios: '@md.obsidian:documents/'
};

interface LoadingApp {
  workspace?: LoadingWorkspace;
}

interface LoadingWorkspace {
  layoutReady?: boolean;
}

/**
 * Transport that communicates with Obsidian Mobile via Appium WebView JS injection.
 *
 * Evaluates expressions by switching to the `WEBVIEW_md.obsidian` context and
 * calling `execute()`. Manages vaults by writing to the WebView's `localStorage`
 * (which Obsidian uses as its vault registry on mobile) and pushing files to the device.
 */
export class AppiumTransport implements ObsidianTransport {
  /**
   * Indicates whether this transport is for a mobile platform. Always `true` for this transport.
   */
  public readonly isMobile = true;
  private readonly appId: string;
  private readonly browser: Browser;
  private readonly deviceId: string;
  /**
   * Tracks whether the driver is currently switched to the WebView context.
   *
   * Set to `true` after a successful `switchContext(WEBVIEW_md.obsidian)`.
   * Reset to `false` when the context is known to be invalidated
   * (e.g. after `location.reload()` in {@link registerVault}).
   *
   * When `true`, {@link ensureWebViewContext} skips the expensive
   * `getContexts()` call (which runs `adb shell cat /proc/net/unix` and
   * can time out on slow emulators).
   */
  private isInWebViewContext = false;
  private readonly isSessionOwner: boolean;
  private readonly layoutReadyTimeoutInMilliseconds: number;
  private readonly platform: 'android' | 'ios';
  private readonly vaultBasePath: string;

  private readonly webviewTimeoutInMilliseconds: number;

  /**
   * Creates a new Appium transport.
   *
   * @param config - Appium transport configuration.
   */
  public constructor(config: AppiumTransportConfig) {
    this.browser = config.browser;
    this.deviceId = config.deviceId;
    this.isSessionOwner = config.isSessionOwner ?? true;
    this.layoutReadyTimeoutInMilliseconds = config.layoutReadyTimeoutInMilliseconds ?? DEFAULT_LAYOUT_READY_POLL_TIMEOUT_IN_MILLISECONDS;
    this.platform = config.platform;
    this.appId = config.appId ?? DEFAULT_APP_ID;
    this.vaultBasePath = config.vaultBasePath ?? DEFAULT_VAULT_BASE_PATH[this.platform] ?? '/sdcard/Documents/';
    this.webviewTimeoutInMilliseconds = config.webviewTimeoutInMilliseconds ?? DEFAULT_WEBVIEW_POLL_TIMEOUT_IN_MILLISECONDS;
  }

  /**
   * Ends the Appium session.
   *
   * Only deletes the session if this transport owns it. Transports created
   * via `attach()` (test workers reusing the global setup's session) skip
   * deletion so the session remains available for the owning process.
   */
  public async dispose(): Promise<void> {
    if (this.isSessionOwner) {
      await this.browser.deleteSession();
    }
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

    try {
      const result = await this.browser.execute<null | string | undefined, []>(
        `return (${expression})`
      );

      if (result === undefined || result === null) {
        return NO_OUTPUT;
      }

      return result;
    } catch (error: unknown) {
      // Context may have been lost mid-execution (e.g. page reload).
      this.isInWebViewContext = false;
      throw error;
    }
  }

  /**
   * Returns the session connection info needed to reattach to this session
   * from another process (e.g. a test worker).
   *
   * @returns The session ID and device ID.
   */
  public getSessionInfo(): AppiumSessionInfo {
    return {
      deviceId: this.deviceId,
      sessionId: this.browser.sessionId
    };
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
      this.isInWebViewContext = false;
      await this.browser.activateApp(this.appId);
      await delay(APP_RESTART_DELAY_IN_MILLISECONDS);
    }

    await this.ensureWebViewContext();
    log('[appium-transport] Preflight check passed.');
  }

  /**
   * Pushes vault files to the device via compressed `adb push`.
   *
   * Creates a tar.gz archive of the local vault directory, pushes it to the
   * device as a single file, and extracts it in-place. This avoids the
   * webdriver `RangeError` on large base64 payloads and is significantly
   * faster than per-file `browser.pushFile()` calls.
   *
   * @param vaultPath - The vault path (used as the vault directory name on device).
   * @param _files - Map of relative file paths to content buffers (unused — adb pushes the directory directly).
   */
  public async pushFiles(vaultPath: string, _files: Record<string, Uint8Array>): Promise<void> {
    const deviceVaultPath = this.getDeviceVaultPath(vaultPath);
    const archiveName = `vault-${randomUUID()}.tar.gz`;
    const localArchive = join(tmpdir(), archiveName);
    const remoteArchive = `/data/local/tmp/${archiveName}`;

    try {
      log(`[appium-transport] Creating archive: ${localArchive}`);
      await exec(['tar', 'czf', archiveName, '-C', vaultPath, '.'], { cwd: tmpdir(), isQuiet: true });

      log(`[appium-transport] Pushing archive to device ${this.deviceId}...`);
      await exec(['adb', '-s', this.deviceId, 'push', localArchive, remoteArchive], { isQuiet: true });

      log(`[appium-transport] Extracting archive on device at ${deviceVaultPath}...`);
      await exec(['adb', '-s', this.deviceId, 'shell', 'mkdir', '-p', deviceVaultPath], { isQuiet: true });
      await exec(['adb', '-s', this.deviceId, 'shell', 'tar', 'xzf', remoteArchive, '-C', deviceVaultPath], { isQuiet: true });

      log('[appium-transport] Flushing filesystem buffers...');
      await exec(['adb', '-s', this.deviceId, 'shell', 'sync'], { isQuiet: true });

      log('[appium-transport] Cleaning up remote archive...');
      await exec(['adb', '-s', this.deviceId, 'shell', 'rm', remoteArchive], { isQuiet: true });
    } finally {
      await rm(localArchive, { force: true });
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

    // Invalidate before reload — the page will navigate and the WebView
    // Context may be temporarily unavailable during reload.
    this.isInWebViewContext = false;

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
   * If the context was already verified (cached via {@link isInWebViewContext}),
   * returns immediately without calling `getContexts()` — which runs
   * `adb shell cat /proc/net/unix` and can time out on slow emulators.
   *
   * Polls until the context becomes available (the app may still be loading).
   * Uses the `WEBVIEW_md.obsidian` context specifically to avoid connecting
   * to Chrome or other WebViews on the device.
   */
  private async ensureWebViewContext(): Promise<void> {
    if (this.isInWebViewContext) {
      return;
    }

    const deadline = Date.now() + this.webviewTimeoutInMilliseconds;
    log(`[appium-transport] Waiting for ${WEBVIEW_CONTEXT_PREFIX} context (timeout=${String(this.webviewTimeoutInMilliseconds)}ms)...`);

    while (Date.now() < deadline) {
      const contexts = await this.browser.getContexts();
      const obsidianContext = contexts.find((ctx): ctx is string => typeof ctx === 'string' && ctx.startsWith(WEBVIEW_CONTEXT_PREFIX));

      if (obsidianContext) {
        log(`[appium-transport] Found WebView context: ${obsidianContext}`);
        try {
          await this.browser.switchContext(obsidianContext);
          this.isInWebViewContext = true;
          return;
        } catch (error: unknown) {
          log(`[appium-transport] switchContext failed: ${String(error)}. Resetting to NATIVE_APP before retrying...`);
          try {
            await this.browser.switchContext('NATIVE_APP');
          } catch (resetError: unknown) {
            log(`[appium-transport] NATIVE_APP reset also failed: ${String(resetError)}`);
          }
        }
      }

      log(`[appium-transport] WebView not ready, available contexts: ${JSON.stringify(contexts)}. Retrying...`);
      await delay(WEBVIEW_POLL_INTERVAL_IN_MILLISECONDS);
    }

    throw new Error(`No ${WEBVIEW_CONTEXT_PREFIX} context found within ${String(this.webviewTimeoutInMilliseconds)}ms. Is the Obsidian app fully loaded?`);
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
    const start = Date.now();
    const deadline = start + this.layoutReadyTimeoutInMilliseconds;
    log(`[appium-transport] Waiting for layout ready (timeout=${String(this.layoutReadyTimeoutInMilliseconds)}ms)...`);

    while (Date.now() < deadline) {
      try {
        const isReady = await this.browser.execute((): boolean => {
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- We need global `app` variable.
          const app = window.app as LoadingApp | undefined;
          return !!app?.workspace?.layoutReady;
        });
        if (isReady) {
          log(`[appium-transport] Layout is ready after ${String(Date.now() - start)}ms.`);
          this.isInWebViewContext = true;
          return;
        }
      } catch {
        // App not ready yet (page may be reloading).
      }

      log(`[appium-transport] Layout not ready yet (elapsed=${String(Date.now() - start)}ms). Retrying...`);
      await delay(LAYOUT_READY_POLL_INTERVAL_IN_MILLISECONDS);
    }

    throw new Error(`Obsidian layout did not become ready within ${String(this.layoutReadyTimeoutInMilliseconds)}ms`);
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
