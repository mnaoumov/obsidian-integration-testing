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

import type { ExecResult } from './exec.ts';
import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { DISMISS_TRUST_DIALOG_EXPR } from './dismiss-trust-dialog.ts';
import { exec } from './exec.ts';
import { getFunctionExpressionString } from './function-expression.ts';
import { log } from './log.ts';
import { ensureNamespaceBootstrapped } from './namespace-bootstrap.ts';
import { noop } from './noop.ts';
import {
  enableCliInConfig,
  getAnyOpenVaultPath,
  getRegisteredVaults,
  getVaultId,
  isCliEnabled,
  isVaultOpen,
  isVaultRegistered,
  registerVaultInConfig,
  removeVaultFromConfig
} from './obsidian-config.ts';
import { resolveObsidianExecutable } from './obsidian-executable.ts';
import { serializeError } from './serialize-error.ts';

interface ExecuteScriptFileFsPromises {
  access(path: string): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
}

interface InvokeAndWriteResultFsPromises {
  writeFile(path: string, data: string): Promise<void>;
}

interface InvokeAndWriteResultParams {
  evaluate(): Promise<unknown>;
  resultPath: string;
  serializeError(error: unknown): string;
}

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

interface BuildDiagnosticsParams {
  command: string[];
  cwd: string;
  execResult: ExecResult | undefined;
  resultPath: string;
  scriptContent: string;
  scriptPath: string;
}

/**
 * Transport that communicates with Desktop Obsidian via the `obsidian eval` CLI command
 * and manages vaults via Electron IPC.
 */
export class DesktopCliTransport implements ObsidianTransport {
  /**
   * Indicates whether this transport is for a mobile platform. Always `false` for this transport.
   */
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
    const scriptPath = join(scriptDir, `${scriptId}.js`);
    const resultPath = join(scriptDir, `${scriptId}.result.json`);

    await mkdir(scriptDir, { recursive: true });

    const scriptContent = buildScriptFile(expression, resultPath);
    await writeFile(scriptPath, scriptContent);

