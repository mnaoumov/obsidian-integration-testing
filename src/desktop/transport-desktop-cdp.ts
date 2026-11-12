/**
 * @file
 *
 * Desktop CDP transport — evaluates expressions via Chrome DevTools Protocol
 * over WebSocket and manages vaults via Electron IPC.
 *
 * Two modes:
 * - **Owned (default)**: the transport launches and owns an isolated Obsidian
 *   instance against a temporary `--user-data-directory` on a free `--remote-debugging-port`,
 *   never touching the user's Obsidian. Supports version pinning via the user-data asar.
 * - **Attach**: when an explicit CDP port is configured, the transport connects
 *   to an already-running Obsidian on that port.
 *
 * It connects to page targets, sends `Runtime.evaluate` commands, and routes to
 * the correct vault target using `getBasePath()` probing.
 *
 * Requirements: Node.js 22+ (uses built-in `WebSocket` and `fetch` globals).
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import type { CaptureScreenshotParams } from '../capture/capture-screenshot.ts';
import type {
  ObsidianTransport,
  TransportEvalOptions
} from '../transport/transport.ts';
import type { AsarFallback } from './compatibility/asar-fallback-detection.ts';
import type { ElectronCompatibility } from './compatibility/electron-compatibility.ts';
import type { InstallerCompatibility } from './compatibility/installer-compatibility.ts';
import type { RendererBootObservation } from './compatibility/renderer-boot-detection.ts';
import type { OwnedObsidianInstance } from './owned-instance/obsidian-instance.ts';
import type { StartupPluginLoad } from './owned-instance/startup-plugin-load.ts';

import {
  buildDeviceMetricsOverride,
  decodeBase64Png,
  isPng
} from '../capture/capture-screenshot.ts';
import { errorToString } from '../error-to-string.ts';
import { EvalCapExceededError } from '../eval/eval-cap-exceeded-error.ts';
import { DEFAULT_EVAL_CAP_IN_MILLISECONDS } from '../eval/eval-cap.ts';
import { log } from '../log.ts';
import { ensureNamespaceBootstrapped } from '../namespace/namespace-bootstrap.ts';
import { exec } from '../process/exec.ts';
import { killProcessTreeByPidAsync } from '../process/kill-process-tree.ts';
import {
  OWNED_NEVER_BACKGROUND_LAUNCH_FLAGS,
  resolveSandboxLaunchArguments,
  shouldHideObsidianApp
} from '../transport/visibility.ts';
import { ensureNonNullable } from '../type-guards.ts';
import {
  didRemoveVaultFromConfig,
  getVaultId,
  isVaultRegistered
} from '../vault/obsidian-config.ts';
import { checkIsVaultListed } from '../vault/vault-list-membership.ts';
import {
  areVaultPathsMatching,
  normalizeVaultPathForComparison
} from '../vault/vault-path-match.ts';
import { shouldTearDownVaultWindow } from '../vault/vault-teardown-verdict.ts';
import { CdpCommandTimeoutError } from './cdp-command-timeout-error.ts';
import { resolveAsarFallback } from './compatibility/asar-fallback-detection.ts';
import { resolveAsarFallbackAction } from './compatibility/compatibility-options.ts';
import { resolveElectronCompatibility } from './compatibility/electron-compatibility.ts';
import {
  DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS,
  resolveRendererBootState
} from './compatibility/renderer-boot-detection.ts';
import { RendererFailedToInitializeError } from './compatibility/renderer-failed-to-initialize-error.ts';
import { SilentAsarFallbackError } from './compatibility/silent-asar-fallback-error.ts';
import { ConfigDirectoryFallbackError } from './config-directory-fallback-error.ts';
import { DISMISS_TRUST_DIALOG_EXPR } from './dismiss-trust-dialog.ts';
import { DETERMINISTIC_RASTER_LAUNCH_FLAGS } from './owned-instance/deterministic-raster.ts';
import { resolveObsidianExecutable } from './owned-instance/obsidian-executable.ts';
import {
  launchOwnedObsidianInstance,
  listOwnedInstancePortOwnerPidsAsync
} from './owned-instance/obsidian-instance.ts';
import { readOwnedInstanceExitMarker } from './owned-instance/owned-instance-exit-marker.ts';
import {
  buildOwnedInstanceExitedErrorFromMarker,
  OwnedInstanceExitedError
} from './owned-instance/owned-instance-exited-error.ts';
import { buildOwnedObsidianJson } from './owned-instance/owned-vault-seed.ts';
import { buildParentLivenessWatchdogExpression } from './owned-instance/parent-liveness.ts';
import { holdPersistentProfileUpdates } from './owned-instance/persistent-profile-updates.ts';
import {
  acquirePersistentProfileLock,
  mergePersistentObsidianJson
} from './owned-instance/persistent-profile.ts';
import {
  buildEnableCommunityPluginsAndReloadExpression,
  checkShouldReloadForStartupPlugins,
  parseStartupPluginLoad,
  STARTUP_PLUGIN_LOAD_PROBE_EXPRESSION
} from './owned-instance/startup-plugin-load.ts';
import { getVersionMetadata } from './versions/obsidian-metadata.ts';
import { copyAsarIntoUserData } from './versions/obsidian-version-switch.ts';

/**
 * Configuration for the CDP transport.
 */
export interface DesktopCdpTransportConfig {
  /**
   * CDP host. Defaults to `'localhost'`.
   */
  readonly cdpHost?: string;

  /**
   * CDP port for **attach** mode (the `--remote-debugging-port` the running
   * Obsidian was launched with). In owned-instance mode this is ignored — a
   * free port is chosen at launch.
   */
  readonly cdpPort?: number;

  /**
   * Timeout in milliseconds for individual CDP commands, HTTP target reads and
   * WebSocket handshakes. Owned startup also caps these by its remaining readiness budget.
   *
   * A test's closure travels as one `Runtime.evaluate` command, so this is also
   * the desktop per-eval cap. The default is `DEFAULT_EVAL_CAP_IN_MILLISECONDS`,
   * exported from the package root — import it rather than restating the number,
   * so a closure sized against the cap follows it if it ever moves.
   *
   * @default `30000`
   */
  readonly commandTimeoutInMilliseconds?: number;

  /**
   * The vault's config folder override (Obsidian's *Override config folder*),
   * e.g. `'.obsidian-desktop'`. When set, the owned instance boots to the
   * starter screen, writes `<vaultId>-config` into that renderer's
   * `localStorage`, and only then opens the vault over the `vault-open` IPC —
   * the override is read once, during the vault renderer's own setup, so it has
   * to exist before that window is created. The opened vault's actual
   * `app.vault.configDir` is then read back, and a mismatch throws
   * {@link ConfigDirectoryFallbackError}. Only meaningful in owned mode.
   *
   * @default `undefined` (Obsidian's own default, `.obsidian`)
   */
  readonly configDirectory?: string;

  /**
   * Grace window in milliseconds for fast-failing a dead boot of the owned
   * instance (empty `<body>` with no `window.app` after the renderer reached
   * `document.readyState` `'complete'`). Defaults to
   * {@link DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS}. `0` disables fast-fail.
   */
  readonly deadBootGraceInMilliseconds?: number;

  /**
   * When attaching (i.e. {@link cdpPort} is set), marks the target as a
   * **harness-owned, already-prepared** instance. Suppresses the user-scope
   * vault-registration preflight, since the owned instance's vault lives in an
   * isolated user-data config rather than the user-scope registry.
   */
  readonly isHarnessOwnedInstance?: boolean;

  /**
   * Whether the owned Obsidian window is shown on screen. When `false` (the
   * default), the owned instance is launched with keep-alive Chromium flags and
   * its window is moved off-screen after launch. Only meaningful in owned mode;
   * attach mode never touches the (user's) window.
   *
   * @default `true`
   */
  readonly isObsidianAppVisible?: boolean;

  /**
   * When set, the transport launches and owns an isolated Obsidian instance
   * instead of attaching to a running one. This is the default desktop mode.
   */
  readonly ownedInstance?: OwnedInstanceConfig;

  /**
   * Whether to launch the owned instance with Chromium's sandbox disabled
   * (`--no-sandbox`). Needed to boot on Linux without a correctly-configured
   * setuid `chrome-sandbox` helper (e.g. an extracted portable shell, or CI as a
   * non-root user); harmless on Windows/macOS. Only meaningful in owned mode.
   *
   * @default `false`
   */
  readonly shouldDisableSandbox?: boolean;

  /**
   * Whether a post-boot **silent asar fallback** (the running app version differs
   * from the swapped-in pin) fails fast with {@link SilentAsarFallbackError}. The
   * verdict is always computed and surfaced via
   * {@link DesktopCdpTransport.getAsarFallback}; this gates only the throw. Only
   * meaningful in owned mode running a swapped-in asar.
   *
   * @default `true`
   */
  readonly shouldThrowOnSilentAsarFallback?: boolean;

  /**
   * Whether the post-boot runtime-Electron compatibility nag warning is emitted
   * when the live Electron is below the app's recommended minimum. The verdict is
   * always computed and surfaced via {@link DesktopCdpTransport.getElectronCompatibility};
   * this only gates the log. Only meaningful in owned mode.
   *
   * @default `true`
   */
  readonly shouldWarnOnCompatibilityIssues?: boolean;
}

/**
 * An asar to provision into a harness-owned instance's user-data directory before launch.
 */
export interface OwnedInstanceAsar {
  /**
  Absolute path to the cached/source asar file.
   */
  readonly path: string;

  /**
  The asar's `x.y.z` version.
   */
  readonly version: string;
}

/**
 * Configuration for a harness-owned, isolated Obsidian instance.
 *
 * When present, the transport launches and owns its own Obsidian process
 * against an isolated user-data directory instead of attaching to a running instance.
 */
export interface OwnedInstanceConfig {
  /**
  Optional asar to provision into {@link userDataDirectory} before launch.
   */
  readonly asar?: OwnedInstanceAsar | undefined;

  /**
   * The resolved installer↔app compatibility verdict, when it could be determined
   * (an asar-swap onto a known shell version). Surfaced by
   * {@link DesktopCdpTransport.getCompatibility}. An `'unrunnable'` verdict reaches
   * this surface only when the proactive throw is disabled
   * (`shouldThrowOnIncompatibleInstaller: false`); otherwise it throws
   * `IncompatibleInstallerVersionError` before the config is built.
   */
  readonly compatibility?: InstallerCompatibility | undefined;

  /**
  Absolute path to the Obsidian shell executable to launch.
   */
  readonly exePath: string;

  /**
   * Whether {@link userDataDirectory} is a persistent profile the caller keeps (the
   * `persistentUserDataDirectory` option): the transport then merges into its
   * `obsidian.json` instead of overwriting it, holds a lock on it while the instance
   * runs, and never deletes it.
   *
   * @default `false`
   */
  readonly isPersistentUserDataDirectory?: boolean;

  /**
   * Absolute path to the user-data directory. A temporary one is created and owned
   * by the transport, and deleted on dispose; a persistent one
   * ({@link isPersistentUserDataDirectory}) is kept.
   */

  readonly userDataDirectory: string;
}

/**
 * The CDP endpoint of a launched, harness-owned instance.
 */
export interface OwnedInstanceEndpoint {
  /**
  CDP host (e.g. `'localhost'`).
   */
  readonly host: string;

  /**
  The free CDP port the owned instance was launched on.
   */
  readonly port: number;
}

interface CdpExceptionDetails {
  readonly exception?: CdpExceptionObject;
  readonly text: string;
}

