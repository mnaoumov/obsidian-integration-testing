/**
 * @file
 *
 * Desktop CLI transport — evaluates expressions via `obsidian eval` and manages
 * vaults via Electron IPC.
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { exec } from './exec.ts';
import { getFunctionExpressionString } from './function-expression.ts';
import { log } from './log.ts';
import { noop } from './noop.ts';
import {
  getAnyRegisteredVaultPath,
  getVaultId,
  isCliEnabled,
  isVaultRegistered
} from './obsidian-config.ts';
import { serializeError } from './serialize-error.ts';

/**
 * Discriminated envelope written by the temporary script file.
 *
 * - `{ value: string, type: 'error' }` — the expression threw; `value` is the error message.
 * - `{ value: '', type: 'null' }` — the expression returned `null`.
 * - `{ value: '', type: 'undefined' }` — the expression returned `undefined`.
 * - `{ value: string }` — the expression returned a string value (no `type` field).
 */
type ScriptResultEnvelope =
  | { type: 'error' | 'null' | 'undefined'; value: string }
  | { value: string };

const UNABLE_TO_FIND_OBSIDIAN = 'unable to find Obsidian';
const AUTO_START_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const AUTO_START_TIMEOUT_IN_MILLISECONDS = 30000;
const VAULT_POLL_INTERVAL_IN_MILLISECONDS = 500;
const VAULT_POLL_TIMEOUT_IN_MILLISECONDS = 30000;
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 1000;
const VAULT_EVAL_TIMEOUT_IN_MILLISECONDS = 10000;

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
   * Writes the expression to a temporary `.cjs` file and executes a tiny
   * `require().invoke()` call via the CLI. The result is written to a
   * `.result.json` file by the script, avoiding CLI stdout size limits
   * and IPC buffer issues.
   *
   * Handles auto-start: if Obsidian is not running, launches it via URI protocol
   * and retries until it becomes available.
   *
   * @param expression - The JavaScript expression to evaluate.
   * @param options - Evaluation options.
   * @returns The normalized result string (transport-specific prefixes stripped).
   */
  public async evaluate(expression: string, options: TransportEvalOptions): Promise<string> {
    const SLICE_START = 2;
    const scriptId = String(Math.random()).slice(SLICE_START);
    const scriptDir = join(tmpdir(), 'obsidian-integration-testing');
    const scriptPath = join(scriptDir, `${scriptId}.cjs`);
    const resultPath = join(scriptDir, `${scriptId}.result.json`);

    await mkdir(scriptDir, { recursive: true });

    const invokeName = `invoke_${scriptId}`;
    const scriptContent = buildScriptFile(expression, resultPath, invokeName);
    await writeFile(scriptPath, scriptContent);

    try {
      // Use module.constructor._load to bypass any monkey-patched require()
      // (e.g., obsidian-codescript-toolkit patches require in the renderer process).
      const safeRequire = `module.constructor._load(${JSON.stringify(scriptPath.replace(/\\/g, '/'))})`;
      const requireExpr = `(async () => { await ${safeRequire}.${invokeName}() })()`;
      const command = ['obsidian', 'eval', '--allow-focus-steal', `code=${requireExpr}`];

      try {
        await exec(command, {
          cwd: options.cwd,
          isQuiet: true,
          ...(options.timeoutInMilliseconds !== undefined && { timeoutInMilliseconds: options.timeoutInMilliseconds })
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(UNABLE_TO_FIND_OBSIDIAN)) {
          await this.ensureObsidianRunningAndRetry(command, options.cwd);
        } else {
          throw error;
        }
      }

      if (!existsSync(resultPath)) {
        throw new Error(`Script did not execute for path: ${options.cwd} — the vault may not be found or Obsidian did not run the eval.`);
      }

      const resultStr = await readFile(resultPath, 'utf-8');
      const envelope = JSON.parse(resultStr) as ScriptResultEnvelope;

      if ('type' in envelope) {
        if (envelope.type === 'error') {
          throw new Error(`Script error in Obsidian for path: ${options.cwd}: ${envelope.value}`);
        }
        return '';
      }

      return envelope.value;
    } finally {
      await unlink(scriptPath).catch(noop);
      await unlink(resultPath).catch(noop);
    }
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
    log(`[cli-transport] Running preflight check for vault: ${vaultPath}`);
    if (!isVaultRegistered(vaultPath)) {
      throw new Error(
        `Vault is not registered in Obsidian: ${vaultPath}. Register the vault first with registerVault() or TempVault.register().`
      );
    }

    if (!isCliEnabled()) {
      throw new Error('Obsidian CLI is disabled. Enable it in Obsidian Settings \u2192 General \u2192 CLI.');
    }

    await this.assertCliAvailable();
    log('[cli-transport] Preflight check passed.');
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
    log(`[cli-transport] Registering vault: ${vaultPath}`);
    const existingVaultPath = getAnyRegisteredVaultPath();
    if (!existingVaultPath) {
      throw new Error('Cannot register a vault: no existing vault is registered in Obsidian. Open Obsidian and create or open at least one vault first.');
    }

    const registerExpr = buildIpcExpression(
      `window.electron.ipcRenderer.sendSync('vault-open', ${JSON.stringify(vaultPath)}, false);`
    );
    await this.evaluate(registerExpr, { cwd: existingVaultPath });

    await this.enablePluginsInLocalStorage(vaultPath);

    const pollExpr = buildSimpleExpression(
      'return JSON.stringify(app.vault.adapter.getBasePath());'
    );

    log(`[cli-transport] Polling for vault readiness (timeout=${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      try {
        const basePath = await this.evaluate(pollExpr, { cwd: vaultPath });
        if (JSON.parse(basePath) === vaultPath) {
          log('[cli-transport] Vault is ready.');
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
    log(`[cli-transport] Unregistering vault: closing window for ${vaultPath}...`);
    const destroyExpr = buildSimpleExpression(`
      setTimeout(() => {
        if (window.electron && window.electron.remote) {
          window.electron.remote.getCurrentWindow().destroy();
        }
      }, 0);
    `);
    try {
      await this.evaluate(destroyExpr, { cwd: vaultPath, timeoutInMilliseconds: VAULT_EVAL_TIMEOUT_IN_MILLISECONDS });
      log('[cli-transport] Window destroy command sent.');
    } catch (error: unknown) {
      log(`[cli-transport] Window destroy failed (non-fatal): ${serializeError(error)}`);
    }

    log('[cli-transport] Waiting for window to close...');
    await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);

    log('[cli-transport] Removing vault from registry...');
    const removeExpr = buildIpcExpression(
      `window.electron.ipcRenderer.sendSync('vault-remove', ${JSON.stringify(vaultPath)});`
    );
    const existingVaultForRemoval = getAnyRegisteredVaultPath();
    try {
      if (existingVaultForRemoval) {
        await this.evaluate(removeExpr, { cwd: existingVaultForRemoval, timeoutInMilliseconds: VAULT_EVAL_TIMEOUT_IN_MILLISECONDS });
      } else {
        log('[cli-transport] No existing vault to target for removal IPC — skipping.');
      }
      log('[cli-transport] Vault removed from registry.');
    } catch (error: unknown) {
      log(`[cli-transport] Vault registry removal failed (non-fatal): ${serializeError(error)}`);
    }
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
   * Sets `enable-plugin-<vaultId>` in Obsidian's localStorage to prevent
   * the "Do you trust the author of this vault?" dialog from appearing
   * when a vault with community plugins is opened for the first time.
   *
   * Must be called after the `vault-open` IPC (so the vault ID exists in
   * `obsidian.json`) and before the new vault window finishes loading.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async enablePluginsInLocalStorage(vaultPath: string): Promise<void> {
    const vaultId = getVaultId(vaultPath);
    if (!vaultId) {
      log('[cli-transport] Could not find vault ID — skipping localStorage trust flag.');
      return;
    }

    const enableExpr = buildSimpleExpression(
      `localStorage.setItem(${JSON.stringify(`enable-plugin-${vaultId}`)}, 'true');`
    );
    await this.evaluate(enableExpr, { cwd: vaultPath });
    log(`[cli-transport] Set enable-plugin-${vaultId} in localStorage.`);
  }

  /**
   * Launches Obsidian binary and retries the eval until it responds.
   *
   * @param command - The CLI command array to retry.
   * @param cwd - The working directory.
   */
  private async ensureObsidianRunningAndRetry(command: string[], cwd: string): Promise<void> {
    log('[cli-transport] Obsidian is not running. Starting Obsidian...');

    try {
      await exec(getObsidianLaunchCommand(), { isQuiet: true });
    } catch {
      // The launch command may fail on some systems — we'll still try polling.
    }

    log(`[cli-transport] Polling for Obsidian CLI (timeout=${String(AUTO_START_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + AUTO_START_TIMEOUT_IN_MILLISECONDS;
    while (Date.now() < deadline) {
      await delay(AUTO_START_POLL_INTERVAL_IN_MILLISECONDS);
      try {
        await exec(command, { cwd, isQuiet: true });
        log('[cli-transport] Obsidian CLI responded.');
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(UNABLE_TO_FIND_OBSIDIAN)) {
          throw error;
        }
        log('[cli-transport] Obsidian not ready yet, retrying...');
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
 * Builds the content of a temporary `.cjs` script file.
 *
 * The script defines an async `invoke()` function that evaluates the
 * expression, writes the result (or error) to `resultPath`, and is
 * exported for the CLI to `require()` and call.
 *
 * @param expression - The JavaScript expression to evaluate.
 * @param resultPath - The absolute path to the result file.
 * @param invokeName - The unique function name to export (avoids collisions).
 * @returns The script file content.
 */
function buildScriptFile(expression: string, resultPath: string, invokeName: string): string {
  const resultPathJson = JSON.stringify(resultPath.replace(/\\/g, '/'));
  return `"use strict";
const fs = require("fs");
const serializeError = ${getFunctionExpressionString(serializeError)};

async function ${invokeName}() {
  try {
    const result = await (${expression});
    if (result === undefined) {
      fs.writeFileSync(${resultPathJson}, JSON.stringify({ value: "", type: "undefined" }));
    } else if (result === null) {
      fs.writeFileSync(${resultPathJson}, JSON.stringify({ value: "", type: "null" }));
    } else {
      fs.writeFileSync(${resultPathJson}, JSON.stringify({ value: String(result) }));
    }
  } catch (err) {
    fs.writeFileSync(${resultPathJson}, JSON.stringify({ value: serializeError(err), type: "error" }));
  }
}

exports.${invokeName} = ${invokeName};
`;
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
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    return `start "" "${localAppData}\\Programs\\Obsidian\\Obsidian.exe"`;
  }

  if (process.platform === 'darwin') {
    return '/Applications/Obsidian.app/Contents/MacOS/Obsidian &';
  }

  return 'obsidian &';
}

/* v8 ignore stop */
