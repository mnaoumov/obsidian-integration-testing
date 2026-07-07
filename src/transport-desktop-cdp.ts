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

import type { OwnedObsidianInstance } from './obsidian-instance.ts';
import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { DISMISS_TRUST_DIALOG_EXPR } from './dismiss-trust-dialog.ts';
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
import { copyAsarIntoUserData } from './obsidian-version-switch.ts';
import { ensureNonNullable } from './type-guards.ts';

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
   * When attaching (i.e. {@link cdpPort} is set), marks the target as a
   * **harness-owned, already-prepared** instance. Suppresses the user-scope
   * vault-registration preflight, since the owned instance's vault lives in an
   * isolated user-data config rather than the user-scope registry.
   */
  isHarnessOwnedInstance?: boolean;

  /**
   * When set, the transport launches and owns an isolated Obsidian instance
   * instead of attaching to a running one. This is the default desktop mode.
   */
  ownedInstance?: OwnedInstanceConfig;
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
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 1000;
const AUTO_START_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const AUTO_START_TIMEOUT_IN_MILLISECONDS = 30000;
const INSTANCE_EXIT_SETTLE_DELAY_IN_MILLISECONDS = 500;

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
  private readonly cdpHost: string;
  private cdpPort: number;
  private cdpUrl: string;
  private readonly commandTimeoutInMilliseconds: number;
  private readonly isHarnessOwnedInstance: boolean;
  private messageId = 0;
  private readonly ownedConfig: OwnedInstanceConfig | undefined;
  private ownedInstance: OwnedObsidianInstance | undefined;
  private ws: null | WebSocket = null;

  /**
   * Creates a new CDP transport.
   *
   * @param config - CDP connection configuration.
   */
  public constructor(config?: DesktopCdpTransportConfig) {
    this.cdpHost = config?.cdpHost ?? 'localhost';
    this.commandTimeoutInMilliseconds = config?.commandTimeoutInMilliseconds ?? COMMAND_TIMEOUT_IN_MILLISECONDS;
    this.isHarnessOwnedInstance = config?.isHarnessOwnedInstance ?? false;
    this.ownedConfig = config?.ownedInstance;
    // Owned mode picks a free port at launch (assigned in registerVault).
    // Attach mode connects to the configured port; no port is hardcoded.
    this.cdpPort = config?.cdpPort ?? 0;
    this.cdpUrl = config?.cdpPort === undefined ? '' : `http://${this.cdpHost}:${String(config.cdpPort)}`;
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
      const ws = await this.connectToTarget(ensureNonNullable(targets[0]));
      try {
        await ensureNamespaceBootstrapped(this, vaultPath);
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
   * For a single target, returns it directly. For multiple targets,
   * probes each by evaluating `getBasePath()` to find the match.
   *
   * @param vaultPath - The vault path to match.
   * @returns The matching CDP target.
   */
  private async findTargetForVault(vaultPath: string): Promise<CdpTarget> {
    const targets = await this.getPageTargets();

    if (targets.length === 0) {
      throw new Error('No Obsidian CDP targets found');
    }

    if (targets.length === 1) {
      return ensureNonNullable(targets[0]);
    }

    for (const target of targets) {
      try {
        const basePath = await this.probeVaultPath(target);
        if (basePath === vaultPath) {
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

    const ipcWs = await this.connectToTarget(ensureNonNullable(targets[0]));
    try {
      await ensureNamespaceBootstrapped(this, vaultPath);
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
        expression: 'app.vault.adapter.getBasePath()',
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

    if (this.ownedInstance) {
      // A prior vault's instance is still running in this (per-worker cached)
      // Transport. Relaunch fresh for the new vault: relaunching over the live
      // Instance is forwarded by Electron's single-instance lock on the shared
      // User-data dir and surfaces the vault picker, and opening a second window
      // Via IPC leaves stale windows that break vault-target routing. So kill the
      // Running instance, wait for it to exit (releasing the lock), then launch
      // Again below with the new vault pre-seeded — each vault gets a pristine
      // Single-window instance opened directly, never the selector.
      log(`[cdp-transport] Relaunching owned instance for new vault: ${vaultPath}`);
      this.disconnect();
      const previousCdpUrl = this.cdpUrl;
      this.ownedInstance.kill();
      this.ownedInstance = undefined;
      await this.waitForInstanceExit(previousCdpUrl);
    } else {
      log(`[cdp-transport] Launching owned Obsidian instance for vault: ${vaultPath}`);
    }

    mkdirSync(config.userDataDir, { recursive: true });
    if (config.asar) {
      copyAsarIntoUserData(config.asar.path, config.asar.version, config.userDataDir);
    }

    const vaultId = randomBytes(VAULT_ID_BYTE_LENGTH).toString('hex');
    const obsidianJson = {
      updateDisabled: true,
      vaults: { [vaultId]: { open: true, path: vaultPath, ts: Date.now() } }
    };
    writeFileSync(join(config.userDataDir, 'obsidian.json'), JSON.stringify(obsidianJson));

    const instance = await launchOwnedObsidianInstance({
      cdpHost: this.cdpHost,
      exePath: config.exePath,
      userDataDir: config.userDataDir
    });
    this.ownedInstance = instance;
    this.cdpPort = instance.port;
    this.cdpUrl = instance.cdpUrl;

    await this.waitForOwnedVaultReady(vaultPath);
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
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async waitForOwnedVaultReady(vaultPath: string): Promise<void> {
    log(`[cdp-transport] Waiting for owned vault to become ready (timeout=${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      try {
        await this.findTargetForVault(vaultPath);
        await this.waitForLayoutReady(vaultPath);
        await this.dismissTrustDialog(vaultPath);
        log('[cdp-transport] Owned vault is ready.');
        return;
      } catch {
        // Vault target not ready yet.
      }
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }
    throw new Error(`Owned vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms`);
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