interface CdpExceptionObject {
  readonly description?: string;
}

interface CdpResponse {
  readonly error?: CdpResponseError;
  readonly id: number;
  readonly result?: CdpResponseResult;
}

interface CdpResponseError {
  readonly message: string;
}

interface CdpResponseResult {
  /**
   * The base64-encoded image returned by `Page.captureScreenshot`.
   */
  readonly data?: string;
  readonly exceptionDetails?: CdpExceptionDetails;
  readonly result?: CdpValue;
}

interface CdpTarget {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface CdpValue {
  readonly type: string;
  readonly value?: unknown;
}

interface DesktopCdpTransportSeedOwnedObsidianJsonParams {
  readonly config: OwnedInstanceConfig;
  readonly shouldAutoOpenVault: boolean;
  readonly vaultId: string;
  readonly vaultPath: string;
}

/**
 * A window of the running instance with a vault open, and the vault it reported.
 */
interface OpenVaultWindow {
  readonly target: CdpTarget;
  readonly vaultPath: string;
}

/**
 * A command waiting for its reply: settles the caller's promise and cancels the
 * timeout that would otherwise fail it.
 */
type PendingCommand = (response: CdpResponse) => void;

const VAULT_ID_BYTE_LENGTH = 8;
const USER_DATA_RM_TIMEOUT_IN_MILLISECONDS = 10_000;
const USER_DATA_RM_RETRY_INTERVAL_IN_MILLISECONDS = 500;
// A survivor of the owned kill is re-killed this many times before dispose stops trying and reports it.
const OWNED_SURVIVOR_KILL_ROUND_COUNT = 3;
const OWNED_SURVIVOR_SETTLE_IN_MILLISECONDS = 1000;
const NO_OUTPUT = '(no output)';
const VAULT_POLL_INTERVAL_IN_MILLISECONDS = 500;
const VAULT_POLL_TIMEOUT_IN_MILLISECONDS = 30_000;
// Old (Electron 10-era) Obsidian occasionally boots without the workspace ever
// initializing, so the vault never becomes ready. A fresh instance is an
// independent chance; relaunch up to this many times before giving up.
const OWNED_LAUNCH_MAX_ATTEMPTS = 3;
// Brief settle before a relaunch so the killed instance's memory/handles are
// reclaimed before the next boot — improves the odds on a loaded machine.
const OWNED_RELAUNCH_SETTLE_IN_MILLISECONDS = 3000;
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 1000;
const AUTO_START_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const AUTO_START_TIMEOUT_IN_MILLISECONDS = 30_000;
const INSTANCE_EXIT_SETTLE_DELAY_IN_MILLISECONDS = 500;
// How long to wait for the starter screen's renderer to expose `localStorage`
// and `window.electron.ipcRenderer` — the two things the config-folder override
// needs. CDP already serves a page target by the time the launch resolves, so
// this only covers the renderer finishing its own script evaluation.
const STARTER_SCREEN_TIMEOUT_IN_MILLISECONDS = 30_000;
const STARTER_SCREEN_POLL_INTERVAL_IN_MILLISECONDS = 250;
const OWNED_WINDOW_OFFSCREEN_MARGIN_IN_PIXELS = 200;
const OWNED_WINDOW_HIDE_TIMEOUT_IN_MILLISECONDS = 20_000;
const OWNED_WINDOW_HIDE_POLL_INTERVAL_IN_MILLISECONDS = 250;
// A persistent profile's instance is asked to quit before the hard kill, so Chromium writes its storage to disk; this bounds the wait for it to exit.
// One quit took 15.0 s under bulk load (2026-11-05), so the budget has twice that.
const PERSISTENT_PROFILE_QUIT_TIMEOUT_IN_MILLISECONDS = 30_000;
const PERSISTENT_PROFILE_QUIT_POLL_INTERVAL_IN_MILLISECONDS = 250;
const PERSISTENT_PROFILE_CLOSE_DELAY_IN_MILLISECONDS = 200;

/**
 * Transport that communicates with Desktop Obsidian via Chrome DevTools Protocol.
 *
 * Connects to Obsidian's CDP WebSocket endpoint, sends `Runtime.evaluate`
 * commands, and routes expressions to the correct vault target.
 */
export class DesktopCdpTransport implements ObsidianTransport {
  /**
   * Indicates whether this transport is for a mobile platform. Always `false` for this transport.
   */
  public readonly isMobile = false;
  private activeVaultPath: null | string = null;
  private asarFallback: AsarFallback | undefined;
  private readonly cdpHost: string;
  private cdpPort: number;
  private cdpUrl: string;
  private readonly commandTimeoutInMilliseconds: number;
  private readonly configDirectory: string | undefined;
  private readonly deadBootGraceInMilliseconds: number;
  private electronCompatibility: ElectronCompatibility | undefined;
  private readonly isHarnessOwnedInstance: boolean;
  private readonly isObsidianAppVisible: boolean;
  private messageId = 0;
  private readonly ownedConfig: OwnedInstanceConfig | undefined;
  private ownedInstance: OwnedObsidianInstance | undefined;
  // Startup operations share the readiness deadline instead of each spending a fresh command budget.
  private ownedReadinessDeadline: number | undefined;
  /**
   * The in-flight commands of every socket this transport has opened, keyed by
   * the CDP message id each is waiting for. One entry per command, added by
   * {@link sendCommand} and removed by whichever of the reply and the timeout
   * comes first — see {@link getPendingCommands} for why this exists at all.
   *
   * Weak by socket so a closed temporary connection is collectable with its
   * pending map; the dispatcher listener is the socket's own, so nothing here
   * keeps it alive.
   */
  private readonly pendingCommandsBySocket = new WeakMap<WebSocket, Map<number, PendingCommand>>();
  /**
   * Self-registered vault paths, normalized like {@link selfRegisteredVaultPaths}, that the instance's
   * registry already listed before this transport sent `vault-open` for them: a vault the user keeps in the
   * vault list but did not have open. Tearing one down closes the window this transport opened and leaves its
   * registry entry alone, because `vault-remove` would drop it from the user's vault list.
   */
  private readonly preRegisteredVaultPaths = new Set<string>();
  // Releases the persistent profile's lock; set while an owned instance holds one.
  private releasePersistentProfileLock: (() => void) | undefined;
  // Puts back the persistent profile's held-aside updater state; set while a run holds it.
  private restorePersistentProfileUpdates: (() => void) | undefined;
  /**
   * Vault paths THIS transport opened via {@link registerVault}, normalized by
   * {@link normalizeVaultPathForComparison}. A worker attached to a
   * harness-owned instance may tear down only these — every other vault in that
   * instance belongs to the global setup that launched it (see
   * {@link shouldTearDownVaultWindow}).
   */
  private readonly selfRegisteredVaultPaths = new Set<string>();
  private readonly shouldDisableSandbox: boolean;
  private readonly shouldThrowOnSilentAsarFallback: boolean;
  private readonly shouldWarnOnCompatibilityIssues: boolean;
  private ws: null | WebSocket = null;

  /**
   * Creates a new CDP transport.
   *
   * @param config - CDP connection configuration.
   */
  public constructor(config?: DesktopCdpTransportConfig) {
    // Destructure with per-field defaults (each applies when the field is omitted,
    // exactly like the former `config?.x ?? default`) so the constructor stays
    // under the cyclomatic-complexity limit as fields are added.
    const {
      cdpHost = 'localhost',
      cdpPort,
      // A test's closure travels as one `Runtime.evaluate` CDP command, so the
      // command budget IS the per-eval cap on this transport — hence the shared
      // constant rather than a desktop-specific number that happens to match.
      commandTimeoutInMilliseconds = DEFAULT_EVAL_CAP_IN_MILLISECONDS,
      configDirectory,
      deadBootGraceInMilliseconds = DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS,
      isHarnessOwnedInstance = false,
      isObsidianAppVisible = true,
      ownedInstance,
      shouldDisableSandbox = false,
      shouldThrowOnSilentAsarFallback = true,
      shouldWarnOnCompatibilityIssues = true
    } = config ?? {};
    this.cdpHost = cdpHost;
    this.commandTimeoutInMilliseconds = commandTimeoutInMilliseconds;
    this.configDirectory = configDirectory;
    this.deadBootGraceInMilliseconds = deadBootGraceInMilliseconds;
    this.isHarnessOwnedInstance = isHarnessOwnedInstance;
    this.isObsidianAppVisible = isObsidianAppVisible;
    this.ownedConfig = ownedInstance;
    this.shouldDisableSandbox = shouldDisableSandbox;
    this.shouldThrowOnSilentAsarFallback = shouldThrowOnSilentAsarFallback;
    this.shouldWarnOnCompatibilityIssues = shouldWarnOnCompatibilityIssues;
    // Owned mode picks a free port at launch (assigned in registerVault).
    // Attach mode connects to the configured port; no port is hardcoded.
    this.cdpPort = cdpPort ?? 0;
    this.cdpUrl = cdpPort === undefined ? '' : `http://${cdpHost}:${String(cdpPort)}`;
  }

  /**
   * Captures a PNG screenshot of the Obsidian window showing the given vault.
   *
   * When a size is requested the viewport is pinned to it with
   * `Emulation.setDeviceMetricsOverride` for the duration of the capture, so the
   * emitted PNG is exactly that size whatever size the window happens to be —
   * and the override is always cleared afterwards, including when the capture
   * throws, so a failed capture cannot leave the window stuck at the override.
   *
   * @param params - Which vault window to capture, and the exact size to capture it at.
   * @returns The raw PNG bytes.
   * @throws Error if CDP returns no image data, or data that is not a PNG.
   */
  // eslint-disable-next-line typescript-dev-toolkit/params-options-name-match -- Permanent: `CaptureScreenshotParams` is one bag shared by the `captureScreenshot` of both transports, so no per-owner name can satisfy both.
  public async captureScreenshot(params: CaptureScreenshotParams): Promise<Uint8Array> {
    const ws = await this.ensureConnection(params.cwd);
    const deviceMetricsOverride = buildDeviceMetricsOverride(params);
    if (deviceMetricsOverride) {
      await this.sendCommand(ws, 'Emulation.setDeviceMetricsOverride', deviceMetricsOverride);
    }

    try {
      const response = await this.sendCommand(ws, 'Page.captureScreenshot', {
        // The override already sizes the viewport, so capturing beyond it would
        // re-introduce the scroll height the override exists to pin down.
        captureBeyondViewport: false,
        format: 'png'
      });

      const data = response.result?.data;
      if (data === undefined) {
        throw new Error('CDP screenshot error: Page.captureScreenshot returned no image data.');
      }

      const bytes = decodeBase64Png(data);
      if (!isPng(bytes)) {
        throw new Error('CDP screenshot error: Page.captureScreenshot returned data that is not a PNG.');
      }

      return bytes;
    } finally {
      if (deviceMetricsOverride) {
        await this.sendCommand(ws, 'Emulation.clearDeviceMetricsOverride', {});
      }
    }
  }

  /**
   * Runs a full garbage collection in the renderer of the window showing the given vault, through CDP
   * `HeapProfiler.collectGarbage`. The renderer has no `gc()` of its own unless launched with `--expose-gc`, and an
   * attached Obsidian was launched by someone else.
   *
   * @param cwd - The vault whose window to collect in.
   * @throws Error if CDP refuses the command.
   */
  public async collectGarbage(cwd: string): Promise<void> {
    const ws = await this.ensureConnection(cwd);
    const response = await this.sendCommand(ws, 'HeapProfiler.collectGarbage', {});
    if (response.error) {
      throw new Error(`CDP HeapProfiler.collectGarbage failed: ${response.error.message}`);
    }
  }

