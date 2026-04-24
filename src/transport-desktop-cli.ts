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
  isCliEnabled,
  isVaultRegistered
} from './obsidian-config.ts';

const UNABLE_TO_FIND_OBSIDIAN = 'unable to find Obsidian';
const AUTO_START_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const AUTO_START_TIMEOUT_IN_MILLISECONDS = 30000;
const VAULT_POLL_INTERVAL_IN_MILLISECONDS = 500;
const VAULT_POLL_TIMEOUT_IN_MILLISECONDS = 30000;
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 1000;

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

    // The CLI may prepend error/warning lines before the result.
    // Find the last `=> ` line which contains the actual result.
    const lines = resultStr.split('\n');
    const resultLine = lines.findLast((line) => line.startsWith('=> '));
    if (resultLine) {
      return resultLine.slice('=> '.length);
    }

    return resultStr;
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
    console.warn(`[cli-transport] Running preflight check for vault: ${vaultPath}`);
    if (!isVaultRegistered(vaultPath)) {
      throw new Error(
        `Vault is not registered in Obsidian: ${vaultPath}. Register the vault first with registerVault() or TempVault.register().`
      );
    }

    if (!isCliEnabled()) {
      throw new Error('Obsidian CLI is disabled. Enable it in Obsidian Settings \u2192 General \u2192 CLI.');
    }

    await this.assertCliAvailable();
    console.warn('[cli-transport] Preflight check passed.');
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
    console.warn(`[cli-transport] Registering vault: ${vaultPath}`);
    const registerExpr = buildIpcExpression(
      `window.electron.ipcRenderer.sendSync('vault-open', ${JSON.stringify(vaultPath)}, false);`
    );
    await this.evaluate(registerExpr, { cwd: process.cwd() });

    const pollExpr = buildSimpleExpression(
      'return JSON.stringify(app.vault.adapter.getBasePath());'
    );

    console.warn(`[cli-transport] Polling for vault readiness (timeout=${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      try {
        const basePath = await this.evaluate(pollExpr, { cwd: vaultPath });
        if (JSON.parse(basePath) === vaultPath) {
          console.warn('[cli-transport] Vault is ready.');
          return;
        }
      } catch {
        // Vault not ready yet.
      }
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }
    throw new Error(`Vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms`);
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

    await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);

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
   * Launches Obsidian binary and retries the eval until it responds.
   *
   * @param command - The CLI command array to retry.
   * @param cwd - The working directory.
   * @returns The result string from the successful eval.
   */
  private async ensureObsidianRunningAndRetry(command: string[], cwd: string): Promise<string> {
    console.warn('[cli-transport] Obsidian is not running. Starting Obsidian...');

    try {
      await exec(getObsidianLaunchCommand(), { isQuiet: true });
    } catch {
      // The launch command may fail on some systems — we'll still try polling.
    }

    console.warn(`[cli-transport] Polling for Obsidian CLI (timeout=${String(AUTO_START_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + AUTO_START_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      await delay(AUTO_START_POLL_INTERVAL_IN_MILLISECONDS);
      try {
        const result = await exec(command, { cwd, isQuiet: true });
        console.warn('[cli-transport] Obsidian CLI responded.');
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(UNABLE_TO_FIND_OBSIDIAN)) {
          throw error;
        }
        console.warn('[cli-transport] Obsidian not ready yet, retrying...');
      }
    }

    throw new Error(`Obsidian did not start within ${String(AUTO_START_TIMEOUT_IN_MILLISECONDS)}ms.`);
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
 * Returns the platform-specific command to launch the Obsidian binary.
 *
 * @returns The shell command string.
 */
function getObsidianLaunchCommand(): string {
  if (process.platform === 'win32') {
    return 'start "" "%LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.exe"';
  }

  if (process.platform === 'darwin') {
    return '/Applications/Obsidian.app/Contents/MacOS/Obsidian &';
  }

  return 'obsidian &';
}

/* v8 ignore stop */
