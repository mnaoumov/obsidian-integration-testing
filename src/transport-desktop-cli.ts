/**
 * @file
 *
 * Desktop CLI transport — evaluates expressions via `obsidian eval` and manages
 * vaults via Electron IPC.
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import process from 'node:process';

import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { exec } from './exec.ts';
import {
  getVaultId,
  isCliEnabled,
  isVaultRegistered
} from './obsidian-config.ts';

const UNABLE_TO_FIND_OBSIDIAN = 'unable to find Obsidian';
const AUTO_START_POLL_INTERVAL_MS = 2000;
const AUTO_START_TIMEOUT_MS = 30000;
const VAULT_POLL_INTERVAL_MS = 500;
const VAULT_POLL_TIMEOUT_MS = 30000;
const VAULT_CLOSE_DELAY_MS = 1000;

/**
 * Transport that communicates with Desktop Obsidian via the `obsidian eval` CLI command
 * and manages vaults via Electron IPC.
 */
export class DesktopCliTransport implements ObsidianTransport {
  /** */
  public readonly isMobile = false;

  /**
   * Evaluates a JavaScript expression inside Obsidian via `obsidian eval`.
   *
   * Handles auto-start: if Obsidian is not running, launches it via URI protocol
   * and retries until it becomes available.
   *
   * @param expression - The JavaScript expression to evaluate.
   * @param options - Evaluation options.
   * @returns The normalized result string (transport-specific prefixes stripped).
   */
  public async evaluate(expression: string, options: TransportEvalOptions): Promise<string> {
    const command = ['obsidian', 'eval', `code=${expression}`];

    let resultStr: string;
    try {
      resultStr = await exec(command, { cwd: options.cwd, isQuiet: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(UNABLE_TO_FIND_OBSIDIAN)) {
        resultStr = await this.ensureObsidianRunningAndRetry(command, options.cwd);
      } else {
        throw error;
      }
    }

    if (resultStr === '' || resultStr === 'Vault not found.') {
      throw new Error(`Unexpected empty response from Obsidian for path: ${options.cwd}`);
    }

    return resultStr.startsWith('=> ') ? resultStr.slice('=> '.length) : resultStr;
  }

  /**
   * Runs CLI-specific preflight checks.
   *
   * Verifies that the vault is registered, CLI is enabled in Obsidian settings,
   * and the `obsidian` CLI binary is available in PATH.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  public async preflightCheck(vaultPath: string): Promise<void> {
    if (!isVaultRegistered(vaultPath)) {
      throw new Error(
        `Vault is not registered in Obsidian: ${vaultPath}. Register the vault first with registerVault() or TempVault.register().`
      );
    }

    if (!isCliEnabled()) {
      throw new Error('Obsidian CLI is disabled. Enable it in Obsidian Settings \u2192 General \u2192 CLI.');
    }

    await this.assertCliAvailable();
  }

  /**
   * Registers a vault in the running Obsidian instance via Electron IPC.
   *
   * Uses `vault-open` IPC to register and open the vault, then polls until
   * the vault's CLI is ready and `getBasePath()` matches `vaultPath`.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  public async registerVault(vaultPath: string): Promise<void> {
    const registerExpr = buildIpcExpression(
      `window.electron.ipcRenderer.sendSync('vault-open', ${JSON.stringify(vaultPath)}, false);`
    );
    await this.evaluate(registerExpr, { cwd: process.cwd() });

    const pollExpr = buildSimpleExpression(
      'return JSON.stringify(app.vault.adapter.getBasePath());'
    );

    const deadline = Date.now() + VAULT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const basePath = await this.evaluate(pollExpr, { cwd: vaultPath });
        if (JSON.parse(basePath) === vaultPath) {
          return;
        }
      } catch {
        // Vault not ready yet.
      }
      await delay(VAULT_POLL_INTERVAL_MS);
    }
    throw new Error(`Vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_MS)}ms`);
  }

  /**
   * Unregisters a vault from the running Obsidian instance.
   *
   * Schedules the vault window to close, waits, then removes the vault
   * from the registry via `vault-remove` IPC.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  public async unregisterVault(vaultPath: string): Promise<void> {
    const destroyExpr = buildSimpleExpression(`
      setTimeout(() => {
        if (window.electron && window.electron.remote) {
          window.electron.remote.getCurrentWindow().destroy();
        }
      }, 0);
    `);
    try {
      await this.evaluate(destroyExpr, { cwd: vaultPath });
    } catch {
      // The window may have closed before the response was sent — that's OK.
    }

    await delay(VAULT_CLOSE_DELAY_MS);

    const removeExpr = buildIpcExpression(
      `window.electron.ipcRenderer.sendSync('vault-remove', ${JSON.stringify(vaultPath)});`
    );
    await this.evaluate(removeExpr, { cwd: process.cwd() });
  }

  /**
   * Checks whether the Obsidian CLI binary is available in the system PATH.
   */
  private async assertCliAvailable(): Promise<void> {
    const command = process.platform === 'win32' ? 'where.exe obsidian' : 'which obsidian';
    try {
      await exec(command, { isQuiet: true });
    } catch {
      throw new Error('Obsidian CLI is not available. Ensure Obsidian is installed and its CLI is in your PATH.');
    }
  }

  /**
   * Launches Obsidian via URI protocol and retries the eval until it responds.
   *
   * @param command - The CLI command array to retry.
   * @param cwd - The working directory.
   * @returns The result string from the successful eval.
   */
  private async ensureObsidianRunningAndRetry(command: string[], cwd: string): Promise<string> {
    console.warn('Obsidian is not running. Starting Obsidian...');

    const vaultId = getVaultId(cwd);
    const uri = vaultId ? `obsidian://open?vault=${vaultId}` : 'obsidian://open';

    try {
      await exec(getOpenUriCommand(uri), { isQuiet: true });
    } catch {
      // The open command may fail on some systems — we'll still try polling.
    }

    const deadline = Date.now() + AUTO_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(AUTO_START_POLL_INTERVAL_MS);
      try {
        return await exec(command, { cwd, isQuiet: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(UNABLE_TO_FIND_OBSIDIAN)) {
          throw error;
        }
      }
    }

    throw new Error(`Obsidian did not start within ${String(AUTO_START_TIMEOUT_MS)}ms.`);
  }
}

/**
 * Builds an async IIFE that waits for layout ready and executes an IPC call.
 * The return value is `JSON.stringify(undefined)` so the CLI produces `(no output)`.
 *
 * @param ipcStatement - The IPC statement to execute.
 * @returns The IIFE expression string.
 */
function buildIpcExpression(ipcStatement: string): string {
  return buildSimpleExpression(ipcStatement);
}

/**
 * Builds a simple async IIFE expression that waits for layout ready.
 *
 * @param body - The JavaScript statements to execute.
 * @returns The IIFE expression string.
 */
function buildSimpleExpression(body: string): string {
  return `(async () => {
  if (!app.workspace.layoutReady) {
    await new Promise((resolve) => app.workspace.onLayoutReady(resolve));
  }
  ${body}
})()`;
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
 * Returns the platform-specific command to open a URI.
 *
 * @param uri - The URI to open.
 * @returns The shell command string.
 */
function getOpenUriCommand(uri: string): string {
  if (process.platform === 'win32') {
    return `start "" "${uri}"`;
  }

  if (process.platform === 'darwin') {
    return `open "${uri}"`;
  }

  return `xdg-open "${uri}"`;
}

/* v8 ignore stop */