  /**
   * Disposes of the active WebSocket connection and, in owned-instance mode,
   * kills the owned Obsidian process and removes its isolated user-data directory.
   *
   * The removal is retried because Windows briefly holds the just-killed
   * process's file handles, which would otherwise fail `rmSync` with `EPERM`.
   */
  public async dispose(): Promise<void> {
    this.disconnect();
    if (!this.ownedConfig) {
      return;
    }

    if (this.ownedConfig.isPersistentUserDataDirectory) {
      await this.quitPersistentInstanceGracefully();
    }
    await this.ownedInstance?.killAsync();
    await this.killOwnedInstanceSurvivors();
    if (this.ownedConfig.isPersistentUserDataDirectory) {
      // Windows briefly holds the killed process's handle on the asar it loaded, so the restore is retried like the directory removal below.
      const deadline = Date.now() + USER_DATA_RM_TIMEOUT_IN_MILLISECONDS;
      while (!this.tryRestoreProfileUpdates(Date.now() >= deadline)) {
        await delay(USER_DATA_RM_RETRY_INTERVAL_IN_MILLISECONDS);
      }
      this.releaseProfileLock();
      return;
    }
    const { userDataDirectory } = this.ownedConfig;
    const deadline = Date.now() + USER_DATA_RM_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      if (didRemoveDirectory(userDataDirectory)) {
        return;
      }
      await delay(USER_DATA_RM_RETRY_INTERVAL_IN_MILLISECONDS);
    }
    if (didRemoveDirectory(userDataDirectory)) {
      return;
    }

    // A directory still held is the one symptom a surviving instance leaves, so say whether one survived rather than leave it to be found by hand.
    const survivorPids = this.ownedInstance ? await listOwnedInstancePortOwnerPidsAsync(this.ownedInstance.port) : [];
    const survivorClause = survivorPids.length > 0
      ? `; WARNING: CDP port ${String(this.ownedInstance?.port)} is still held by PID(s) ${survivorPids.join(', ')}, so the owned instance outlived its kill`
      : '';
    log(
      `[cdp-transport] Could not remove owned user-data directory within ${String(USER_DATA_RM_TIMEOUT_IN_MILLISECONDS)}ms (non-fatal): ${userDataDirectory}${survivorClause}`
    );
  }

  /**
   * Synchronous disposal — kills the owned instance and makes a best-effort
   * removal of its user-data directory. Safe to call from a process `exit` handler
   * (where async retries are impossible; a leftover temp directory is acceptable).
   */
  public disposeSync(): void {
    this.disconnect();
    if (!this.ownedConfig) {
      return;
    }

    this.ownedInstance?.kill();
    if (this.ownedConfig.isPersistentUserDataDirectory) {
      this.tryRestoreProfileUpdates(true);
      this.releaseProfileLock();
      return;
    }
    if (!didRemoveDirectory(this.ownedConfig.userDataDirectory)) {
      log(`[cdp-transport] Owned user-data directory not removed synchronously (process may still hold handles): ${this.ownedConfig.userDataDirectory}`);
    }
  }

  /**
   * Evaluates a JavaScript expression inside Obsidian via CDP `Runtime.evaluate`.
   *
   * Routes to the correct vault target based on `options.cwd`.
   *
   * @param expression - The JavaScript expression to evaluate.
   * @param options - Evaluation options.
   * @returns The normalized result string.
   */
  // eslint-disable-next-line typescript-dev-toolkit/params-options-name-match -- Permanent: `TransportEvalOptions` is one bag shared by the `evaluate` of both transports, so no per-owner name can satisfy both.
  public async evaluate(expression: string, options: TransportEvalOptions): Promise<string> {
    const ws = await this.ensureConnection(options.cwd);
    let response;

    try {
      response = await this.sendCommand(ws, 'Runtime.evaluate', {
        awaitPromise: true,
        expression,
        returnByValue: true
      });
    } catch (error: unknown) {
      /*
       * Only THIS eval carries a caller's closure — the harness's own `Runtime.evaluate` calls (the trust
       * Dialog, the watchdog, the boot probes) time out for reasons that have nothing to do with a test's
       * Waiting, and reporting the cap for those would be the same misdiagnosis pointing the other way.
       */
      if (error instanceof CdpCommandTimeoutError) {
        throw new EvalCapExceededError({
          capInMilliseconds: error.timeoutInMilliseconds,
          cause: error,
          optionName: 'commandTimeoutInMilliseconds',
          transportName: 'desktop (CDP)'
        });
      }

      throw error;
    }

    if (response.result?.exceptionDetails) {
      const desc = response.result.exceptionDetails.exception?.description
        ?? response.result.exceptionDetails.text;
      throw new Error(`CDP evaluation error: ${desc}`);
    }

    const resultObject = response.result?.result;
    return !resultObject || resultObject.type === 'undefined' ? NO_OUTPUT : String(resultObject.value);
  }

  /**
   * Returns the silent-asar-fallback verdict for this owned instance — whether the
   * app version it is actually running matches the swapped-in pin, or the installer
   * silently reverted to its own bundled asar (read live post-boot). Returns
   * `null` when this is not an owned instance, the instance has not booted
   * yet, or the verdict could not be determined (no asar was swapped, or the live
   * version was unreadable). A `'fallback'` verdict reaches this surface only when
   * the throw is disabled ({@link DesktopCdpTransportConfig.shouldThrowOnSilentAsarFallback}
   * `false`); otherwise it throws `SilentAsarFallbackError`.
   *
   * @returns The silent-asar-fallback verdict, or `null`.
   */
  public getAsarFallback(): AsarFallback | null {
    return this.asarFallback ?? null;
  }

  /**
   * Returns the resolved installer↔app compatibility verdict for this owned
   * instance, so callers can assert on it. Returns `null` when this is not
   * an owned instance, or the verdict could not be determined (e.g. an
   * undetectable shell version, or the app version is absent from the table).
   *
   * @returns The compatibility verdict, or `null`.
   */
  public getCompatibility(): InstallerCompatibility | null {
    return this.ownedConfig?.compatibility ?? null;
  }

  /**
   * Returns the runtime Electron compatibility verdict for this owned instance —
   * whether the Electron version it is actually running is new enough for the
   * running app version (read live post-boot; see {@link ObsidianVersionMetadata.minRecommendedElectronVersion}).
   * Returns `null` when this is not an owned instance, the instance has not
   * booted yet, or the verdict could not be determined (the live version was
   * unreadable, or the app version carries no recommended Electron version).
   *
   * @returns The runtime Electron compatibility verdict, or `null`.
   */
  public getElectronCompatibility(): ElectronCompatibility | null {
    return this.electronCompatibility ?? null;
  }

  /**
   * Returns the CDP endpoint of the owned, launched instance so the global setup
   * can hand it to test workers (which then **attach** to it instead of
   * launching their own). Returns `null` when this transport is not an
   * owned instance, or its instance has not been launched yet.
   *
   * @returns The owned instance's CDP host and port, or `null`.
   */
  public getOwnedInstanceEndpoint(): null | OwnedInstanceEndpoint {
    return !this.ownedConfig || !this.ownedInstance ? null : { host: this.cdpHost, port: this.cdpPort };
  }

  /**
   * Verifies that the CDP endpoint is reachable and has Obsidian targets.
   *
   * If Obsidian is not running, attempts to auto-start it via URI protocol
   * and polls until CDP becomes available.
   *
   * @param vaultPath - The vault path (used for vault registration check).
   */
  public async preflightCheck(vaultPath: string): Promise<void> {
    if (this.ownedConfig || this.isHarnessOwnedInstance) {
      // Owned instance (launched here) or a worker attached to one: readiness is
      // guaranteed by the global setup's registerVault, and the vault lives in
      // the isolated config — there is nothing to verify against the user-scope
      // registry.
      return;
    }

    log(`[cdp-transport] Running preflight check for vault: ${vaultPath}`);
    if (!isVaultRegistered(vaultPath)) {
      throw new Error(
        `Vault is not registered in Obsidian: ${vaultPath}. Register the vault first with registerVault() or TemporaryVault.register().`
      );
    }

    try {
      const targets = await this.getPageTargets();
      if (targets.length === 0) {
        throw new Error('No page targets');
      }
      log(`[cdp-transport] CDP reachable, ${String(targets.length)} target(s) found.`);
    } catch {
      await this.ensureObsidianRunning();
    }
  }

  /**
   * Registers a vault via Electron IPC evaluated through CDP.
   *
   * Uses an existing Obsidian target to send the `vault-open` IPC command,
   * then polls until the new vault's target appears.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  public async registerVault(vaultPath: string): Promise<void> {
    if (this.ownedConfig) {
      await this.registerVaultInOwnedInstance(vaultPath);
      return;
    }

    const didOpenWindow = await this.openVaultInRunningInstance(vaultPath);
    // Recorded only on success, and only when this transport really opened the window: this is the one
    // branch that opens a window in an instance this transport did not launch, so it is the one branch
    // that earns the right to close one (see `unregisterVault`). A vault the instance ALREADY had open
    // was adopted, not opened, and its window belongs to whoever opened it. Marking it here is how a
    // `connectToCdp({ port, vault })` against the owner's own running Obsidian destroyed his only
    // window on dispose, and with it the app.
    if (didOpenWindow) {
      this.selfRegisteredVaultPaths.add(normalizeVaultPathForComparison(vaultPath));
    }
  }

  /**
   * Unregisters a vault by destroying its window and removing it from the registry.
   *
   * Refuses when this transport does not own what it would be tearing down: an
   * owned instance (killed wholesale instead), or a window this transport did not
   * open itself — see {@link shouldTearDownVaultWindow}.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  public async unregisterVault(vaultPath: string): Promise<void> {
    const normalizedVaultPath = normalizeVaultPathForComparison(vaultPath);
    if (
      !shouldTearDownVaultWindow({
        isOwnedInstance: Boolean(this.ownedConfig),
        isSelfRegistered: this.selfRegisteredVaultPaths.has(normalizedVaultPath)
      })
    ) {
      log(
        this.ownedConfig
          ? `[cdp-transport] Skipping per-vault teardown; the owned instance is killed wholesale on dispose: ${vaultPath}`
          : `[cdp-transport] Skipping per-vault teardown; this transport did not open the vault's window, so it leaves it open: ${vaultPath}`
      );
      return;
    }

    this.selfRegisteredVaultPaths.delete(normalizedVaultPath);
    const wasRegisteredBefore = this.preRegisteredVaultPaths.delete(normalizedVaultPath);

    try {
      await ensureNamespaceBootstrapped(this, vaultPath);
      const target = await this.findTargetForVault(vaultPath);
      const ws = await this.connectToTarget(target);
      try {
        const windowDestroyExpression = 'window.__obsidianIntegrationTesting.destroyCurrentWindow()';
        await this.sendCommand(ws, 'Runtime.evaluate', {
          awaitPromise: true,
          expression: windowDestroyExpression,
          returnByValue: true
        });
      } finally {
        ws.close();
      }
    } catch {
      // Window may already be closed.
    }

    if (this.activeVaultPath === vaultPath) {
      this.disconnect();
    }

    if (wasRegisteredBefore) {
      // The window is this transport's, the registry entry is not: the vault was in the vault list before
      // `vault-open`, so `vault-remove` would delete the user's own entry.
      log(`[cdp-transport] Closed the vault's window and kept its registry entry, which predates this transport: ${vaultPath}`);
      return;
    }

    await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);

    const targets = await this.getPageTargets();
    if (targets.length > 0) {
      // The `vault-remove` IPC is sent through a still-open window — `vaultPath`'s own
      // window was just destroyed above, so bootstrap the namespace on a remaining
      // window's OWN base path, not on `vaultPath` (which no longer has a live target to
      // match). The destroyed window can still be listed for a moment, so it is excluded
      // by path rather than trusted to have gone.
      const { target: removalTarget, vaultPath: removalBasePath } = await this.waitForOpenVaultWindow(vaultPath);
      const ws = await this.connectToTarget(removalTarget);
      try {
        await ensureNamespaceBootstrapped(this, removalBasePath);
        const vaultRemoveExpression = `window.__obsidianIntegrationTesting.ipcSendSync(${JSON.stringify({ channel: 'vault-remove', channelArguments: [vaultPath] })})`;
        await this.sendCommand(ws, 'Runtime.evaluate', {
          awaitPromise: true,
          expression: vaultRemoveExpression,
          returnByValue: true
        });
      } finally {
        ws.close();
      }
    } else {
      log('[cdp-transport] No CDP targets for removal IPC — removing directly from obsidian.json.');
      didRemoveVaultFromConfig(vaultPath);
    }
  }

  /**
   * Adopts the window of a vault the running instance already has open, so
   * registering it sends no `vault-open`.
   *
   * Every window is asked for its vault first ({@link waitForOpenVaultWindow}),
   * because right after launch a busy instance answers some probes and not
   * others: a single pass could miss the open window, send `vault-open` for it,
   * and mark a window this transport never opened as its own.
   *
   * @param vaultPath - The absolute path to the vault folder.
   * @returns `true` when the vault was already open and its window is ready.
   */
  private async adoptAlreadyOpenVault(vaultPath: string): Promise<boolean> {
    await this.waitForOpenVaultWindow();
    let target: CdpTarget;
    try {
      target = await this.findTargetForVault(vaultPath);
    } catch {
      return false;
    }

    log(`[cdp-transport] Vault is already open in the running instance; adopting its window (${target.id}) without vault-open: ${vaultPath}`);
    await this.waitForLayoutReady(vaultPath);
    return true;
  }

