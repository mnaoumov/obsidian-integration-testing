/**
 * @file
 *
 * Desktop CDP transport — evaluates expressions via Chrome DevTools Protocol
 * over WebSocket and manages vaults via Electron IPC.
 *
 * Obsidian exposes CDP on port 8315 by default. This transport connects to
 * page targets, sends `Runtime.evaluate` commands, and routes to the correct
 * vault target using `getBasePath()` probing.
 *
 * Advantages over CLI transport:
 * - No CLI binary installation needed
 * - No "CLI enabled" setting required in Obsidian
 * - Lower overhead (WebSocket vs. process spawn per eval)
 *
 * Requirements:
 * - Obsidian must be running with remote debugging enabled (port 8315)
 * - Node.js 22+ (uses built-in `WebSocket` and `fetch` globals)
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import process from 'node:process';

import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { exec } from './exec.ts';
import {
  ensureLayoutReady,
  generateFunctionCall
} from './generate-function-call.ts';
import { log } from './log.ts';
import {
  getVaultId,
  isVaultRegistered,
  removeVaultFromConfig
} from './obsidian-config.ts';
import {
  destroyCurrentWindow,
  ipcSendSync
} from './transport-desktop-cli.ts';
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
   * CDP port. Defaults to `8315`.
   */
  cdpPort?: number;

  /**
   * Timeout in milliseconds for individual CDP commands.
   * Defaults to `30000`.
   */
  commandTimeoutInMilliseconds?: number;
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
  exceptionDetails?: CdpExceptionDetails;
  result?: CdpValue;
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

const CDP_DEFAULT_PORT = 8315;
const COMMAND_TIMEOUT_IN_MILLISECONDS = 30000;
const NO_OUTPUT = '(no output)';
const VAULT_POLL_INTERVAL_IN_MILLISECONDS = 500;
const VAULT_POLL_TIMEOUT_IN_MILLISECONDS = 30000;
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 1000;
const AUTO_START_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const AUTO_START_TIMEOUT_IN_MILLISECONDS = 30000;

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
  private readonly cdpPort: number;
  private readonly cdpUrl: string;
  private readonly commandTimeoutInMilliseconds: number;
  private messageId = 0;
  private ws: null | WebSocket = null;

  /**
   * Creates a new CDP transport.
   *
   * @param config - CDP connection configuration.
   */
  public constructor(config?: DesktopCdpTransportConfig) {
    const host = config?.cdpHost ?? 'localhost';
    this.cdpPort = config?.cdpPort ?? CDP_DEFAULT_PORT;
    this.cdpUrl = `http://${host}:${String(this.cdpPort)}`;
    this.commandTimeoutInMilliseconds = config?.commandTimeoutInMilliseconds ?? COMMAND_TIMEOUT_IN_MILLISECONDS;
  }

  /**
   * Disposes of the active WebSocket connection.
   */
  public async dispose(): Promise<void> {
    this.disconnect();
    await Promise.resolve();
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
   * Verifies that the CDP endpoint is reachable and has Obsidian targets.
   *
   * If Obsidian is not running, attempts to auto-start it via URI protocol
   * and polls until CDP becomes available.
   *
   * @param vaultPath - The vault path (used for vault registration check).
   */
  public async preflightCheck(vaultPath: string): Promise<void> {
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
    log(`[cdp-transport] Registering vault: ${vaultPath}`);
    const targets = await this.getPageTargets();
    if (targets.length === 0) {
      throw new Error('No Obsidian CDP targets available. Is Obsidian running?');
    }

    const ipcWs = await this.connectToTarget(ensureNonNullable(targets[0]));
    try {
      const ipcExpr = generateFunctionCall(ipcSendSync, { args: [vaultPath, false], channel: 'vault-open', ensureLayoutReady });
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
        return;
      } catch {
        // Vault target not ready yet.
      }
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }
    throw new Error(`Vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms`);
  }

  /**
   * Unregisters a vault by destroying its window and removing it from the registry.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  public async unregisterVault(vaultPath: string): Promise<void> {
    try {
      const target = await this.findTargetForVault(vaultPath);
      const ws = await this.connectToTarget(target);
      try {
        const destroyExpr = generateFunctionCall(destroyCurrentWindow, { ensureLayoutReady });
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
        const removeExpr = generateFunctionCall(ipcSendSync, { args: [vaultPath], channel: 'vault-remove', ensureLayoutReady });
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

    try {
      await exec(getObsidianLaunchCommand(this.cdpPort), { isQuiet: true });
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
 * @param port - The CDP port to use.
 * @returns The shell command string.
 */
function getObsidianLaunchCommand(port: number): string {
  const flag = `--remote-debugging-port=${String(port)}`;

  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    return `start "" "${localAppData}\\Programs\\Obsidian\\Obsidian.exe" ${flag}`;
  }

  if (process.platform === 'darwin') {
    return `/Applications/Obsidian.app/Contents/MacOS/Obsidian ${flag} &`;
  }

  return `obsidian ${flag} &`;
}

/* v8 ignore stop */
