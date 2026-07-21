/**
 * @file
 *
 * Desktop CDP transport — evaluates expressions via Chrome DevTools Protocol
 * over WebSocket and manages vaults via Electron IPC.
 *
 * Two modes:
 * - **Owned (default)**: the transport launches and owns an isolated Obsidian
 *   instance against a temporary `--user-data-dir` on a free `--remote-debugging-port`,
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
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import type { AsarFallback } from './asar-fallback-detection.ts';
import type { ElectronCompatibility } from './electron-compatibility.ts';
import type { InstallerCompatibility } from './installer-compatibility.ts';
import type { OwnedObsidianInstance } from './obsidian-instance.ts';
import type { RendererBootObservation } from './renderer-boot-detection.ts';
import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { checkAsarFallback } from './asar-fallback-detection.ts';
import { resolveAsarFallbackAction } from './compatibility-options.ts';
import { DISMISS_TRUST_DIALOG_EXPR } from './dismiss-trust-dialog.ts';
import { checkElectronCompatibility } from './electron-compatibility.ts';
import { exec } from './exec.ts';
import { log } from './log.ts';
import { ensureNamespaceBootstrapped } from './namespace-bootstrap.ts';
import {
  getVaultId,
  isVaultRegistered,
  removeVaultFromConfig
} from './obsidian-config.ts';
import { resolveObsidianExecutable } from './obsidian-executable.ts';
import { launchOwnedObsidianInstance } from './obsidian-instance.ts';
import { getVersionMetadata } from './obsidian-metadata.ts';
import { copyAsarIntoUserData } from './obsidian-version-switch.ts';
import { buildOwnedObsidianJson } from './owned-vault-seed.ts';
import {
  checkRendererBootState,
  DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS
} from './renderer-boot-detection.ts';
import { RendererFailedToInitializeError } from './renderer-failed-to-initialize-error.ts';
import { SilentAsarFallbackError } from './silent-asar-fallback-error.ts';
import { ensureNonNullable } from './type-guards.ts';
import { vaultPathsMatch } from './vault-path-match.ts';
import {
  resolveOwnedHiddenLaunchArgs,
  resolveSandboxLaunchArgs,
  shouldHideObsidianApp
} from './visibility.ts';

/**
 * Configuration for the CDP transport.
 */
export interface DesktopCdpTransportConfig {
  /**
   * CDP host. Defaults to `'localhost'`.
   */
  cdpHost?: string;

  /**
   * CDP port for **attach** mode (the `--remote-debugging-port` the running
   * Obsidian was launched with). In owned-instance mode this is ignored — a
   * free port is chosen at launch.
   */
  cdpPort?: number;

  /**
   * Timeout in milliseconds for individual CDP commands.
   * Defaults to `30000`.
   */
  commandTimeoutInMilliseconds?: number;

  /**
   * Grace window in milliseconds for fast-failing a dead boot of the owned
   * instance (empty `<body>` with no `window.app` after the renderer reached
   * `document.readyState` `'complete'`). Defaults to
   * {@link DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS}. `0` disables fast-fail.
   */
  deadBootGraceInMilliseconds?: number;

  /**
   * When attaching (i.e. {@link cdpPort} is set), marks the target as a
   * **harness-owned, already-prepared** instance. Suppresses the user-scope
   * vault-registration preflight, since the owned instance's vault lives in an
   * isolated user-data config rather than the user-scope registry.
   */
  isHarnessOwnedInstance?: boolean;

  /**
   * Whether the owned Obsidian window is shown on screen. When `false` (the
   * default), the owned instance is launched with keep-alive Chromium flags and
   * its window is moved off-screen after launch. Only meaningful in owned mode;
   * attach mode never touches the (user's) window.
   *
   * @default `true`
   */
  isObsidianAppVisible?: boolean;

  /**
   * When set, the transport launches and owns an isolated Obsidian instance
   * instead of attaching to a running one. This is the default desktop mode.
   */
  ownedInstance?: OwnedInstanceConfig;