  /**
   * Computes and stores the runtime-Electron compatibility verdict (on
   * {@link getElectronCompatibility}) from an already-read version pair, warning
   * when the live Electron is below the app's recommended minimum. Never throws; a
   * boot whose running app version was unreadable is skipped (nothing to judge).
   *
   * @param appVersion - The live running app version, or `undefined` when unreadable.
   * @param actualElectronVersion - The live Electron version, or `undefined` when unreadable.
   */
  private applyElectronCompatibility(appVersion: string | undefined, actualElectronVersion: string | undefined): void {
    if (appVersion === undefined) {
      return;
    }

    const verdict = resolveElectronCompatibility({
      actualElectronVersion,
      appVersion,
      metadata: getVersionMetadata(appVersion) ?? undefined
    });
    this.electronCompatibility = verdict;
    if (verdict.tier === 'nagged' && this.shouldWarnOnCompatibilityIssues) {
      log(`[cdp-transport] ${ensureNonNullable(verdict.message)}`);
    }
  }

  /**
   * Points the owned instance's renderer at this process's liveness socket so it
   * destroys itself if we die without running teardown (see `parent-liveness.ts`).
   *
   * Best-effort by design. A renderer without Node access reports `'unavailable'`
   * and an evaluation failure is logged and swallowed: the watchdog is a backstop
   * for an already-abnormal exit, never a reason to fail an otherwise good launch.
   *
   * @param vaultPath - The vault path to evaluate in.
   * @param parentLivenessPort - The loopback port the renderer should connect back to.
   */
  private async armParentLivenessWatchdog(vaultPath: string, parentLivenessPort: number): Promise<void> {
    try {
      const result = await this.evaluate(buildParentLivenessWatchdogExpression(parentLivenessPort), { cwd: vaultPath });
      log(`[cdp-transport] Parent-liveness watchdog on port ${String(parentLivenessPort)}: ${result}.`);
    } catch (error: unknown) {
      log(`[cdp-transport] Could not arm the parent-liveness watchdog (instance may outlive a killed harness): ${String(error)}`);
    }
  }

  /**
   * Verifies the ready vault is actually using the requested config folder,
   * throwing {@link ConfigDirectoryFallbackError} when it is not.
   *
   * Obsidian applies the override with `setConfigDir`, which substitutes
   * `.obsidian` for any value its own `validateConfigDir` rejects — without a
   * word, and without failing the boot. The resulting vault opens, reaches
   * layout-ready, and reports success; what it lacks is the settings and enabled
   * plugins of the folder that was asked for. Reading the live
   * `app.vault.configDir` back is the only way to tell the two apart, and it
   * covers every cause at once: a name Obsidian rejected (including its
   * unrecoverable character blacklist, which `assertValidConfigDirectory` deliberately
   * does not guess at), and a write that never reached the vault's renderer.
   *
   * A no-op when no override was requested.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async assertRequestedConfigDirectory(vaultPath: string): Promise<void> {
    if (this.configDirectory === undefined) {
      return;
    }

    const actualConfigDirectory = await this.evaluate('app.vault.configDir', { cwd: vaultPath });
    if (actualConfigDirectory === this.configDirectory) {
      log(`[cdp-transport] Vault opened with the requested config folder ${this.configDirectory}.`);
      return;
    }

    throw new ConfigDirectoryFallbackError({
      actualConfigDirectory,
      requestedConfigDirectory: this.configDirectory,
      vaultPath
    });
  }

  /**
   * Builds the error for a harness-owned instance that is no longer serving CDP,
   * from the best evidence this process has.
   *
   * Two processes see two different halves of the death. The one that launched
   * the instance holds the child and can read the exit code straight off it; a
   * test worker holds nothing but the port, and reads the same facts from the
   * exit marker the owner wrote (`owned-instance-exit-marker.ts`). With neither
   * — the marker lost, or a kill so abrupt nothing recorded it — the error still
   * names the instance as the cause, which is the whole point of it.
   *
   * @returns The error to throw in place of a refused connection.
   */
  private buildOwnedInstanceExitedError(): OwnedInstanceExitedError {
    const exitInfo = this.ownedInstance?.readExitInfo();
    return exitInfo
      ? new OwnedInstanceExitedError({
        cdpUrl: this.cdpUrl,
        code: exitInfo.code,
        outputTail: this.ownedInstance?.readOutput(),
        signal: exitInfo.signal,
        spawnError: exitInfo.spawnError
      })
      : buildOwnedInstanceExitedErrorFromMarker(this.cdpUrl, readOwnedInstanceExitMarker(this.cdpPort));
  }

  /**
   * Verifies the running app (asar) version matches the swapped-in pin, storing the
   * verdict on {@link getAsarFallback}. On a **silent fallback** (the installer ran
   * its own bundled asar instead of the pin) it throws {@link SilentAsarFallbackError}
   * when the throw is enabled, otherwise warns (when warnings are on) and lets the
   * boot proceed. A boot with no swapped-in asar, or an unreadable running version,
   * is `'unknown'` — nothing is thrown or warned. This is the healthy-UI companion to
   * the black-screen {@link RendererFailedToInitializeError} dead-boot fast-fail.
   *
   * @param runningApiVersion - The live running app version, or `undefined` when unreadable.
   */
  private checkRuntimeAsarFallback(runningApiVersion: string | undefined): void {
    const verdict = resolveAsarFallback({
      requestedVersion: this.ownedConfig?.asar?.version,
      runningApiVersion
    });
    this.asarFallback = verdict;

    const action = resolveAsarFallbackAction({
      shouldThrowOnSilentAsarFallback: this.shouldThrowOnSilentAsarFallback,
      shouldWarnOnCompatibilityIssues: this.shouldWarnOnCompatibilityIssues,
      tier: verdict.tier
    });
    if (action === 'throw') {
      throw new SilentAsarFallbackError({
        requestedVersion: ensureNonNullable(verdict.requestedVersion),
        runningApiVersion: ensureNonNullable(verdict.runningApiVersion)
      });
    }
    if (action === 'warn') {
      log(`[cdp-transport] ${ensureNonNullable(verdict.message)}`);
    }
  }

  /**
   * Runs the post-boot runtime compatibility checks for an owned instance, once the
   * vault is ready. Reads the live running app version and Electron version **once**
   * from the booted renderer's main process, then: (1) verifies the running app
   * version matches the swapped-in pin — throwing {@link SilentAsarFallbackError} on
   * a silent fallback (when enabled); and (2) runs the best-effort runtime-Electron
   * nag. Only the asar-fallback check can throw, so this must run outside the
   * readiness poll's try/catch (a swallowed throw would loop until timeout).
   *
   * Both are read at the renderer top level: `ipcRenderer.sendSync('version')` (the
   * running app version, truthful even under a silent asar fallback) and
   * `process.versions.electron` (the live shell Electron); neither uses
   * `require('obsidian')`, which resolves only inside a plugin-load context. A read
   * failure leaves both unknown (logged, non-fatal) — an unreadable running version
   * cannot be judged a fallback, so the boot is not broken by a flaky read.
   *
   * @param vaultPath - The vault path to evaluate in.
   */
  private async checkRuntimeCompatibility(vaultPath: string): Promise<void> {
    let appVersion: string | undefined;
    let actualElectronVersion: string | undefined;
    try {
      const rawAppVersion = await this.evaluate('String(window.electron.ipcRenderer.sendSync(\'version\'))', { cwd: vaultPath });
      appVersion = rawAppVersion === '' || rawAppVersion === 'undefined' ? undefined : rawAppVersion;
      actualElectronVersion = await this.evaluate('String(process.versions.electron)', { cwd: vaultPath });
    } catch (error) {
      log(`[cdp-transport] Could not read runtime versions (non-fatal): ${String(error)}`);
    }

    // Fails fast (when enabled) on a silent asar fallback — MUST run before the
    // best-effort nag and outside any try/catch so the throw escapes the poll.
    this.checkRuntimeAsarFallback(appVersion);
    this.applyElectronCompatibility(appVersion, actualElectronVersion);
  }

