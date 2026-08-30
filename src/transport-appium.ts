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
import {
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaptureScreenshotParams } from './capture-screenshot.ts';
import type { MobileInputEnvelope } from './mobile-input.ts';
import type {
  ConsoleCaptureHandle,
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';
import type { WebViewCdpConnection } from './webview-cdp.ts';

import {
  decodeBase64Png,
  isPng
} from './capture-screenshot.ts';
import { errorToString } from './error-to-string.ts';
import { exec } from './exec.ts';
import { TEMP_VAULT_DIR_PREFIX } from './leftover-cleanup.ts';
import { log } from './log.ts';
import {
  buildResolveInputExpression,
  MOBILE_INPUT_BINDING_NAME,
  toCdpInputCommands
} from './mobile-input.ts';
import { connectToWebViewCdp } from './webview-cdp.ts';

/**
 * Session connection info returned by {@link AppiumTransport.getSessionInfo},
 * used to reattach from another process.
 */
export interface AppiumSessionInfo {
  /**
  The device UDID (e.g. `'emulator-5554'`).
   */
  deviceId: string;

  /**
  The Appium/WebDriver session ID.
   */
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
   * Whether registering a vault also prunes the **other** `temp-vault-*`
   * registrations earlier runs left in Obsidian Mobile's `localStorage`.
   *
   * The device-side directories are swept before the app launches (see the
   * factory); this removes their now-dangling registry entries, which are what
   * Obsidian actually enumerates at startup. Unregistering this run's own vault
   * is unaffected — that always happens.
   *
   * @default `true`
   */
  shouldSweepLeftovers?: boolean;

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
const DEFAULT_WEBVIEW_POLL_TIMEOUT_IN_MILLISECONDS = 60_000;
const LAYOUT_READY_POLL_INTERVAL_IN_MILLISECONDS = 500;
const DEFAULT_LAYOUT_READY_POLL_TIMEOUT_IN_MILLISECONDS = 90_000;
const APP_RESTART_DELAY_IN_MILLISECONDS = 2000;
const DEFAULT_APP_ID = 'md.obsidian';
const ADB_VAULT_REMOVE_TIMEOUT_IN_MILLISECONDS = 30_000;

// --- Console capture (Layer 2 of the plugin-load error surfacing, see T88) ---
const CONSOLE_CAPTURE_MARKER_TAG = 'OIT_CAPTURE';
const CONSOLE_CAPTURE_TAIL_MAX_LENGTH = 8000;
const ADB_LOG_MARKER_TIMEOUT_IN_MILLISECONDS = 5000;
const LOGCAT_DUMP_TIMEOUT_IN_MILLISECONDS = 10_000;
/**
 * `adb logcat -v time` lines look like `MM-DD HH:MM:SS.mmm LEVEL/TAG( PID): message`.
 * Keep only the tags Chromium/WebView routes JS `console.*` output and uncaught
 * errors to (`chromium`, the Capacitor console bridge, and native `AndroidRuntime`).
 */
const CONSOLE_CAPTURE_TAG_RE = /\/(?:chromium|AndroidRuntime|Capacitor\/Console)\(/;

/**
 * Base path on an Android device where Obsidian Mobile stores its vaults.
 *
 * Exported because the transport factory sweeps leftover vaults from it before
 * a transport exists (see the repo's L31).
 */
export const DEFAULT_ANDROID_VAULT_BASE_PATH = '/sdcard/Documents/';

const DEFAULT_VAULT_BASE_PATH: Record<string, string> = {
  android: DEFAULT_ANDROID_VAULT_BASE_PATH,
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
   * The host half of the trusted-input channel: a CDP connection to the WebView, independent of the
   * Appium session, opened lazily on first evaluate and reused (see **L39**).
   */
  private inputChannel: null | WebViewCdpConnection = null;
  /**
   * Set once the trusted-input channel is known not to be openable here (iOS, a remote hub, no local
   * `adb`), so the attempt is not repeated on every evaluate.
   */
  private isInputChannelUnavailable = false;
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
  private readonly shouldSweepLeftovers: boolean;
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
    this.shouldSweepLeftovers = config.shouldSweepLeftovers ?? true;
    this.vaultBasePath = config.vaultBasePath ?? DEFAULT_VAULT_BASE_PATH[this.platform] ?? DEFAULT_ANDROID_VAULT_BASE_PATH;
    this.webviewTimeoutInMilliseconds = config.webviewTimeoutInMilliseconds ?? DEFAULT_WEBVIEW_POLL_TIMEOUT_IN_MILLISECONDS;
  }

  /**
   * Begins a console capture by stamping the device log with a unique marker.
   *
   * Uses `adb shell log` to write a marker into `logcat` at capture start so a
   * later {@link AppiumTransport.readConsoleCaptureSince} can slice out
   * everything the WebView logged afterwards — without the invasive `logcat -c`
   * buffer clear.
   *
   * @returns A handle carrying the unique marker.
   */
  public async beginConsoleCapture(): Promise<ConsoleCaptureHandle> {
    const marker = `${CONSOLE_CAPTURE_MARKER_TAG}_${randomUUID()}`;
    await exec(
      ['adb', '-s', this.deviceId, 'shell', 'log', '-t', CONSOLE_CAPTURE_MARKER_TAG, marker],
      { isQuiet: true, shouldIgnoreExitCode: true, timeoutInMilliseconds: ADB_LOG_MARKER_TIMEOUT_IN_MILLISECONDS }
    );
    return { marker };
  }

  /**
   * Captures a PNG screenshot of the device's screen.
   *
   * The image is always the device's native framebuffer — there is no mobile
   * equivalent of the desktop viewport override, so
   * {@link CaptureScreenshotParams.widthInPixels} /
   * {@link CaptureScreenshotParams.heightInPixels} are ignored. Size a mobile
   * capture by choosing an AVD whose screen geometry already matches what the
   * image has to be.
   *
   * @param _params - Capture parameters. Ignored on mobile: `cwd` does not select a window (vault targeting is via localStorage), and the size cannot be overridden.
   * @returns The raw PNG bytes.
   * @throws Error if the driver returns data that is not a PNG.
   */
  public async captureScreenshot(_params: CaptureScreenshotParams): Promise<Uint8Array> {
    const bytes = decodeBase64Png(await this.browser.takeScreenshot());
    if (!isPng(bytes)) {
      throw new Error('Appium screenshot error: takeScreenshot returned data that is not a PNG.');
    }

    return bytes;
  }

  /**
   * Ends the Appium session.
   *
   * Only deletes the session if this transport owns it. Transports created
   * via `attach()` (test workers reusing the global setup's session) skip
   * deletion so the session remains available for the owning process.
   */
  public async dispose(): Promise<void> {
    await this.disposeInputChannel();

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
    await this.ensureInputChannel();

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
   * Dumps `adb logcat` and returns the WebView console/error output logged
   * since the marker from {@link AppiumTransport.beginConsoleCapture}.
   *
   * Filters to the Chromium/WebView tags that carry JS `console.*` output and
   * uncaught errors, and caps the result length. Bounded, post-hoc,
   * failure-path-only — never a live monitor.
   *
   * @param handle - The capture handle (or `undefined` when capture never started).
   * @returns The captured console/error text, or `undefined` if nothing relevant was logged.
   */
  public async readConsoleCaptureSince(handle: ConsoleCaptureHandle | undefined): Promise<string | undefined> {
    if (!handle) {
      return undefined;
    }

    const dump = await exec(
      ['adb', '-s', this.deviceId, 'logcat', '-d', '-v', 'time'],
      { isQuiet: true, shouldIgnoreExitCode: true, timeoutInMilliseconds: LOGCAT_DUMP_TIMEOUT_IN_MILLISECONDS }
    );

    const markerIndex = dump.lastIndexOf(handle.marker);
    const region = markerIndex === -1 ? dump : dump.slice(markerIndex + handle.marker.length);
    const relevant = region
      .split('\n')
      .filter((line) => CONSOLE_CAPTURE_TAG_RE.test(line))
      .join('\n')
      .trim();

    if (!relevant) {
      return undefined;
    }

    return relevant.slice(-CONSOLE_CAPTURE_TAIL_MAX_LENGTH);
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
   * Existing vault registrations in localStorage are preserved (append, not
   * overwrite) — except the **harness's own** `temp-vault-*` registrations from
   * earlier runs, which are pruned when {@link AppiumTransportConfig.shouldSweepLeftovers}
   * is on. Their directories are already gone (the factory sweeps them before
   * the app launches), and it is this registry — not the filesystem — that
   * Obsidian enumerates at startup, so leaving them is what makes each failed
   * run slow the next one down.
   *
   * @param vaultPath - The absolute path to the vault on the host machine.
   */
  public async registerVault(vaultPath: string): Promise<void> {
    log(`[appium-transport] Registering vault: ${vaultPath}`);
    const deviceVaultPath = this.getDeviceVaultPath(vaultPath);

    // Push a minimal .obsidian directory so Obsidian recognizes it as a vault.
    await this.pushObsidianMarker(deviceVaultPath);

    // Switch to WebView and configure localStorage.
    await this.ensureWebViewContext();

    // Invalidate before reload — the page will navigate and the WebView
    // Context may be temporarily unavailable during reload.
    this.isInWebViewContext = false;

    const stalePrefix = this.shouldSweepLeftovers ? `${this.vaultBasePath}${TEMP_VAULT_DIR_PREFIX}` : '';

    await this.browser.execute(
      (path: string, prunePrefix: string) => {
        let existing = JSON.parse(localStorage.getItem('mobile-external-vaults') ?? '[]') as string[];

        if (prunePrefix) {
          const stale = existing.filter((registered) => registered !== path && registered.startsWith(prunePrefix));
          for (const registered of stale) {
            localStorage.removeItem(`enable-plugin-${registered}`);
          }
          existing = existing.filter((registered) => !stale.includes(registered));
        }

        if (!existing.includes(path)) {
          existing.push(path);
        }
        localStorage.setItem('mobile-external-vaults', JSON.stringify(existing));
        localStorage.setItem('mobile-selected-vault', path);
        localStorage.setItem(`enable-plugin-${path}`, 'true');
        location.reload();
      },
      deviceVaultPath,
      stalePrefix
    );

    // Wait for reload + vault initialization.
    await this.waitForLayoutReady();
  }

  /**
   * Unregisters a vault on mobile by removing it from localStorage.
   *
   * Preserves other vault registrations. If the unregistered vault was selected,
   * switches to the first remaining vault (or clears the selection).
   *
   * The vault's **files are then removed from the device over `adb`, whether or
   * not the `localStorage` step succeeded** — deliberately, because the
   * `localStorage` step goes through the WebView and a dead WebView is exactly
   * what most Android failures are. Routing the removal through the app was what
   * made every failed run leak its vault (`Vault cleanup error (non-fatal): no
   * such window`), so the filesystem-level removal must not depend on it.
   *
   * @param vaultPath - The absolute path to the vault on the host machine.
   */
  public async unregisterVault(vaultPath: string): Promise<void> {
    const deviceVaultPath = this.getDeviceVaultPath(vaultPath);

    try {
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
    } catch (error: unknown) {
      log(
        `[appium-transport] Could not deregister ${deviceVaultPath} from localStorage `
          + `(${String(error)}); removing its files anyway.`
      );
    }

    await this.removeDeviceVaultDirectory(deviceVaultPath);
  }

  /**
   * Closes the trusted-input channel, if one is open.
   */
  private async disposeInputChannel(): Promise<void> {
    const channel = this.inputChannel;
    this.inputChannel = null;
    await channel?.dispose();
  }

  /**
   * Opens the trusted-input channel if it is not already open, and re-opens it if the WebView went away.
   *
   * Installs a `Runtime.addBinding` function on the page and services every call to it for the life of the
   * connection. The binding is exposed on *every* execution context of the page, so it survives the
   * `location.reload()` that {@link AppiumTransport.registerVault} performs; only a full app restart, which
   * destroys the WebView target, needs the reconnect below.
   */
  private async ensureInputChannel(): Promise<void> {
    if (this.inputChannel?.isOpen || this.isInputChannelUnavailable) {
      return;
    }

    // The channel is reachable only over local `adb`, so it does not exist on iOS or against a remote hub
    // (BrowserStack). Those are supported transports, so this stays **best-effort**: a run that never
    // Drives input must not fail because the channel could not be opened. A run that *does* drive input
    // Gets a legible error from the renderer's own guard, which names the missing channel.
    if (this.platform !== 'android') {
      this.isInputChannelUnavailable = true;
      return;
    }

    await this.disposeInputChannel();

    try {
      const connection = await connectToWebViewCdp({ appId: this.appId, deviceId: this.deviceId });
      await connection.send('Runtime.enable');
      await connection.send('Runtime.addBinding', { name: MOBILE_INPUT_BINDING_NAME });
      connection.on('Runtime.bindingCalled', (params: Record<string, unknown>) => {
        if (params['name'] !== MOBILE_INPUT_BINDING_NAME) {
          return;
        }

        const payload = params['payload'];
        // Deliberately not awaited: this runs while the renderer's `Execute Script` is still pending, and
        // That is the whole point — the request is serviced concurrently and answered by resolving the
        // Renderer's promise over this same socket. It handles its own failures, so nothing reaches here.
        this.handleInputRequest(connection, typeof payload === 'string' ? payload : '').catch(() => {
          // Unreachable: `handleInputRequest` never rejects.
        });
      });

      this.inputChannel = connection;
      log('[appium-transport] Trusted-input channel open.');
    } catch (error: unknown) {
      // Give up for the life of the transport rather than paying an `adb` round-trip on every eval.
      // A socket that merely *closed* after a successful connect is a different case — `isOpen` is false
      // There while this flag stays unset, so the reconnect above still runs.
      this.isInputChannelUnavailable = true;
      log(`[appium-transport] Trusted input is unavailable on this device: ${errorToString(error)}`);
    }
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
      const obsidianContext = contexts.find((context): context is string => typeof context === 'string' && context.startsWith(WEBVIEW_CONTEXT_PREFIX));

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
   * Services one input request from the renderer: inject, then resolve the renderer's promise.
   *
   * Every failure path still resolves that promise — with an error message the renderer re-throws — because
   * a request that is silently dropped would hang the closure until the whole run times out, and report
   * nothing about why.
   *
   * @param connection - The channel the request arrived on.
   * @param payload - The raw JSON payload the binding was called with.
   */
  private async handleInputRequest(connection: WebViewCdpConnection, payload: string): Promise<void> {
    let requestId = '';
    try {
      const { id, request } = JSON.parse(payload) as MobileInputEnvelope;
      requestId = id;
      await connection.sendAll(toCdpInputCommands(request));
      await connection.send('Runtime.evaluate', { expression: buildResolveInputExpression(id) });
    } catch (error: unknown) {
      const message = errorToString(error);
      log(`[appium-transport] Trusted input failed: ${message}`);
      if (!requestId) {
        return;
      }

      try {
        await connection.send('Runtime.evaluate', { expression: buildResolveInputExpression(requestId, message) });
      } catch {
        // The socket is gone; the renderer's own timeout is the remaining backstop.
      }
    }
  }

  /**
   * Pushes the minimal `.obsidian/app.json` vault marker via `adb push`.
   *
   * `browser.pushFile` (WebDriver base64) is an order of magnitude slower on a
   * cold or loaded emulator — measured at 9–21s per call for this 2-byte marker,
   * versus sub-second over `adb`. This mirrors {@link pushFiles}, which switched
   * to `adb` for the same reason. `mkdir -p` guarantees the parent directory.
   *
   * @param deviceVaultPath - The device-side vault directory path.
   */
  private async pushObsidianMarker(deviceVaultPath: string): Promise<void> {
    const localMarker = join(tmpdir(), `obsidian-marker-${randomUUID()}.json`);
    const remoteMarker = `${deviceVaultPath}/.obsidian/app.json`;

    try {
      await writeFile(localMarker, '{}', 'utf-8');
      await exec(['adb', '-s', this.deviceId, 'shell', 'mkdir', '-p', `${deviceVaultPath}/.obsidian`], { isQuiet: true });
      await exec(['adb', '-s', this.deviceId, 'push', localMarker, remoteMarker], { isQuiet: true });
    } finally {
      await rm(localMarker, { force: true });
    }
  }

  /**
   * Removes a vault directory from the device over `adb`, and CHECKS that it is
   * actually gone.
   *
   * Best-effort: a failure is logged, not thrown, so a teardown problem never
   * masks the test result. The next run's start-of-run sweep picks up whatever
   * this could not remove.
   *
   * The check is the point. `rm -rf` runs with `shouldIgnoreExitCode`, so an
   * unremoved directory used to leave no trace at all — which is how runs that
   * passed end to end were still found to be leaking a vault apiece, invisibly,
   * until someone counted the directories on the device by hand. A leak is now
   * named in the log at the moment it happens.
   *
   * @param deviceVaultPath - The device-side vault directory path.
   */
  private async removeDeviceVaultDirectory(deviceVaultPath: string): Promise<void> {
    try {
      log(`[appium-transport] Removing vault directory from device: ${deviceVaultPath}`);
      await exec(
        ['adb', '-s', this.deviceId, 'shell', 'rm', '-rf', deviceVaultPath],
        { isQuiet: true, shouldIgnoreExitCode: true, timeoutInMilliseconds: ADB_VAULT_REMOVE_TIMEOUT_IN_MILLISECONDS }
      );

      const listing = await exec(
        ['adb', '-s', this.deviceId, 'shell', 'ls', '-d', deviceVaultPath],
        { isQuiet: true, shouldIgnoreExitCode: true, timeoutInMilliseconds: ADB_VAULT_REMOVE_TIMEOUT_IN_MILLISECONDS }
      );

      if (listing.includes(deviceVaultPath)) {
        log(
          `[appium-transport] Warning: ${deviceVaultPath} survived removal and is now leaked residue. `
            + 'The next run\'s start-of-run sweep will retry it.'
        );
      }
    } catch (error: unknown) {
      log(`[appium-transport] Vault directory removal failed (non-fatal): ${String(error)}`);
    }
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
          const app = globalThis.app as LoadingApp | undefined;
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
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return normalized.slice(lastSeparator + 1);
}

/* v8 ignore stop */