  /**
   * Whether to launch the owned instance with Chromium's sandbox disabled
   * (`--no-sandbox`). Needed to boot on Linux without a correctly-configured
   * setuid `chrome-sandbox` helper (e.g. an extracted portable shell, or CI as a
   * non-root user); harmless on Windows/macOS. Only meaningful in owned mode.
   *
   * @default `false`
   */
  shouldDisableSandbox?: boolean;

  /**
   * Whether a post-boot **silent asar fallback** (the running app version differs
   * from the swapped-in pin) fails fast with {@link SilentAsarFallbackError}. The
   * verdict is always computed and surfaced via
   * {@link DesktopCdpTransport.getAsarFallback}; this gates only the throw. Only
   * meaningful in owned mode running a swapped-in asar.
   *
   * @default `true`
   */
  shouldThrowOnSilentAsarFallback?: boolean;

  /**
   * Whether the post-boot runtime-Electron compatibility nag warning is emitted
   * when the live Electron is below the app's recommended minimum. The verdict is
   * always computed and surfaced via {@link DesktopCdpTransport.getElectronCompatibility};
   * this only gates the log. Only meaningful in owned mode.
   *
   * @default `true`
   */
  shouldWarnOnCompatibilityIssues?: boolean;
}

/**
 * An asar to provision into a harness-owned instance's user-data dir before launch.
 */
export interface OwnedInstanceAsar {
  /** Absolute path to the cached/source asar file. */
  readonly path: string;

  /** The asar's `x.y.z` version. */
  readonly version: string;
}

/**
 * Configuration for a harness-owned, isolated Obsidian instance.
 *
 * When present, the transport launches and owns its own Obsidian process
 * against an isolated user-data dir instead of attaching to a running instance.
 */
export interface OwnedInstanceConfig {
  /** Optional asar to provision into {@link userDataDir} before launch. */
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

  /** Absolute path to the Obsidian shell executable to launch. */
  readonly exePath: string;

  /**
   * Absolute path to the isolated user-data dir. Created and owned by the
   * transport, and deleted on dispose.
   */
  readonly userDataDir: string;
}

interface CdpExceptionDetails {
  exception?: CdpExceptionObject;
  text: string;
}

interface CdpExceptionObject {
  description?: string;
}

interface CdpResponse {
  id: number;
  result?: CdpResponseResult;
}

interface CdpResponseResult {
  readonly exceptionDetails?: CdpExceptionDetails;
  readonly result?: CdpValue;
}

interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpValue {
  type: string;
  value?: unknown;
}

/**
 * The CDP endpoint of a launched, harness-owned instance.
 */
interface OwnedInstanceEndpoint {
  /** CDP host (e.g. `'localhost'`). */
  readonly host: string;

  /** The free CDP port the owned instance was launched on. */
  readonly port: number;
}