  /**
   * Connects to a CDP target's WebSocket endpoint.
   *
   * @param target - The CDP target to connect to.
   * @returns The open WebSocket connection.
   */
  private async connectToTarget(target: CdpTarget): Promise<WebSocket> {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timeoutInMilliseconds = this.getCommandTimeout();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new CdpCommandTimeoutError({ method: 'WebSocket.connect', timeoutInMilliseconds }));
        }, timeoutInMilliseconds);
        ws.addEventListener('open', (): void => {
          resolve();
        }, { once: true });
        ws.addEventListener('error', (): void => {
          reject(new Error(`Failed to connect to CDP target: ${target.webSocketDebuggerUrl}`));
        }, { once: true });
      });
    } catch (error: unknown) {
      ws.close();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    return ws;
  }

  /**
   * Disconnects the active WebSocket connection.
   */
  private disconnect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.activeVaultPath = null;
  }

  /**
   * Dismisses the "Do you trust the author of this vault?" dialog if present.
   *
   * Acts as a safety net when `enable-plugin-<id>` is written in one renderer
   * but not yet visible to the newly-opened vault's renderer (race observed
   * in Obsidian 1.13.0).
   *
   * @param vaultPath - The vault path to evaluate in.
   */
  private async dismissTrustDialog(vaultPath: string): Promise<void> {
    const result = await this.evaluate(DISMISS_TRUST_DIALOG_EXPR, { cwd: vaultPath });
    if (result === 'true') {
      log('[cdp-transport] Dismissed "Do you trust the author" dialog.');
    }
  }

  /**
   * Sets `enable-plugin-<vaultId>` in Obsidian's localStorage to prevent
   * the "Do you trust the author of this vault?" dialog from appearing
   * when a vault with community plugins is opened for the first time.
   *
   * Must be called after the `vault-open` IPC (so the vault ID exists in
   * `obsidian.json`) and before the new vault window finishes loading.
   *
   * @param ws - An open WebSocket to an existing Obsidian target.
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async enablePluginsInLocalStorage(ws: WebSocket, vaultPath: string): Promise<void> {
    const vaultId = getVaultId(vaultPath);
    if (!vaultId) {
      log('[cdp-transport] Could not find vault ID — skipping localStorage trust flag.');
      return;
    }

    await this.sendCommand(ws, 'Runtime.evaluate', {
      expression: `localStorage.setItem(${JSON.stringify(`enable-plugin-${vaultId}`)}, 'true');`,
      returnByValue: true
    });
    log(`[cdp-transport] Set enable-plugin-${vaultId} in localStorage.`);
  }

  /**
   * Ensures there is an active WebSocket connection to the correct vault target.
   *
   * Reuses the existing connection if it targets the requested vault.
   * Otherwise, finds the correct target and reconnects.
   *
   * @param vaultPath - The vault path to target.
   * @returns The active WebSocket connection.
   */
  private async ensureConnection(vaultPath: string): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN && this.activeVaultPath === vaultPath) {
      return this.ws;
    }

    this.disconnect();

    const target = await this.findTargetForVault(vaultPath);
    this.ws = await this.connectToTarget(target);
    this.activeVaultPath = vaultPath;
    return this.ws;
  }

  /**
   * Launches Obsidian with `--remote-debugging-port` and polls until CDP becomes available.
   */
  private async ensureObsidianRunning(): Promise<void> {
    log('[cdp-transport] Obsidian CDP not reachable. Starting Obsidian with remote debugging...');

    const launchCommand = await getObsidianLaunchCommand(this.cdpPort);
    try {
      await exec(launchCommand, { isQuiet: true });
    } catch {
      // The launch command may fail on some systems — we'll still try polling.
    }

    log(`[cdp-transport] Polling for CDP endpoint at ${this.cdpUrl} (timeout=${String(AUTO_START_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + AUTO_START_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      await delay(AUTO_START_POLL_INTERVAL_IN_MILLISECONDS);
      try {
        const targets = await this.getPageTargets();
        if (targets.length > 0) {
          log(`[cdp-transport] Obsidian CDP ready, ${String(targets.length)} target(s) found.`);
          return;
        }
      } catch {
        log('[cdp-transport] CDP not ready yet, retrying...');
      }
    }

    throw new Error(`Obsidian did not start within ${String(AUTO_START_TIMEOUT_IN_MILLISECONDS)}ms. Ensure Obsidian is installed and accessible.`);
  }

  /**
   * Finds the CDP target that has the given vault open.
   *
   * Probes every target by evaluating `getBasePath()` and returns the one whose
   * base path matches `vaultPath` (via {@link areVaultPathsMatching}, tolerant of
   * separator/case differences). A single target is **not** returned blindly: with
   * more than one vault open (attach mode's shared instance), the sole-target
   * shortcut would return whichever window happens to be open regardless of which
   * vault was requested — the exact mis-routing this method must avoid. A target
   * whose probe throws is treated as not-ready and skipped (the caller's readiness
   * poll retries); a target whose probe succeeds but does not match is never
   * returned. When nothing matches, throw so the caller keeps polling.
   *
   * @param vaultPath - The vault path to match.
   * @returns The matching CDP target.
   */
  private async findTargetForVault(vaultPath: string): Promise<CdpTarget> {
    const targets = await this.getPageTargets();

    if (targets.length === 0) {
      throw new Error('No Obsidian CDP targets found');
    }

    for (const target of targets) {
      try {
        const basePath = await this.probeVaultPath(target);
        if (areVaultPathsMatching(basePath, vaultPath)) {
          return target;
        }
      } catch {
        // Not a vault target or not ready.
      }
    }

    throw new Error(`No CDP target found for vault: ${vaultPath}`);
  }

  /**
   * Caps a startup operation by the time left in the shared readiness budget.
   *
   * @returns The operation's timeout in milliseconds.
   */
  private getCommandTimeout(): number {
    return this.ownedReadinessDeadline === undefined
      ? this.commandTimeoutInMilliseconds
      : Math.max(1, Math.min(this.commandTimeoutInMilliseconds, this.ownedReadinessDeadline - Date.now()));
  }

  /**
   * Fetches the list of page-type targets from the CDP `/json` endpoint.
   *
   * @returns The list of page targets.
   * @throws {Error} When no CDP endpoint is configured yet.
   */
  private async getPageTargets(): Promise<CdpTarget[]> {
    if (!this.cdpUrl) {
      // An owned instance picks its port at launch, so before `registerVault` there is no endpoint and
      // `this.cdpUrl` is still empty -- which used to make this a `fetch('/json')` and fail with
      // `Failed to parse URL from /json`, an error naming neither the transport nor what went wrong.
      // A transport in this state is always a symptom of something upstream (a failed global setup, a
      // worker with no registered resolvers -- L9), so say so rather than report a malformed URL.
      throw new Error(
        'No CDP endpoint configured: the owned Obsidian instance has not been launched yet, and no `port` '
          + 'was given to attach to a running one. A test worker in this state usually means its global setup '
          + 'failed, or the project is missing the per-worker setup file in `setupFiles`.'
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.cdpUrl}/json`, { signal: AbortSignal.timeout(this.getCommandTimeout()) });
    } catch (error: unknown) {
      /*
       * An unreachable endpoint means different things in the two modes, and
       * conflating them is what produced the `ECONNREFUSED` cascades. The
       * harness owns this port and nothing else may hold it, so nothing
       * answering means OUR instance is gone — say that, with its exit code
       * when it is known. In plain attach mode the endpoint belongs to a
       * foreign Obsidian that is simply not running, which `ensureObsidianRunning`
       * handles by starting one; that path must keep seeing the raw failure.
       */
      if ((this.ownedConfig || this.isHarnessOwnedInstance) && !(error instanceof DOMException && error.name === 'TimeoutError')) {
        throw this.buildOwnedInstanceExitedError();
      }
      throw error;
    }
    const targets = await response.json() as CdpTarget[];
    return targets.filter((t) => t.type === 'page');
  }

  /**
   * Returns a socket's in-flight command map, installing its reply dispatcher on
   * first use.
   *
   * ONE `message` listener per socket, for the socket's whole life — not one per
   * command. A listener per in-flight command makes the count scale with how many
   * evaluations a suite has in flight at once, so a consumer that fires eleven
   * concurrent `evalInObsidian` calls crosses Node's default `maxListeners` of 10
   * and is told its transport is leaking memory, which it is not: measured
   * 2026-09-15, fifteen concurrent evaluations registered fifteen listeners on the
   * one long-lived socket and the count fell back to zero the moment they settled.
   * A warning that fires on correct use is worse than no warning, because the real
   * signal — an entry that is added and never removed — is then indistinguishable
   * from it. With one dispatcher the listener count is a constant, and a genuine
   * leak shows instead as a pending map that never empties.
   *
   * The dispatcher is deliberately forgiving about what arrives: a CDP **event**
   * carries no `id` and belongs to no command, and a frame that is not JSON at all
   * belongs to nothing this transport sent. Both are ignored. The old per-command
   * handler parsed unguarded, so one frame that is not JSON threw once per
   * in-flight command, out of the event dispatch, where nothing could catch it.
   *
   * @param ws - The socket whose replies are being awaited.
   * @returns The socket's map of in-flight commands, keyed by CDP message id.
   */
  private getPendingCommands(ws: WebSocket): Map<number, PendingCommand> {
    const existingPendingCommands = this.pendingCommandsBySocket.get(ws);
    if (existingPendingCommands) {
      return existingPendingCommands;
    }

    const pendingCommands = new Map<number, PendingCommand>();
    this.pendingCommandsBySocket.set(ws, pendingCommands);
    ws.addEventListener('message', ($event: MessageEvent): void => {
      let message: CdpResponse;
      try {
        message = JSON.parse(String($event.data)) as CdpResponse;
      } catch {
        return;
      }

      const pendingCommand = pendingCommands.get(message.id);
      if (!pendingCommand) {
        return;
      }

      pendingCommands.delete(message.id);
      pendingCommand(message);
    });

    return pendingCommands;
  }

  /**
   * Verifies the owned instance's CDP port was released by its kill, and kills
   * whatever still listens there, a few rounds at most.
   *
   * The kill already reaches a process the instance relaunched into, but one
   * `taskkill` of a tree whose children are still starting can fail, and a
   * relaunched instance then outlives the run. The port is the evidence: nothing
   * but the instance may hold it.
   */
  private async killOwnedInstanceSurvivors(): Promise<void> {
    const port = this.ownedInstance?.port;
    if (port === undefined) {
      return;
    }

    for (let round = 1; round <= OWNED_SURVIVOR_KILL_ROUND_COUNT; round++) {
      const survivorPids = await listOwnedInstancePortOwnerPidsAsync(port);
      if (survivorPids.length === 0) {
        return;
      }

      log(
        `[cdp-transport] CDP port ${String(port)} is still held by PID(s) ${survivorPids.join(', ')} after the owned instance was killed; killing again (round ${String(round)} of ${String(OWNED_SURVIVOR_KILL_ROUND_COUNT)}).`
      );
      for (const pid of survivorPids) {
        await killProcessTreeByPidAsync(pid);
      }
      await delay(OWNED_SURVIVOR_SETTLE_IN_MILLISECONDS);
    }
  }

  /**
   * Kills the currently-running owned instance (if any) and waits for it to exit,
   * so the next launch gets a pristine single-window instance.
   *
   * Relaunching over a live instance is forwarded by Electron's single-instance
   * lock on the shared user-data directory and surfaces the vault picker, and opening a
   * second window via IPC leaves stale windows that break vault-target routing —
   * hence a full kill + wait-for-exit (releasing the lock) between launches. A
   * no-op on the first attempt, when no instance is running yet.
   */
  private async killRunningOwnedInstance(): Promise<void> {
    if (!this.ownedInstance) {
      return;
    }
    log('[cdp-transport] Killing running owned instance before (re)launch.');
    this.disconnect();
    const previousCdpUrl = this.cdpUrl;
    await this.ownedInstance.killAsync();
    this.ownedInstance = undefined;
    await this.waitForInstanceExit(previousCdpUrl);
  }

  /**
   * Moves the owned instance's window off-screen so a hidden run never steals
   * focus. Uses Electron's remote bridge (`window.electron.remote`) — the only
   * cross-platform way to reposition the window — placing it just beyond the
   * right edge of all displays. The window stays "visible" to Chromium (so
   * timers, `requestAnimationFrame`, `:hover`, and trusted input keep working),
   * unlike minimizing, which would freeze `requestAnimationFrame`.
   *
   * The remote bridge is not available the instant CDP starts serving, so this
   * polls until the move succeeds. Best-effort: if the window cannot be moved
   * within the timeout, the keep-alive launch flags still apply and the run
   * proceeds (worst case the window is briefly visible).
   */
  private async moveOwnedWindowOffscreen(): Promise<void> {
    // Resolve the Electron remote bridge two ways so BOTH modern and old Obsidian
    // can be moved off-screen: modern injects `window.electron.remote`; old
    // versions (no `window.electron`) still expose the built-in `remote` module via
    // `require('electron')` in the node-integrated renderer (removed from Electron
    // 14+, but present on the Electron 8-13 shells old Obsidian ships). Returning
    // `moved` on the first success is important on Electron 10-era builds: polling
    // on without a resolvable bridge hammers the renderer with CDP round-trips
    // during boot and intermittently prevents the workspace from initializing.
    const moveExpression = `(() => {
      let remote = (window.electron && window.electron.remote) || null;
      if (!remote) {
        try { remote = require('electron').remote || null; } catch (requireError) { remote = null; }
      }
      if (!remote || typeof remote.getCurrentWindow !== 'function') {
        return (typeof window.app === 'undefined') ? 'not-ready' : 'no-bridge';
      }
      const win = remote.getCurrentWindow();
      const displays = remote.screen.getAllDisplays();
      const maxRight = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
      win.setPosition(maxRight + ${String(OWNED_WINDOW_OFFSCREEN_MARGIN_IN_PIXELS)}, 0);
      return 'moved';
    })()`;

    const deadline = Date.now() + OWNED_WINDOW_HIDE_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      try {
        const [target] = await this.getPageTargets();
        if (target) {
          const ws = await this.connectToTarget(target);
          try {
            const response = await this.sendCommand(ws, 'Runtime.evaluate', {
              expression: moveExpression,
              returnByValue: true
            });
            if (response.result?.result?.value === 'moved') {
              log('[cdp-transport] Moved owned Obsidian window off-screen (hidden mode).');
              return;
            }
          } finally {
            ws.close();
          }
        }
      } catch {
        // CDP endpoint / target / remote bridge not ready yet — keep polling.
      }
      await delay(OWNED_WINDOW_HIDE_POLL_INTERVAL_IN_MILLISECONDS);
    }
    log(`[cdp-transport] Could not move owned window off-screen within ${String(OWNED_WINDOW_HIDE_TIMEOUT_IN_MILLISECONDS)}ms (non-fatal; keep-alive flags still applied).`);
  }

  /**
   * Writes the config-folder override into the starter screen's `localStorage`
   * and then opens the vault from there over the `vault-open` IPC.
   *
   * Obsidian reads the override exactly once, in the vault's own renderer, during
   * `Vault.setup` — `getOverrideConfigDir(appId)` is `localStorage.getItem(appId +
   * '-config')`. So there is no writing it into the vault's window: by the time
   * that window exists the read has happened. The starter screen is the earlier
   * renderer the write needs, and it qualifies because it has `localStorage` and
   * `window.electron.ipcRenderer` but no `app` (verified on 1.13.7).
   *
   * That missing `app` is also why this talks raw CDP rather than going through
   * {@link ensureNamespaceBootstrapped} / the `ipcSendSync` helper as
   * {@link DesktopCdpTransport.openVaultInRunningInstance} does: every one of
   * those paths probes `app.vault.adapter` to identify its target, and would fail
   * on the very renderer this needs.
   *
   * The key name is known ahead of the write because the harness registered the
   * vault under an id it generated itself, and `vault-open` reuses that entry
   * rather than minting a new one.
   *
   * @param vaultPath - The absolute path to the vault folder.
   * @param vaultId - The harness-generated vault id the vault is registered under.
   * @param configDirectory - The config folder to override to.
   */
  private async openVaultFromStarterScreen(vaultPath: string, vaultId: string, configDirectory: string): Promise<void> {
    log(`[cdp-transport] Seeding config folder override ${configDirectory} on the starter screen...`);
    const target = await this.waitForStarterScreenTarget();
    const ws = await this.connectToTarget(target);
    try {
      await this.sendCommand(ws, 'Runtime.evaluate', {
        expression: `localStorage.setItem(${JSON.stringify(`${vaultId}-config`)}, ${JSON.stringify(configDirectory)});`,
        returnByValue: true
      });
      await this.sendCommand(ws, 'Runtime.evaluate', {
        expression: `localStorage.setItem(${JSON.stringify(`enable-plugin-${vaultId}`)}, 'true');`,
        returnByValue: true
      });
      log(`[cdp-transport] Set ${vaultId}-config and enable-plugin-${vaultId} in localStorage.`);

      await this.sendCommand(ws, 'Runtime.evaluate', {
        expression: `window.electron.ipcRenderer.sendSync('vault-open', ${JSON.stringify(vaultPath)}, false)`,
        returnByValue: true
      });
      log(`[cdp-transport] Sent vault-open for ${vaultPath} from the starter screen.`);
    } finally {
      ws.close();
    }
  }

  /**
   * Opens a vault in an already-running Obsidian instance via the `vault-open`
   * Electron IPC (evaluated through CDP on an existing target), then polls until
   * the new vault's window target appears, is layout-ready, and its trust dialog
   * (if any) has been dismissed.
   *
   * Shared by the attach-mode {@link registerVault} and the owned-mode
   * "instance already launched" path, so opening an additional vault never
   * relaunches the process (which would surface the vault picker).
   *
   * A vault the instance already has open is **adopted** instead: no `vault-open`
   * is sent, and the caller is told so, because a window this transport did not
   * open is not one it may close (see {@link registerVault}).
   *
   * @param vaultPath - The absolute path to the vault folder.
   * @returns `true` when this call opened the vault's window, `false` when it was already open.
   */
  private async openVaultInRunningInstance(vaultPath: string): Promise<boolean> {
    log(`[cdp-transport] Registering vault: ${vaultPath}`);
    const targets = await this.getPageTargets();
    if (targets.length === 0) {
      throw new Error('No Obsidian CDP targets available. Is Obsidian running?');
    }

    if (await this.adoptAlreadyOpenVault(vaultPath)) {
      return false;
    }

    // The `vault-open` IPC is sent through an EXISTING window, so the helper namespace
    // must be bootstrapped on THAT window — not on `vaultPath`, whose window does not
    // exist yet. Bootstrapping against `vaultPath` here would route through
    // `findTargetForVault(vaultPath)` with only the existing window present and poison
    // the connection cache (label `vaultPath`, socket → the existing window), so every
    // later eval for `vaultPath` would mis-route to the existing window. Bootstrap
    // against the existing window's own base path instead — and only a window that
    // actually reports one: right after another vault was unregistered, the first
    // listed target can be a window that exposes no vault, and its probe is no path.
    const { target: existingTarget, vaultPath: existingVaultPath } = await this.waitForOpenVaultWindow();
    const ipcWs = await this.connectToTarget(existingTarget);
    try {
      await ensureNamespaceBootstrapped(this, existingVaultPath);
      if (checkIsVaultListed(await this.readVaultRegistry(ipcWs), vaultPath)) {
        log(`[cdp-transport] Vault is already in the instance's vault list; its entry will be kept on teardown: ${vaultPath}`);
        this.preRegisteredVaultPaths.add(normalizeVaultPathForComparison(vaultPath));
      }
      const ipcExpression = `window.__obsidianIntegrationTesting.ipcSendSync(${JSON.stringify({ channel: 'vault-open', channelArguments: [vaultPath, false] })})`;
      await this.sendCommand(ipcWs, 'Runtime.evaluate', {
        awaitPromise: true,
        expression: ipcExpression,
        returnByValue: true
      });

      await this.enablePluginsInLocalStorage(ipcWs, vaultPath);
    } finally {
      ipcWs.close();
    }

    log(`[cdp-transport] Polling for vault target (timeout=${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      try {
        await this.findTargetForVault(vaultPath);
        log('[cdp-transport] Vault target found.');
        await this.waitForLayoutReady(vaultPath);
        await this.dismissTrustDialog(vaultPath);
        return true;
      } catch {
        // Vault target not ready yet.
      }
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }
    throw new Error(`Vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms`);
  }

  /**
   * The readiness poll of {@link waitForOwnedVaultReady}.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async pollOwnedVaultReady(vaultPath: string): Promise<void> {
    log(`[cdp-transport] Waiting for owned vault to become ready (timeout=${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    this.ownedReadinessDeadline = deadline;
    try {
      let documentCompleteSince: null | number = null;
      let isReady = false;
      let lastReadinessError: unknown;
      while (Date.now() < deadline) {
        try {
          await this.findTargetForVault(vaultPath);
          await this.waitForLayoutReady(vaultPath);
          await this.dismissTrustDialog(vaultPath);
          isReady = true;
          break;
        } catch (error: unknown) {
          lastReadinessError = error;
          // The vault is not ready yet — also drop the cached CDP connection before
          // retrying. Old (Electron 10-era) Obsidian reloads the owned window during
          // boot, which can leave the cached WebSocket pinned to a stale execution
          // context; reconnecting each attempt re-binds to the live context.
          this.disconnect();
        }

        if (this.deadBootGraceInMilliseconds > 0 && Date.now() < deadline) {
          const observation = await this.probeRendererBootState();
          if (observation) {
            if (observation.isDocumentComplete && documentCompleteSince === null) {
              documentCompleteSince = Date.now();
            }
            const hasGraceElapsed = documentCompleteSince !== null
              && Date.now() - documentCompleteSince >= this.deadBootGraceInMilliseconds;
            if (resolveRendererBootState({ ...observation, hasGraceElapsed }) === 'dead') {
              log('[cdp-transport] Owned renderer failed to initialize (dead boot); failing fast.');
              throw new RendererFailedToInitializeError(vaultPath);
            }
          }
        }

        await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
      }

      if (!isReady) {
        throw new Error(`Owned vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms: ${errorToString(lastReadinessError)}`, {
          cause: lastReadinessError
        });
      }
    } finally {
      this.ownedReadinessDeadline = undefined;
    }
  }

  /**
   * Samples the vault renderer's bootstrap state — whether the document is
   * `complete`, whether `window.app` exists, and the `<body>` child count — from
   * the first page target, for dead-boot detection. This works even when the app
   * never bootstrapped (the renderer page target still exists), which is exactly
   * the state it must observe.
   *
   * @returns The sampled observation, or `null` when no target is reachable
   *   or the probe failed (so the caller keeps polling rather than fast-failing).
   */
  private async probeRendererBootState(): Promise<null | RendererBootObservation> {
    try {
      const [target] = await this.getPageTargets();
      if (!target) {
        return null;
      }

      const ws = await this.connectToTarget(target);
      try {
        const probeExpression = `JSON.stringify({
          bodyChildElementCount: document.body ? document.body.childElementCount : 0,
          hasWindowApp: typeof window.app !== 'undefined',
          isDocumentComplete: document.readyState === 'complete'
        })`;
        const response = await this.sendCommand(ws, 'Runtime.evaluate', {
          expression: probeExpression,
          returnByValue: true
        });
        const value = response.result?.result?.value;
        return typeof value === 'string' ? (JSON.parse(value) as RendererBootObservation) : null;
      } finally {
        ws.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * Probes which enabled community plugins the owned window loaded at startup.
   *
   * @param vaultPath - The absolute path to the vault folder.
   * @returns The probe result; `unsupported` when the probe itself failed.
   */
  private async probeStartupPluginLoad(vaultPath: string): Promise<StartupPluginLoad> {
    try {
      return parseStartupPluginLoad(await this.evaluate(STARTUP_PLUGIN_LOAD_PROBE_EXPRESSION, { cwd: vaultPath }));
    } catch (error: unknown) {
      log(`[cdp-transport] Could not probe the startup plugin load (non-fatal): ${errorToString(error)}`);
      return { state: 'unsupported' };
    }
  }

  /**
   * Probes a target to discover which vault path it has open.
   *
   * Creates a temporary WebSocket connection, evaluates `getBasePath()`,
   * and returns the result.
   *
   * A window that does not answer with a non-empty string — one still booting,
   * one being destroyed, the starter screen — is not a vault window, so the probe
   * throws rather than returning `String(undefined)`. Returning the literal
   * `'undefined'` let `openVaultInRunningInstance` bootstrap the namespace against
   * a vault named `undefined` and fail with `No CDP target found for vault: undefined`.
   *
   * @param target - The CDP target to probe.
   * @returns The vault's base path.
   * @throws {Error} When the target does not report a vault base path.
   */
  private async probeVaultPath(target: CdpTarget): Promise<string> {
    const ws = await this.connectToTarget(target);
    try {
      const response = await this.sendCommand(ws, 'Runtime.evaluate', {
        // Old Obsidian versions (e.g. 0.6.x) predate the `getBasePath()` method but
        // expose the `basePath` property; the method exists from ~0.9.20 onward.
        expression: 'app.vault.adapter.getBasePath ? app.vault.adapter.getBasePath() : app.vault.adapter.basePath',
        returnByValue: true
      });
      const value = response.result?.result?.value;
      if (typeof value !== 'string' || value === '') {
        throw new Error(`CDP target ${target.id} reported no vault base path`);
      }
      return value;
    } finally {
      ws.close();
    }
  }

  /**
   * Asks a persistent profile's instance to quit, and waits for it to exit,
   * before the hard kill.
   *
   * Chromium writes `localStorage` to its LevelDB store lazily: the renderer
   * batches its commits to the browser process, which writes them later still.
   * A `taskkill /F` seconds after a write drops it, so a value set in a run (a
   * Sync or Publish sign-in among them) was never read back by the next launch.
   * Closing every window unloads it, which commits the renderer's pending changes,
   * and the app then quits on its last window closing, which shuts the storage
   * service down cleanly.
   *
   * Best-effort: an instance that does not exit within the budget is killed as
   * before, and the reason is logged.
   */
  private async quitPersistentInstanceGracefully(): Promise<void> {
    const instance = this.ownedInstance;
    if (!instance || instance.readExitInfo()) {
      return;
    }

    // The close waits a moment so the answer is sent first: closed at once, the window took the reply with it, and the evaluate hung for its whole command timeout (4 of 12 disposes, 2026-11-05).
    const closeExpression = `(() => { setTimeout(() => { window.close(); }, ${String(PERSISTENT_PROFILE_CLOSE_DELAY_IN_MILLISECONDS)}); return 'closing'; })()`;

    instance.expectExit();
    try {
      // Every window closes, so Electron's last-window-closed handler quits the app.
      const targets = await this.getPageTargets();
      for (const target of targets) {
        const ws = await this.connectToTarget(target);
        try {
          const response = await this.sendCommand(ws, 'Runtime.evaluate', { expression: closeExpression, returnByValue: true });
          if (response.result?.result?.value !== 'closing') {
            throw new Error(`Unexpected answer from ${target.url}: ${JSON.stringify(response)}`);
          }
        } finally {
          ws.close();
        }
      }
    } catch (error: unknown) {
      // The close may be under way even so, so the wait below still runs.
      log(`[cdp-transport] Asking the persistent-profile instance to quit got no clean answer; waiting for it to exit anyway: ${errorToString(error)}`);
    }
    const startedAt = Date.now();
    const deadline = startedAt + PERSISTENT_PROFILE_QUIT_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      // The launched process exiting is not enough after a relaunch hand-off: the CDP port must be free too.
      const portOwnerPids = instance.readExitInfo() ? await listOwnedInstancePortOwnerPidsAsync(instance.port) : undefined;
      if (portOwnerPids?.length === 0) {
        log(`[cdp-transport] The persistent-profile instance quit after ${String(Date.now() - startedAt)}ms, with its storage written to disk.`);
        return;
      }
      await delay(PERSISTENT_PROFILE_QUIT_POLL_INTERVAL_IN_MILLISECONDS);
    }
    log(
      `[cdp-transport] The persistent-profile instance did not exit within ${String(PERSISTENT_PROFILE_QUIT_TIMEOUT_IN_MILLISECONDS)}ms of being asked to quit; killing it, so storage written in the last seconds may be lost.`
    );
  }

  /**
   * Reads the instance's vault registry over the `vault-list` IPC, through an already-open window.
   *
   * @param ws - A connection to an open vault window.
   * @returns The registry the main process reported, or `undefined` when it could not be read.
   */
  private async readVaultRegistry(ws: WebSocket): Promise<unknown> {
    try {
      const response = await this.sendCommand(ws, 'Runtime.evaluate', {
        // Old Obsidian has no `window.electron`; its node-integrated renderer reaches IPC through `require` (L26).
        expression: 'JSON.stringify((window.electron ? window.electron.ipcRenderer : require(\'electron\').ipcRenderer).sendSync(\'vault-list\'))',
        returnByValue: true
      });
      const value = response.result?.result?.value;
      return typeof value === 'string' ? JSON.parse(value) : undefined;
    } catch (error) {
      log(`[cdp-transport] Could not read the vault registry; treating the vault as already listed: ${errorToString(error)}`);
      return undefined;
    }
  }

  /**
   * Launches and connects to a harness-owned, isolated Obsidian instance for a
   * vault: provisions the asar (if any), pre-seeds the isolated `obsidian.json`
   * so the vault opens directly, launches the instance on a free CDP port, then
   * waits until the vault window is ready and dismisses the trust dialog.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async registerVaultInOwnedInstance(vaultPath: string): Promise<void> {
    const config = ensureNonNullable(this.ownedConfig);

    mkdirSync(config.userDataDirectory, { recursive: true });
    if (config.isPersistentUserDataDirectory && !this.releasePersistentProfileLock) {
      // Taken before anything is written into the profile, so a refused run leaves it exactly as it found it.
      this.releasePersistentProfileLock = acquirePersistentProfileLock(config.userDataDirectory);
      log(`[cdp-transport] Using the persistent user-data profile ${config.userDataDirectory}; it is kept on dispose.`);
      // Before the run's asar is provisioned: the shell loads the highest `obsidian-*.asar` in the profile, which would override the pin.
      this.restorePersistentProfileUpdates = holdPersistentProfileUpdates(config.userDataDirectory);
    }
    if (config.asar) {
      copyAsarIntoUserData(config.asar.path, config.asar.version, config.userDataDirectory);
    }

    let vaultId = randomBytes(VAULT_ID_BYTE_LENGTH).toString('hex');

    // A config-folder override is a `localStorage` entry, and `localStorage` needs a
    // renderer, so the vault must NOT auto-open: the instance boots to the starter
    // screen, the override is written there, and the vault is opened from it over
    // IPC. Obsidian reuses the pre-registered id for that open (verified on 1.13.7),
    // which is what makes the `<vaultId>-config` key name knowable before launch.
    const shouldAutoOpenVault = this.configDirectory === undefined;

    // Relaunch-retry: some old (Electron 10-era) Obsidian builds intermittently
    // boot with `window.app` present but the workspace never initializing, so the
    // vault never becomes ready. A fresh instance is an independent chance. A
    // deterministic failure (dead boot, silent asar fallback) is re-thrown at once —
    // retrying it only wastes the readiness timeout.
    let lastError: unknown;
    for (let attempt = 1; attempt <= OWNED_LAUNCH_MAX_ATTEMPTS; attempt++) {
      await this.killRunningOwnedInstance();
      if (attempt > 1) {
        await delay(OWNED_RELAUNCH_SETTLE_IN_MILLISECONDS);
      }

      // Re-seeded every attempt rather than once before the loop: Obsidian rewrites
      // `obsidian.json` as it opens a vault (it stamps the entry `open: true`), so a
      // relaunch that inherited the previous attempt's file would sail past the
      // starter screen the override needs.
      vaultId = this.seedOwnedObsidianJson({ config, shouldAutoOpenVault, vaultId, vaultPath });

      const instance = await launchOwnedObsidianInstance({
        cdpHost: this.cdpHost,
        exePath: config.exePath,
        extraArguments: [
          ...DETERMINISTIC_RASTER_LAUNCH_FLAGS,
          ...OWNED_NEVER_BACKGROUND_LAUNCH_FLAGS,
          ...resolveSandboxLaunchArguments(this.shouldDisableSandbox)
        ],

        userDataDirectory: config.userDataDirectory
      });
      this.ownedInstance = instance;
      this.cdpPort = instance.port;
      this.cdpUrl = instance.cdpUrl;

      if (shouldHideObsidianApp(this.isObsidianAppVisible)) {
        await this.moveOwnedWindowOffscreen();
      }

      try {
        if (!shouldAutoOpenVault) {
          // `shouldAutoOpenVault` is a `const` derived from `this.configDirectory === undefined`,
          // so TypeScript narrows the field to `string` in this branch on its own.
          await this.openVaultFromStarterScreen(vaultPath, vaultId, this.configDirectory);
        }
        await this.waitForOwnedVaultReady(vaultPath);
        await this.assertRequestedConfigDirectory(vaultPath);
        await this.armParentLivenessWatchdog(vaultPath, instance.parentLivenessPort);
        return;
      } catch (error: unknown) {
        // A config-folder fallback is deterministic — the name is either one Obsidian
        // accepts or it is not — so relaunching only burns another boot.
        if (
          error instanceof RendererFailedToInitializeError
          || error instanceof SilentAsarFallbackError
          || error instanceof ConfigDirectoryFallbackError
        ) {
          throw error;
        }
        lastError = error;
        log(`[cdp-transport] Owned vault not ready (attempt ${String(attempt)}/${String(OWNED_LAUNCH_MAX_ATTEMPTS)}): ${String(error)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Owned vault at ${vaultPath} did not become ready`);
  }

  /**
   * Releases the persistent profile's lock, if this transport holds one.
   */
  private releaseProfileLock(): void {
    try {
      this.releasePersistentProfileLock?.();
    } catch (error: unknown) {
      log(`[cdp-transport] Could not release the persistent profile lock (non-fatal): ${errorToString(error)}`);
    }
    this.releasePersistentProfileLock = undefined;
  }

  /**
   * When the owned window opened its vault in restricted mode, so the enabled
   * community plugins were not loaded at startup, turns restricted mode off and
   * reloads the window once, so they load during startup as they do for a user.
   * See `startup-plugin-load.ts`.
   *
   * @param vaultPath - The absolute path to the vault folder.
   * @returns Whether the window was reloaded.
   */
  private async reloadIfStartupPluginsSkipped(vaultPath: string): Promise<boolean> {
    const load = await this.probeStartupPluginLoad(vaultPath);
    if (load.state === 'loaded') {
      if (load.loadedPluginIds.length > 0) {
        log(`[cdp-transport] Community plugins loaded at startup: ${load.loadedPluginIds.join(', ')}.`);
      }
      return false;
    }
    if (!checkShouldReloadForStartupPlugins(load)) {
      return false;
    }

    // `isEnabled()` is usually true by now even in the restricted-mode case: the trust-dialog dismissal
    // during readiness writes the key after `Plugins.initialize` has already returned.
    log(
      `[cdp-transport] Enabled community plugins were not loaded at startup (${load.skippedPluginIds.join(', ')}): `
        + `the vault opened in restricted mode, as a fresh profile does (isEnabled() now reads ${String(load.isCommunityPluginsEnabled)}). `
        + `Setting enable-plugin-${load.appId} and reloading the window so they load during startup.`
    );
    await this.evaluate(buildEnableCommunityPluginsAndReloadExpression(load.appId), { cwd: vaultPath });
    this.disconnect();
    await this.waitForReloadedWindow(vaultPath);
    return true;
  }

  /**
   * Logs which plugins the reloaded window loaded at startup, and names any it
   * still skipped. A skip after the reload is left to the setup's own enable,
   * which reports a load error.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async reportStartupPluginLoadAfterReload(vaultPath: string): Promise<void> {
    const load = await this.probeStartupPluginLoad(vaultPath);
    if (load.state === 'skipped') {
      log(`[cdp-transport] After the reload these enabled plugins were still not loaded at startup: ${load.skippedPluginIds.join(', ')}.`);
    } else if (load.state === 'loaded') {
      log(`[cdp-transport] After the reload, community plugins loaded at startup: ${load.loadedPluginIds.join(', ') || '(none)'}.`);
    }
  }

  /**
   * Writes the owned instance's `obsidian.json`: a fresh one-vault registry into a
   * temporary profile, or the vault merged into a persistent profile's own registry,
   * reusing the id that registry already gives the vault.
   *
   * @param params - The owned config, the vault, its candidate id and whether it auto-opens.
   * @returns The id the vault is registered under.
   */
  private seedOwnedObsidianJson(params: DesktopCdpTransportSeedOwnedObsidianJsonParams): string {
    const { config, shouldAutoOpenVault, vaultId, vaultPath } = params;
    const obsidianJsonPath = join(config.userDataDirectory, 'obsidian.json');
    if (!config.isPersistentUserDataDirectory) {
      writeFileSync(obsidianJsonPath, JSON.stringify(buildOwnedObsidianJson({ shouldAutoOpenVault, ts: Date.now(), vaultId, vaultPath })));
      return vaultId;
    }

    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(obsidianJsonPath, 'utf-8'));
    } catch {
      existing = undefined;
    }
    const merged = mergePersistentObsidianJson({ existing, newVaultId: vaultId, shouldAutoOpenVault, ts: Date.now(), vaultPath });
    writeFileSync(obsidianJsonPath, JSON.stringify(merged.json));
    return merged.vaultId;
  }

  /**
   * Sends a CDP command over WebSocket and waits for the response.
   *
   * @param ws - The WebSocket connection.
   * @param method - The CDP method name.
   * @param params - The CDP method parameters.
   * @returns The CDP response.
   */
  private async sendCommand(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<CdpResponse> {
    const id = ++this.messageId;
    const pendingCommands = this.getPendingCommands(ws);
    const timeoutInMilliseconds = this.getCommandTimeout();

    return new Promise<CdpResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(id);
        reject(new CdpCommandTimeoutError({ method, timeoutInMilliseconds }));
      }, timeoutInMilliseconds);

      pendingCommands.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error: unknown) {
        // Nothing will answer a send that threw, so holding the entry for the full command timeout would only delay the failure and then misname it.
        clearTimeout(timeout);
        pendingCommands.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Puts the persistent profile's held-aside updater state back, if this transport holds it.
   *
   * @param isLastAttempt - Whether a failure is final: it is then logged, and the hold
   * is left for the next run on the profile to restore.
   * @returns Whether the caller is done: restored, nothing held, or the last attempt failed.
   */
  private tryRestoreProfileUpdates(isLastAttempt: boolean): boolean {
    try {
      this.restorePersistentProfileUpdates?.();
    } catch (error: unknown) {
      if (!isLastAttempt) {
        return false;
      }
      log(
        `[cdp-transport] Could not put back the persistent profile's held-aside updater state (non-fatal); the next run on the profile restores it: ${errorToString(error)}`
      );
    }
    this.restorePersistentProfileUpdates = undefined;
    return true;
  }

  /**
   * Polls a killed owned instance's CDP endpoint until it stops responding,
   * confirming the process has exited and released Electron's single-instance
   * lock on the shared user-data directory before a fresh instance is launched into it.
   *
   * @param cdpUrl - The CDP URL of the instance that was just killed.
   */
  private async waitForInstanceExit(cdpUrl: string): Promise<void> {
    log(`[cdp-transport] Waiting for previous owned instance at ${cdpUrl} to exit...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        await response.body?.cancel();
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new Error(`Could not verify that the previous owned instance at ${cdpUrl} exited before the timeout.`, { cause: error });
        }
        // The endpoint is gone: the process has exited and released the lock.
        await delay(INSTANCE_EXIT_SETTLE_DELAY_IN_MILLISECONDS);
        return;
      }
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }
    log('[cdp-transport] Previous instance still responded before timeout; relaunching anyway.');
  }

  /**
   * Waits for the vault's `app.workspace` to reach layout-ready state.
   *
   * `findTargetForVault` returns as soon as `app.vault.adapter.getBasePath()`
   * matches — which is true shortly after the `App` constructor runs, before
   * `plugins.initialize()` (and any trust dialog) has executed. Bootstrapping
   * the namespace and calling `pollVaultBasePath()` awaits `layoutReady`, so
   * by the time this returns the dialog has either rendered or is not going
   * to render.
   *
   * @param vaultPath - The vault path to evaluate in.
   */
  private async waitForLayoutReady(vaultPath: string): Promise<void> {
    await ensureNamespaceBootstrapped(this, vaultPath);
    await this.evaluate('window.__obsidianIntegrationTesting.pollVaultBasePath()', { cwd: vaultPath });
  }

  /**
   * Waits for any window of the running instance that has a vault open, to send an
   * IPC command through.
   *
   * Every listed page target is probed, not just the first: after a vault window is
   * destroyed, the target list can still carry it for a moment, and a window that
   * is still booting or sits on the starter screen reports no vault at all. Either
   * one in first place used to be probed alone, yielding no path.
   *
   * @param excludedVaultPath - A vault whose window must not be chosen, because it
   *   is being torn down.
   * @returns The chosen target and the vault path it reported.
   * @throws {Error} When no window reports a vault within the poll timeout.
   */
  private async waitForOpenVaultWindow(excludedVaultPath?: string): Promise<OpenVaultWindow> {
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    let targetCount: number;
    for (;;) {
      const targets = await this.getPageTargets();
      targetCount = targets.length;
      for (const target of targets) {
        try {
          const vaultPath = await this.probeVaultPath(target);
          if (excludedVaultPath === undefined || !areVaultPathsMatching(vaultPath, excludedVaultPath)) {
            return { target, vaultPath };
          }
        } catch {
          // Not a vault window, or not ready yet.
        }
      }

      if (Date.now() >= deadline) {
        break;
      }
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }

    const exclusion = excludedVaultPath === undefined ? '' : ` other than ${excludedVaultPath}`;
    throw new Error(
      `No Obsidian window with an open vault${exclusion} within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms (${String(targetCount)} page target(s) listed, none reported a vault base path).`
    );
  }

  /**
   * Polls the owned instance until the vault target exists, layout is ready, and
   * the trust dialog (if any) has been dismissed.
   *
   * Between readiness attempts it also checks for a **dead boot** — the renderer
   * loaded (`document.readyState` `'complete'`) but the app never bootstrapped
   * (empty `<body>`, no `window.app`), the terminal state when the asar cannot
   * run on the launched Electron shell. Once that state has held for the
   * configured grace window it throws a {@link RendererFailedToInitializeError}
   * immediately instead of waiting out the full readiness timeout. A grace of
   * `0` disables the fast-fail. The grace clock starts when the renderer first
   * reports `complete`, so a slow load before then is never counted against it.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async waitForOwnedVaultReady(vaultPath: string): Promise<void> {
    await this.pollOwnedVaultReady(vaultPath);
    if (await this.reloadIfStartupPluginsSkipped(vaultPath)) {
      await this.pollOwnedVaultReady(vaultPath);
      await this.reportStartupPluginLoadAfterReload(vaultPath);
    }

    // The vault is ready. Run the post-boot compatibility checks here — OUTSIDE the
    // poll's try/catch — so a SilentAsarFallbackError fails fast instead of being
    // swallowed as "not ready yet" and looping until the readiness timeout.
    await this.checkRuntimeCompatibility(vaultPath);
    log('[cdp-transport] Owned vault is ready.');
  }

  /**
   * Waits until the window scheduled to reload has done so: its harness namespace,
   * bootstrapped during readiness, is gone from the live page. Without this the
   * next readiness poll could pass against the page that is about to be replaced.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async waitForReloadedWindow(vaultPath: string): Promise<void> {
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
      try {
        const value = await this.evaluate('JSON.stringify(window.__obsidianIntegrationTesting === undefined)', { cwd: vaultPath });
        if (value === 'true') {
          return;
        }
      } catch {
        // The page is mid-reload — keep polling.
      }
      this.disconnect();
    }
    throw new Error(`The owned window for ${vaultPath} did not reload within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms.`);
  }

  /**
   * Polls until the starter screen's renderer can accept the config-folder
   * override — that is, until it exposes both `localStorage` and
   * `window.electron.ipcRenderer.sendSync`.
   *
   * A page target exists as soon as the launch resolves, so this is not waiting
   * for a window; it is waiting for that window's own scripts to finish. Writing
   * before then would either throw or, worse, land in a renderer that is about to
   * be replaced.
   *
   * @returns The starter screen's CDP target.
   * @throws {Error} When no renderer becomes writable within the timeout.
   */
  private async waitForStarterScreenTarget(): Promise<CdpTarget> {
    const deadline = Date.now() + STARTER_SCREEN_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      const [target] = await this.getPageTargets();
      if (target) {
        const ws = await this.connectToTarget(target);
        try {
          const response = await this.sendCommand(ws, 'Runtime.evaluate', {
            expression: 'typeof localStorage !== "undefined" && !!(window.electron && window.electron.ipcRenderer && window.electron.ipcRenderer.sendSync)',
            returnByValue: true
          });
          if (response.result?.result?.value === true) {
            return target;
          }
        } catch {
          // The renderer is not evaluating yet — keep polling.
        } finally {
          ws.close();
        }
      }
      await delay(STARTER_SCREEN_POLL_INTERVAL_IN_MILLISECONDS);
    }

    throw new Error(
      `The starter screen did not expose localStorage and the Electron IPC bridge within ${String(STARTER_SCREEN_TIMEOUT_IN_MILLISECONDS)}ms, `
        + 'so the config folder override could not be written.'
    );
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
 * Attempts to remove a directory recursively, returning whether it succeeded.
 *
 * @param directory - The directory to remove.
 * @returns `true` if removed, `false` if the removal threw (e.g. handles held).
 */
function didRemoveDirectory(directory: string): boolean {
  try {
    rmSync(directory, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the platform-specific command to launch Obsidian with remote debugging enabled.
 *
 * Resolves the actual installed Obsidian executable (covering installer-based
 * and `PATH`-based installs such as `scoop`) and verifies it exists before
 * returning a command. Throws if Obsidian is not installed.
 *
 * @param port - The CDP port to use.
 * @returns The shell command string.
 * @throws Error if Obsidian cannot be located.
 */
async function getObsidianLaunchCommand(port: number): Promise<string> {
  const exePath = await resolveObsidianExecutable();
  const flag = `--remote-debugging-port=${String(port)}`;

  return process.platform === 'win32' ? `start "" "${exePath}" ${flag}` : `"${exePath}" ${flag} &`;
}

/* v8 ignore stop */