    try {
      const safeScriptPath = scriptPath.replace(/\\/g, '/');
      const cliExpr = `(${getFunctionExpressionString(executeScriptFile)})(${JSON.stringify(safeScriptPath)})`;
      const vaultId = getVaultId(options.cwd);
      const command = ['obsidian', ...(vaultId ? [`vault=${vaultId}`] : []), 'eval', '--allow-focus-steal', `code=${cliExpr}`];

      let execResult: ExecResult | undefined;
      try {
        execResult = await exec(command, {
          cwd: options.cwd,
          isQuiet: true,
          shouldIncludeDetails: true,
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
        const diagnostics = await buildDiagnostics({
          command,
          cwd: options.cwd,
          execResult,
          resultPath,
          scriptContent,
          scriptPath
        });
        throw new Error(`Script did not execute for path: ${options.cwd}\n${diagnostics}`);
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
   * and the `obsidian` CLI binary is available in PATH. If the vault is registered
   * but not open, opens it via URI protocol and polls until it is ready.
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
      log('[cli-transport] CLI is disabled in obsidian.json. Enabling and restarting Obsidian...');
      enableCliInConfig();
      await this.restartObsidian(vaultPath);
    }

    await this.assertCliAvailable();

    if (!isVaultOpen(vaultPath)) {
      log(`[cli-transport] Vault is registered but not open: ${vaultPath}. Opening via URI...`);
      await openVaultViaUri(vaultPath);
      await this.pollVaultReady(vaultPath);
    }

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
    const openVaultPath = await this.getOpenEvalTargetVaultPath();

    if (openVaultPath) {
      await ensureNamespaceBootstrapped(this, openVaultPath);
      const registerExpr = `window.__obsidianIntegrationTesting.ipcSendSync(${JSON.stringify({ args: [vaultPath, false], channel: 'vault-open' })})`;
      await this.evaluate(registerExpr, { cwd: openVaultPath });
      await this.enablePluginsInLocalStorage(vaultPath, openVaultPath);
    } else {
      log('[cli-transport] No open vault to target. Writing vault entry directly to obsidian.json...');
      registerVaultInConfig(vaultPath);
      log('[cli-transport] Vault entry written. Opening vault via URI protocol...');
      await openVaultViaUri(vaultPath);
      await this.pollVaultReady(vaultPath);
      await this.enablePluginsInLocalStorage(vaultPath, vaultPath);
    }

    await this.pollVaultReady(vaultPath);
    await this.dismissTrustDialog(vaultPath);
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
    if (isVaultOpen(vaultPath)) {
      try {
        await ensureNamespaceBootstrapped(this, vaultPath);
        const destroyExpr = 'window.__obsidianIntegrationTesting.destroyCurrentWindow()';
        await this.evaluate(destroyExpr, { cwd: vaultPath, timeoutInMilliseconds: VAULT_EVAL_TIMEOUT_IN_MILLISECONDS });
        log('[cli-transport] Window destroy command sent.');
      } catch (error: unknown) {
        log(`[cli-transport] Window destroy failed (non-fatal): ${serializeError(error)}`);
      }

      log('[cli-transport] Waiting for window to close...');
      await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);
    } else {
      log('[cli-transport] Vault is not open — skipping destroy (would otherwise spawn a stray window via the CLI eval).');
    }

    log('[cli-transport] Removing vault from registry...');
    const evalTargetForRemoval = await this.getOpenEvalTargetVaultPath();
    try {
      if (evalTargetForRemoval) {
        await ensureNamespaceBootstrapped(this, evalTargetForRemoval);
        const removeExpr = `window.__obsidianIntegrationTesting.ipcSendSync(${JSON.stringify({ args: [vaultPath], channel: 'vault-remove' })})`;
        await this.evaluate(removeExpr, { cwd: evalTargetForRemoval, timeoutInMilliseconds: VAULT_EVAL_TIMEOUT_IN_MILLISECONDS });
      } else {
        log('[cli-transport] No open vault to target for removal IPC — removing directly from obsidian.json.');
        removeVaultFromConfig(vaultPath);
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
   * Dismisses the "Do you trust the author of this vault?" dialog if present.
   *
   * Clicks the "Trust author and enable plugins" button (`.mod-cta`) inside any
   * modal whose text includes "Do you trust the author". Acts as a safety net
   * for both registration paths:
   *
   * - First vault registered via config file (no prior `enable-plugin-<id>` entry).
   * - Subsequent vault registered while another vault is already open. The
   *   `enable-plugin-<newVaultId>` write happens in the existing vault's renderer,
   *   but the new vault's renderer may read `localStorage` before that cross-renderer
   *   write becomes visible (race observed in Obsidian 1.13.0).
   *
   * @param vaultPath - The vault path to evaluate in.
   */
  private async dismissTrustDialog(vaultPath: string): Promise<void> {
    await ensureNamespaceBootstrapped(this, vaultPath);
    const result = await this.evaluate(DISMISS_TRUST_DIALOG_EXPR, { cwd: vaultPath });
    if (result === 'true') {
      log('[cli-transport] Dismissed "Do you trust the author" dialog.');
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
   * @param evalTargetVaultPath - The vault path to use as eval target (an existing, loaded vault).
   *   localStorage is shared across all Obsidian windows (same Electron origin), so the
   *   `localStorage.setItem` call can run in any loaded vault window.
   */
  private async enablePluginsInLocalStorage(vaultPath: string, evalTargetVaultPath: string): Promise<void> {
    const vaultId = getVaultId(vaultPath);
    if (!vaultId) {
      log('[cli-transport] Could not find vault ID — skipping localStorage trust flag.');
      return;
    }

    await ensureNamespaceBootstrapped(this, evalTargetVaultPath);
    const enableExpr = `window.__obsidianIntegrationTesting.setLocalStorageItem(${JSON.stringify({ key: `enable-plugin-${vaultId}`, value: 'true' })})`;
    await this.evaluate(enableExpr, { cwd: evalTargetVaultPath });
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

    const launchCommand = await getObsidianLaunchCommand();
    try {
      await exec(launchCommand, { isQuiet: true });
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

  /**
   * Returns the path of an already-open vault to use as an `obsidian eval`
   * target, or `undefined` if there is none.
   *
   * The `open` flag in `obsidian.json` is only trustworthy while Obsidian is
   * running — a killed or crashed process never resets it, leaving the user's
   * last-session vault marked open. Acting on that stale flag would target the
   * (possibly heavy) last-session vault and cause auto-start to reopen it.
   * When Obsidian is not running we therefore report no open vault, so callers
   * fall back to the direct-config path that opens only the temp vault.
   *
   * @returns The absolute path to an open vault, or `undefined`.
   */
  private async getOpenEvalTargetVaultPath(): Promise<string | undefined> {
    if (!await isObsidianRunning()) {
      return undefined;
    }

    return getAnyOpenVaultPath();
  }

  /**
   * Polls until the vault is ready and responding to eval calls.
   *
   * Each `obsidian eval` in the loop is given a per-call timeout. The overall
   * deadline is only re-checked between awaits, so without it a single hung
   * eval (e.g. a vault window that opened but never finished loading) would
   * block past the deadline forever instead of failing and retrying.
   *
   * @param vaultPath - The absolute path to the vault folder.
   */
  private async pollVaultReady(vaultPath: string): Promise<void> {
    const pollExpr = 'window.__obsidianIntegrationTesting.pollVaultBasePath()';

    log(`[cli-transport] Polling for vault readiness (timeout=${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms)...`);
    const deadline = Date.now() + VAULT_POLL_TIMEOUT_IN_MILLISECONDS;
    let isBootstrapped = false;
    while (Date.now() < deadline) {
      try {
        if (!isBootstrapped) {
          await ensureNamespaceBootstrapped(this, vaultPath, VAULT_EVAL_TIMEOUT_IN_MILLISECONDS);
          isBootstrapped = true;
        }
        const basePath = await this.evaluate(pollExpr, { cwd: vaultPath, timeoutInMilliseconds: VAULT_EVAL_TIMEOUT_IN_MILLISECONDS });
        if (JSON.parse(basePath) === vaultPath) {
          log('[cli-transport] Vault is ready.');
          return;
        }
      } catch {
        // Vault not ready yet — namespace may not be bootstrapped yet either.
        isBootstrapped = false;
      }
      await delay(VAULT_POLL_INTERVAL_IN_MILLISECONDS);
    }
    throw new Error(`Vault at ${vaultPath} did not become ready within ${String(VAULT_POLL_TIMEOUT_IN_MILLISECONDS)}ms`);
  }

  /**
   * Restarts Obsidian by killing the running process and relaunching it.
   *
   * Used when a config change (like enabling CLI) requires a restart to take effect.
   *
   * @param vaultPath - The vault path to use for polling after restart.
   */
  private async restartObsidian(vaultPath: string): Promise<void> {
    log('[cli-transport] Killing Obsidian process...');
    try {
      await exec(getKillObsidianCommand(), { isQuiet: true });
    } catch {
      // Process may not be running — that's fine.
    }

    await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);

    const restartVaultId = getVaultId(vaultPath);
    const command = ['obsidian', ...(restartVaultId ? [`vault=${restartVaultId}`] : []), 'eval', 'code="1"'];
    await this.ensureObsidianRunningAndRetry(command, vaultPath);
  }
}

/**
 * Evaluates an expression, writes the result to a JSON file.
 *
 * Serialized via `toString()` and executed inside the Obsidian process.
 * Must NOT reference any outer scope.
 *
 * @param params - The invocation parameters.
 */
export async function invokeAndWriteResult(params: InvokeAndWriteResultParams): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- window.app is set by Obsidian at runtime.
  const fsPromises = Reflect.get(window.app.vault.adapter, 'fsPromises') as InvokeAndWriteResultFsPromises;
  try {
    const result = await params.evaluate();
    if (result === undefined) {
      await fsPromises.writeFile(params.resultPath, JSON.stringify({ type: 'undefined', value: '' }));
    } else if (result === null) {
      await fsPromises.writeFile(params.resultPath, JSON.stringify({ type: 'null', value: '' }));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Intentional: result is an arbitrary value from the evaluated expression.
      await fsPromises.writeFile(params.resultPath, JSON.stringify({ value: String(result) }));
    }
  } catch (err) {
    await fsPromises.writeFile(params.resultPath, JSON.stringify({ type: 'error', value: params.serializeError(err) }));
  }
}

/**
 * Builds a detailed diagnostic string for the "Script did not execute" error.
 *
 * Performs live environment checks (process list, vault registry, CLI config)
 * and includes the command, exec output, and script content.
 *
 * @param params - The diagnostic parameters.
 * @returns A formatted diagnostic string.
 */
async function buildDiagnostics(params: BuildDiagnosticsParams): Promise<string> {
  const lines: string[] = [];

  lines.push(`  Command: ${params.command.join(' ')}`);
  lines.push(`  Working directory: ${params.cwd}`);
  lines.push(`  Script path: ${params.scriptPath}`);
  lines.push(`  Expected result file: ${params.resultPath}`);

  if (params.execResult) {
    lines.push(`  Exit code: ${params.execResult.exitCode === null ? '(null — process did not exit normally)' : String(params.execResult.exitCode)}`);
    if (params.execResult.exitSignal) {
      lines.push(`  Exit signal: ${params.execResult.exitSignal}`);
    }
    if (params.execResult.stdout.trim()) {
      lines.push(`  stdout: ${params.execResult.stdout.trim()}`);
    }
    if (params.execResult.stderr.trim()) {
      lines.push(`  stderr: ${params.execResult.stderr.trim()}`);
    }
    if (!params.execResult.stdout.trim() && !params.execResult.stderr.trim()) {
      lines.push('  stdout/stderr: (empty)');
    }
  } else {
    lines.push('  exec result: (not available — Obsidian was auto-started and retried)');
  }

  lines.push('Environment checks:');
  lines.push(`  Obsidian running: ${await isObsidianRunning() ? 'yes' : 'NO'}`);
  lines.push(`  CLI enabled in obsidian.json: ${isCliEnabled() ? 'yes' : 'NO'}`);
  lines.push(`  Vault registered: ${isVaultRegistered(params.cwd) ? 'yes' : 'NO'}`);
  lines.push(`  Script file exists: ${existsSync(params.scriptPath) ? 'yes' : 'no (already cleaned up)'}`);
  lines.push(`  Result file exists: ${existsSync(params.resultPath) ? 'yes' : 'no'}`);

  const registeredVaults = getRegisteredVaults();
  if (registeredVaults.length === 0) {
    lines.push('  Registered vaults: (none)');
  } else {
    lines.push('  Registered vaults:');
    for (const vault of registeredVaults) {
      lines.push(`    - ${vault.path} (open: ${String(vault.open)})`);
    }
  }

  lines.push(`  Script content:\n${params.scriptContent}`);

  return lines.join('\n');
}

/**
 * Builds the content of a temporary script file.
 *
 * Serializes {@link invokeAndWriteResult} into a self-contained IIFE that
 * evaluates the expression, writes the result (or error) to `resultPath`.
 *
 * @param expression - The JavaScript expression to evaluate.
 * @param resultPath - The absolute path to the result file.
 * @returns The script file content.
 */
function buildScriptFile(expression: string, resultPath: string): string {
  const fnStr = getFunctionExpressionString(invokeAndWriteResult);
  const serializeErrorStr = getFunctionExpressionString(serializeError);
  const resultPathJson = JSON.stringify(resultPath.replace(/\\/g, '/'));
  return `(${fnStr})({ evaluate: async () => (${expression}), resultPath: ${resultPathJson}, serializeError: ${serializeErrorStr} })`;
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
 * Reads a script file from disk, logs its content, and executes it via `new Function`.
 *
 * Serialized via `toString()` and executed inside the Obsidian process.
 * Must NOT reference any outer scope.
 *
 * @param scriptPath - The absolute path to the script file.
 */
async function executeScriptFile(scriptPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- window.app is set by Obsidian at runtime.
  const fsPromises = Reflect.get(window.app.vault.adapter, 'fsPromises') as ExecuteScriptFileFsPromises;

  try {
    await fsPromises.access(scriptPath);
  } catch (cause) {
    throw new Error(`Script file not found: ${scriptPath}`, { cause });
  }

  const script = await fsPromises.readFile(scriptPath, 'utf-8');
  // eslint-disable-next-line no-console -- Diagnostic logging inside Obsidian process; no logger available.
  console.debug(`Executing ${scriptPath}:\n${script}`);

  let fn: () => Promise<void>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- The script is a trusted, self-generated IIFE expression.
    fn = new Function(`return ${script}`) as () => Promise<void>;
  } catch (cause) {
    throw new Error(`Error parsing ${scriptPath}`, { cause });
  }

  try {
    await fn();
  } catch (cause) {
    throw new Error(`Error executing ${scriptPath}`, { cause });
  }
}

/**
 * Returns the platform-specific command to kill the Obsidian process.
 *
 * @returns The shell command string.
 */
function getKillObsidianCommand(): string {
  if (process.platform === 'win32') {
    return 'taskkill /IM Obsidian.exe /F';
  }

  return 'pkill -f Obsidian';
}

/**
 * Returns the platform-specific command to launch the Obsidian binary.
 *
 * Resolves the actual installed Obsidian executable (covering installer-based
 * and `PATH`-based installs such as `scoop`) and verifies it exists before
 * returning a command. Throws if Obsidian is not installed.
 *
 * @returns The shell command string.
 * @throws Error if Obsidian cannot be located.
 */
async function getObsidianLaunchCommand(): Promise<string> {
  const exePath = await resolveObsidianExecutable();

  if (process.platform === 'win32') {
    return `start "" "${exePath}"`;
  }

  return `"${exePath}" &`;
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

/**
 * Checks whether the Obsidian process is currently running.
 *
 * @returns `true` if the Obsidian process is found, `false` otherwise.
 */
async function isObsidianRunning(): Promise<boolean> {
  const command = process.platform === 'win32'
    ? 'tasklist /FI "IMAGENAME eq Obsidian.exe" /NH'
    : 'pgrep -f Obsidian';
  try {
    const output = await exec(command, { isQuiet: true });
    if (process.platform === 'win32') {
      return output.includes('Obsidian.exe');
    }
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Opens a vault in Obsidian using the `obsidian://open` URI protocol.
 *
 * This works whether Obsidian is already running (signals it to open the vault)
 * or not (launches Obsidian with the vault). The URI protocol is handled by the
 * OS, which routes it to the registered Obsidian handler.
 *
 * @param vaultPath - The absolute path to the vault folder.
 */
async function openVaultViaUri(vaultPath: string): Promise<void> {
  const vaultId = getVaultId(vaultPath);
  if (!vaultId) {
    throw new Error(`Cannot open vault via URI: vault is not registered in obsidian.json: ${vaultPath}`);
  }
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultId)}`;
  const command = getOpenUriCommand(uri);
  log(`[cli-transport] Opening vault via URI: ${uri}`);
  try {
    await exec(command, { isQuiet: true });
  } catch (error: unknown) {
    log(`[cli-transport] URI open failed (non-fatal): ${serializeError(error)}`);
  }
}

/* v8 ignore stop */