const COMMAND_TIMEOUT_IN_MILLISECONDS = 30000;
const VAULT_ID_BYTE_LENGTH = 8;
const USER_DATA_RM_TIMEOUT_IN_MILLISECONDS = 10000;
const USER_DATA_RM_RETRY_INTERVAL_IN_MILLISECONDS = 500;
const NO_OUTPUT = '(no output)';
const VAULT_POLL_INTERVAL_IN_MILLISECONDS = 500;
const VAULT_POLL_TIMEOUT_IN_MILLISECONDS = 30000;
// Old (Electron 10-era) Obsidian occasionally boots without the workspace ever
// Initializing, so the vault never becomes ready. A fresh instance is an
// Independent chance; relaunch up to this many times before giving up.
const OWNED_LAUNCH_MAX_ATTEMPTS = 3;
// Brief settle before a relaunch so the killed instance's memory/handles are
// Reclaimed before the next boot — improves the odds on a loaded machine.
const OWNED_RELAUNCH_SETTLE_IN_MILLISECONDS = 3000;
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 1000;
const AUTO_START_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const AUTO_START_TIMEOUT_IN_MILLISECONDS = 30000;
const INSTANCE_EXIT_SETTLE_DELAY_IN_MILLISECONDS = 500;
const OWNED_WINDOW_OFFSCREEN_MARGIN_IN_PIXELS = 200;
const OWNED_WINDOW_HIDE_TIMEOUT_IN_MILLISECONDS = 20000;
const OWNED_WINDOW_HIDE_POLL_INTERVAL_IN_MILLISECONDS = 250;

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
  private readonly deadBootGraceInMilliseconds: number;
  private electronCompatibility: ElectronCompatibility | undefined;
  private readonly isHarnessOwnedInstance: boolean;
  private readonly isObsidianAppVisible: boolean;
  private messageId = 0;
  private readonly ownedConfig: OwnedInstanceConfig | undefined;
  private ownedInstance: OwnedObsidianInstance | undefined;
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
    // Exactly like the former `config?.x ?? default`) so the constructor stays
    // Under the cyclomatic-complexity limit as fields are added.
    const {
      cdpHost = 'localhost',
      cdpPort,
      commandTimeoutInMilliseconds = COMMAND_TIMEOUT_IN_MILLISECONDS,
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
   * Disposes of the active WebSocket connection and, in owned-instance mode,
   * kills the owned Obsidian process and removes its isolated user-data dir.
   *
   * The removal is retried because Windows briefly holds the just-killed
   * process's file handles, which would otherwise fail `rmSync` with `EPERM`.
   */
  public async dispose(): Promise<void> {
    this.disconnect();
    if (!this.ownedConfig) {
      return;
    }

    this.ownedInstance?.kill();
    const { userDataDir } = this.ownedConfig;
    const deadline = Date.now() + USER_DATA_RM_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      if (tryRemoveDir(userDataDir)) {
        return;
      }
      await delay(USER_DATA_RM_RETRY_INTERVAL_IN_MILLISECONDS);
    }
    if (!tryRemoveDir(userDataDir)) {
      log(`[cdp-transport] Could not remove owned user-data dir within ${String(USER_DATA_RM_TIMEOUT_IN_MILLISECONDS)}ms (non-fatal): ${userDataDir}`);
    }
  }

  /**
   * Synchronous disposal — kills the owned instance and makes a best-effort
   * removal of its user-data dir. Safe to call from a process `exit` handler
   * (where async retries are impossible; a leftover temp dir is acceptable).
   */
  public disposeSync(): void {
    this.disconnect();
    if (this.ownedConfig) {
      this.ownedInstance?.kill();
      if (!tryRemoveDir(this.ownedConfig.userDataDir)) {
        log(`[cdp-transport] Owned user-data dir not removed synchronously (process may still hold handles): ${this.ownedConfig.userDataDir}`);
      }
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
  public async evaluate(expression: string, options: TransportEvalOptions): Promise<string> {
    const ws = await this.ensureConnection(options.cwd);
    const response = await this.sendCommand(ws, 'Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true
    });

    if (response.result?.exceptionDetails) {
      const desc = response.result.exceptionDetails.exception?.description
        ?? response.result.exceptionDetails.text;
      throw new Error(`CDP evaluation error: ${desc}`);
    }

    const resultObj = response.result?.result;
    if (!resultObj || resultObj.type === 'undefined') {
      return NO_OUTPUT;
    }

    return String(resultObj.value);
  }

  /**
   * Returns the silent-asar-fallback verdict for this owned instance — whether the
   * app version it is actually running matches the swapped-in pin, or the installer
   * silently reverted to its own bundled asar (read live post-boot). Returns
   * `undefined` when this is not an owned instance, the instance has not booted
   * yet, or the verdict could not be determined (no asar was swapped, or the live
   * version was unreadable). A `'fallback'` verdict reaches this surface only when
   * the throw is disabled ({@link DesktopCdpTransportConfig.shouldThrowOnSilentAsarFallback}
   * `false`); otherwise it throws `SilentAsarFallbackError`.
   *
   * @returns The silent-asar-fallback verdict, or `undefined`.
   */
  public getAsarFallback(): AsarFallback | undefined {
    return this.asarFallback;
  }

  /**
   * Returns the resolved installer↔app compatibility verdict for this owned
   * instance, so callers can assert on it. Returns `undefined` when this is not
   * an owned instance, or the verdict could not be determined (e.g. an
   * undetectable shell version, or the app version is absent from the table).
   *
   * @returns The compatibility verdict, or `undefined`.
   */
  public getCompatibility(): InstallerCompatibility | undefined {
    return this.ownedConfig?.compatibility;
  }

  /**
   * Returns the runtime Electron compatibility verdict for this owned instance —
   * whether the Electron version it is actually running is new enough for the
   * running app version (read live post-boot; see {@link ObsidianVersionMetadata.minRecommendedElectronVersion}).
   * Returns `undefined` when this is not an owned instance, the instance has not
   * booted yet, or the verdict could not be determined (the live version was
   * unreadable, or the app version carries no recommended Electron version).
   *
   * @returns The runtime Electron compatibility verdict, or `undefined`.
   */
  public getElectronCompatibility(): ElectronCompatibility | undefined {
    return this.electronCompatibility;
  }

  /**
   * Returns the CDP endpoint of the owned, launched instance so the global setup
   * can hand it to test workers (which then **attach** to it instead of
   * launching their own). Returns `undefined` when this transport is not an
   * owned instance, or its instance has not been launched yet.
   *
   * @returns The owned instance's CDP host and port, or `undefined`.
   */
  public getOwnedInstanceEndpoint(): OwnedInstanceEndpoint | undefined {
    if (!this.ownedConfig || !this.ownedInstance) {
      return undefined;
    }
    return { host: this.cdpHost, port: this.cdpPort };
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
      // Guaranteed by the global setup's registerVault, and the vault lives in
      // The isolated config — there is nothing to verify against the user-scope
      // Registry.
      return;
    }

    log(`[cdp-transport] Running preflight check for vault: ${vaultPath}`);
    if (!isVaultRegistered(vaultPath)) {
      throw new Error(
        `Vault is not registered in Obsidian: ${vaultPath}. Register the vault first with registerVault() or TempVault.register().`
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

    await this.openVaultInRunningInstance(vaultPath);
  }

  /**
   * Unregisters a vault by destroying its window and removing it from the registry.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  public async unregisterVault(vaultPath: string): Promise<void> {
    if (this.ownedConfig) {
      // The owned instance is killed wholesale on dispose; no per-vault
      // Unregister is needed (and the registry lives in the isolated config).
      return;
    }

    try {
      await ensureNamespaceBootstrapped(this, vaultPath);
      const target = await this.findTargetForVault(vaultPath);
      const ws = await this.connectToTarget(target);
      try {
        const destroyExpr = 'window.__obsidianIntegrationTesting.destroyCurrentWindow()';
        await this.sendCommand(ws, 'Runtime.evaluate', {
          awaitPromise: true,
          expression: destroyExpr,
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

    await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);

    const targets = await this.getPageTargets();
    if (targets.length > 0) {
      // The `vault-remove` IPC is sent through a still-open window (`targets[0]`) —
      // `vaultPath`'s own window was just destroyed above, so bootstrap the namespace
      // On the existing window's OWN base path, not on `vaultPath` (which no longer has
      // A live target to match).
      const removalTarget = ensureNonNullable(targets[0]);
      const removalBasePath = await this.probeVaultPath(removalTarget);
      const ws = await this.connectToTarget(removalTarget);
      try {
        await ensureNamespaceBootstrapped(this, removalBasePath);
        const removeExpr = `window.__obsidianIntegrationTesting.ipcSendSync(${JSON.stringify({ args: [vaultPath], channel: 'vault-remove' })})`;
        await this.sendCommand(ws, 'Runtime.evaluate', {
          awaitPromise: true,
          expression: removeExpr,
          returnByValue: true
        });
      } finally {
        ws.close();
      }
    } else {
      log('[cdp-transport] No CDP targets for removal IPC — removing directly from obsidian.json.');
      removeVaultFromConfig(vaultPath);
    }
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

    const verdict = checkElectronCompatibility({
      actualElectronVersion,
      appVersion,
      metadata: getVersionMetadata(appVersion)
    });
    this.electronCompatibility = verdict;
    if (verdict.tier === 'nagged' && this.shouldWarnOnCompatibilityIssues) {
      log(`[cdp-transport] ${ensureNonNullable(verdict.message)}`);
    }
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
    const verdict = checkAsarFallback({
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
    // Best-effort nag and outside any try/catch so the throw escapes the poll.
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
    await new Promise<void>((resolve, reject) => {
      ws.onopen = (): void => {
        resolve();
      };
      ws.onerror = (): void => {
        reject(new Error(`Failed to connect to CDP target: ${target.webSocketDebuggerUrl}`));
      };
    });
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
   * base path matches `vaultPath` (via {@link vaultPathsMatch}, tolerant of
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
        if (vaultPathsMatch(basePath, vaultPath)) {
          return target;
        }
      } catch {
        // Not a vault target or not ready.
      }
    }

    throw new Error(`No CDP target found for vault: ${vaultPath}`);
  }

  /**
   * Fetches the list of page-type targets from the CDP `/json` endpoint.
   *
   * @returns The list of page targets.
   */
  private async getPageTargets(): Promise<CdpTarget[]> {
    const response = await fetch(`${this.cdpUrl}/json`);
    const targets = await response.json() as CdpTarget[];
    return targets.filter((t) => t.type === 'page');
  }

  /**
   * Kills the currently-running owned instance (if any) and waits for it to exit,
   * so the next launch gets a pristine single-window instance.
   *
   * Relaunching over a live instance is forwarded by Electron's single-instance
   * lock on the shared user-data dir and surfaces the vault picker, and opening a
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
    this.ownedInstance.kill();
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
    // Can be moved off-screen: modern injects `window.electron.remote`; old
    // Versions (no `window.electron`) still expose the built-in `remote` module via
    // `require('electron')` in the node-integrated renderer (removed from Electron
    // 14+, but present on the Electron 8-13 shells old Obsidian ships). Returning
    // `moved` on the first success is important on Electron 10-era builds: polling
    // On without a resolvable bridge hammers the renderer with CDP round-trips
    // During boot and intermittently prevents the workspace from initializing.
    const moveExpr = `(() => {
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
        const target = (await this.getPageTargets())[0];
        if (target) {
          const ws = await this.connectToTarget(target);
          try {
            const response = await this.sendCommand(ws, 'Runtime.evaluate', {
              expression: moveExpr,
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
   * Opens a vault in an already-running Obsidian instance via the `vault-open`
   * Electron IPC (evaluated through CDP on an existing target), then polls until
   * the new vault's window target appears, is layout-ready, and its trust dialog
   * (if any) has been dismissed.
   *
   * Shared by the attach-mode {@link registerVault} and the owned-mode
   * "instance already launched" path, so opening an additional vault never
   * relaunches the process (which would surface the vault picker).
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async openVaultInRunningInstance(vaultPath: string): Promise<void> {
    log(`[cdp-transport] Registering vault: ${vaultPath}`);
    const targets = await this.getPageTargets();
    if (targets.length === 0) {
      throw new Error('No Obsidian CDP targets available. Is Obsidian running?');
    }

    // The `vault-open` IPC is sent through an EXISTING window (`targets[0]`), so the
    // Helper namespace must be bootstrapped on THAT window — not on `vaultPath`, whose
    // Window does not exist yet. Bootstrapping against `vaultPath` here would route
    // Through `findTargetForVault(vaultPath)` with only the existing window present and
    // Poison the connection cache (label `vaultPath`, socket → the existing window), so
    // Every later eval for `vaultPath` would mis-route to the existing window. Probe the
    // Existing window's own base path and bootstrap against that instead.
    const existingTarget = ensureNonNullable(targets[0]);
    const existingVaultPath = await this.probeVaultPath(existingTarget);
    const ipcWs = await this.connectToTarget(existingTarget);
    try {
      await ensureNamespaceBootstrapped(this, existingVaultPath);
      const ipcExpr = `window.__obsidianIntegrationTesting.ipcSendSync(${JSON.stringify({ args: [vaultPath, false], channel: 'vault-open' })})`;
      await this.sendCommand(ipcWs, 'Runtime.evaluate', {
        awaitPromise: true,
        expression: ipcExpr,
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
        return;
      } catch {
        // Vault target not ready yet.
      }
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }
    throw new Error(`Vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms`);
  }

  /**
   * Samples the vault renderer's bootstrap state — whether the document is
   * `complete`, whether `window.app` exists, and the `<body>` child count — from
   * the first page target, for dead-boot detection. This works even when the app
   * never bootstrapped (the renderer page target still exists), which is exactly
   * the state it must observe.
   *
   * @returns The sampled observation, or `undefined` when no target is reachable
   *   or the probe failed (so the caller keeps polling rather than fast-failing).
   */
  private async probeRendererBootState(): Promise<RendererBootObservation | undefined> {
    try {
      const target = (await this.getPageTargets())[0];
      if (!target) {
        return undefined;
      }

      const ws = await this.connectToTarget(target);
      try {
        const probeExpr = `JSON.stringify({
          bodyChildElementCount: document.body ? document.body.childElementCount : 0,
          hasWindowApp: typeof window.app !== 'undefined',
          isDocumentComplete: document.readyState === 'complete'
        })`;
        const response = await this.sendCommand(ws, 'Runtime.evaluate', {
          expression: probeExpr,
          returnByValue: true
        });
        const value = response.result?.result?.value;
        if (typeof value !== 'string') {
          return undefined;
        }
        return JSON.parse(value) as RendererBootObservation;
      } finally {
        ws.close();
      }
    } catch {
      return undefined;
    }
  }

  /**
   * Probes a target to discover which vault path it has open.
   *
   * Creates a temporary WebSocket connection, evaluates `getBasePath()`,
   * and returns the result.
   *
   * @param target - The CDP target to probe.
   * @returns The vault's base path.
   */
  private async probeVaultPath(target: CdpTarget): Promise<string> {
    const ws = await this.connectToTarget(target);
    try {
      const response = await this.sendCommand(ws, 'Runtime.evaluate', {
        // Old Obsidian versions (e.g. 0.6.x) predate the `getBasePath()` method but
        // Expose the `basePath` property; the method exists from ~0.9.20 onward.
        expression: 'app.vault.adapter.getBasePath ? app.vault.adapter.getBasePath() : app.vault.adapter.basePath',
        returnByValue: true
      });
      return String(response.result?.result?.value);
    } finally {
      ws.close();
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

    mkdirSync(config.userDataDir, { recursive: true });
    if (config.asar) {
      copyAsarIntoUserData(config.asar.path, config.asar.version, config.userDataDir);
    }

    const vaultId = randomBytes(VAULT_ID_BYTE_LENGTH).toString('hex');
    const obsidianJson = buildOwnedObsidianJson({ ts: Date.now(), vaultId, vaultPath });
    writeFileSync(join(config.userDataDir, 'obsidian.json'), JSON.stringify(obsidianJson));

    // Relaunch-retry: some old (Electron 10-era) Obsidian builds intermittently
    // Boot with `window.app` present but the workspace never initializing, so the
    // Vault never becomes ready. A fresh instance is an independent chance. A
    // Deterministic failure (dead boot, silent asar fallback) is re-thrown at once —
    // Retrying it only wastes the readiness timeout.
    let lastError: unknown;
    for (let attempt = 1; attempt <= OWNED_LAUNCH_MAX_ATTEMPTS; attempt++) {
      await this.killRunningOwnedInstance();
      if (attempt > 1) {
        await delay(OWNED_RELAUNCH_SETTLE_IN_MILLISECONDS);
      }

      const instance = await launchOwnedObsidianInstance({
        cdpHost: this.cdpHost,
        exePath: config.exePath,
        extraArgs: [
          ...resolveOwnedHiddenLaunchArgs(this.isObsidianAppVisible),
          ...resolveSandboxLaunchArgs(this.shouldDisableSandbox)
        ],
        userDataDir: config.userDataDir
      });
      this.ownedInstance = instance;
      this.cdpPort = instance.port;
      this.cdpUrl = instance.cdpUrl;

      if (shouldHideObsidianApp(this.isObsidianAppVisible)) {
        await this.moveOwnedWindowOffscreen();
      }

      try {
        await this.waitForOwnedVaultReady(vaultPath);
        return;
      } catch (error: unknown) {
        if (error instanceof RendererFailedToInitializeError || error instanceof SilentAsarFallbackError) {
          throw error;
        }
        lastError = error;
        log(`[cdp-transport] Owned vault not ready (attempt ${String(attempt)}/${String(OWNED_LAUNCH_MAX_ATTEMPTS)}): ${String(error)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Owned vault at ${vaultPath} did not become ready`);
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

    return new Promise<CdpResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.removeEventListener('message', handler);
        reject(new Error(`CDP command timed out after ${String(this.commandTimeoutInMilliseconds)}ms: ${method}`));
      }, this.commandTimeoutInMilliseconds);

      function handler(event: MessageEvent): void {
        const msg = JSON.parse(String(event.data)) as CdpResponse;
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeEventListener('message', handler);
          resolve(msg);
        }
      }

      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Polls a killed owned instance's CDP endpoint until it stops responding,
   * confirming the process has exited and released Electron's single-instance
   * lock on the shared user-data dir before a fresh instance is launched into it.
   *
   * @param cdpUrl - The CDP URL of the instance that was just killed.
   */
  private async waitForInstanceExit(cdpUrl: string): Promise<void> {
    log(`[cdp-transport] Waiting for previous owned instance at ${cdpUrl} to exit...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${cdpUrl}/json`);
        await response.body?.cancel();
      } catch {
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
    log(`[cdp-transport] Waiting for owned vault to become ready (timeout=${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    let documentCompleteSince: null | number = null;
    let isReady = false;
    while (Date.now() < deadline) {
      try {
        await this.findTargetForVault(vaultPath);
        await this.waitForLayoutReady(vaultPath);
        await this.dismissTrustDialog(vaultPath);
        isReady = true;
        break;
      } catch {
        // The vault is not ready yet — also drop the cached CDP connection before
        // Retrying. Old (Electron 10-era) Obsidian reloads the owned window during
        // Boot, which can leave the cached WebSocket pinned to a stale execution
        // Context; reconnecting each attempt re-binds to the live context.
        this.disconnect();
      }

      if (this.deadBootGraceInMilliseconds > 0) {
        const observation = await this.probeRendererBootState();
        if (observation) {
          if (observation.isDocumentComplete && documentCompleteSince === null) {
            documentCompleteSince = Date.now();
          }
          const hasGraceElapsed = documentCompleteSince !== null
            && Date.now() - documentCompleteSince >= this.deadBootGraceInMilliseconds;
          if (checkRendererBootState({ ...observation, hasGraceElapsed }) === 'dead') {
            log('[cdp-transport] Owned renderer failed to initialize (dead boot); failing fast.');
            throw new RendererFailedToInitializeError(vaultPath);
          }
        }
      }

      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }

    if (!isReady) {
      throw new Error(`Owned vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms`);
    }

    // The vault is ready. Run the post-boot compatibility checks here — OUTSIDE the
    // Poll's try/catch — so a SilentAsarFallbackError fails fast instead of being
    // Swallowed as "not ready yet" and looping until the readiness timeout.
    await this.checkRuntimeCompatibility(vaultPath);
    log('[cdp-transport] Owned vault is ready.');
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

  if (process.platform === 'win32') {
    return `start "" "${exePath}" ${flag}`;
  }

  return `"${exePath}" ${flag} &`;
}

/**
 * Attempts to remove a directory recursively, returning whether it succeeded.
 *
 * @param dir - The directory to remove.
 * @returns `true` if removed, `false` if the removal threw (e.g. handles held).
 */
function tryRemoveDir(dir: string): boolean {
  try {
    rmSync(dir, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

/* v8 ignore stop */
