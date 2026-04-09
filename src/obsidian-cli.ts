/**
 * @file
 *
 * Evaluates a function inside a running Obsidian instance via the Obsidian CLI.
 */

import type { App } from 'obsidian';
// eslint-disable-next-line import-x/no-namespace -- We need to reference `obsidian` module.
import type * as obsidian from 'obsidian';
import type { Promisable } from 'type-fest';

import { existsSync } from 'node:fs';
import process from 'node:process';

import type {
  ContextArgs,
  ContextId
} from './context-id.ts';

import { exec } from './exec.ts';
import { getFunctionExpressionString } from './function-expression.ts';
import { jsonWithFunctions } from './json-with-functions.ts';
import {
  getVaultId,
  isCliEnabled,
  isVaultRegistered
} from './obsidian-config.ts';

const NO_OUTPUT = '(no output)';
const UNABLE_TO_FIND_OBSIDIAN = 'unable to find Obsidian';
const AUTO_START_POLL_INTERVAL_MS = 2000;
const AUTO_START_TIMEOUT_MS = 30000;

/**
 * Common arguments automatically provided to every {@link evalInObsidian} callback.
 */
export interface CommonArgs {
  /**
   * The Obsidian {@link App} instance.
   */
  app: App;

  /**
   * The `obsidian` module, resolved at runtime inside the Obsidian process.
   */
  obsidianModule: typeof obsidian;
}

/**
 * Parameters for {@link evalInObsidian}.
 */
export interface EvalInObsidianParams<Args extends GenericObject, Result, TContextId extends ContextId<unknown> | undefined = undefined> {
  /**
   * Additional arguments to pass to the function. Values may include functions —
   * they are serialized via `toString()`.
   */
  args?: Args;

  /**
   * A {@link ContextId} linking this call to a persistent store on `window`
   * in the Obsidian process. The callback receives a typed `context` object
   * that survives across calls sharing the same ID.
   *
   * When omitted, `context` is a fresh empty object each call.
   */
  contextId?: TContextId;

  /**
   * The function to evaluate in the Obsidian context.
   */
  fn(args: Args & CommonArgs & ContextArgs<TContextId>): Promisable<Result>;

  /**
   * Skips pre-flight checks (vault registration, CLI availability).
   * Used internally by vault registration functions.
   *
   * @internal
   */
  shouldSkipPreflightChecks?: boolean;

  /**
   * The path to the Obsidian vault. Defaults to `process.cwd()`.
   */
  vaultPath?: string;
}

/**
 * A plain object with string keys.
 */
export type GenericObject = Record<string, unknown>;

/**
 * Evaluates a function inside the running Obsidian instance
 * via the Obsidian CLI and returns the parsed result.
 *
 * The function receives an args object that includes `app`, `obsidianModule`,
 * `context`, and any additional `args` passed by the caller.
 * It is serialized via `toString()` and invoked as an IIFE.
 * The function must be self-contained — closures over local variables will not work.
 * Pass any needed values as `args` — they are JSON-serialized and deserialized on the Obsidian side.
 *
 * The result is `JSON.stringify`'d on the Obsidian side and parsed back.
 *
 * @param params - The parameters for the function to evaluate.
 * @returns A {@link Promise} that resolves to the return value of `fn`.
 */
export async function evalInObsidian<Args extends GenericObject, Result, TContextId extends ContextId<unknown> | undefined = undefined>(
  params: EvalInObsidianParams<Args, Result, TContextId>
): Promise<Result> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- `fn` can be unbound.
  const { args = {}, contextId, fn, shouldSkipPreflightChecks = false, vaultPath } = params;
  const cwd = vaultPath ?? process.cwd();

  // Check 1: Vault path exists on disk.
  if (vaultPath !== undefined && !existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}`);
  }

  if (!shouldSkipPreflightChecks) {
    // Check 2: Vault is registered in Obsidian.
    if (!isVaultRegistered(cwd)) {
      throw new Error(
        `Vault is not registered in Obsidian: ${cwd}. Register the vault first with registerVault() or TempVault.register().`
      );
    }

    // Check 3: CLI is enabled in Obsidian settings.
    if (!isCliEnabled()) {
      throw new Error('Obsidian CLI is disabled. Enable it in Obsidian Settings \u2192 General \u2192 CLI.');
    }

    // Check 4: Obsidian CLI binary is in PATH.
    await assertObsidianCliAvailable();
  }

  const SLICE_START = 2;
  const randomSuffix = String(Math.random()).slice(SLICE_START);
  const contextExpr = contextId
    ? `((window.__obsidianContexts__ ??= {})["${String(contextId)}"] ??= {})`
    : '{}';
  const expression = `
(async () => {
  const fn${randomSuffix} = ${getFunctionExpressionString(fn)};
  const obsidianModule${randomSuffix} = await (async () => {
    if (!app.workspace.app.workspace.layoutReady) {
      await new Promise((resolve) => app.workspace.onLayoutReady(resolve));
    }
    if (!app.plugins.isEnabled()) {
      await app.plugins.setEnable(true);
    }
    ${getFunctionExpressionString(getObsidianModulePluginFn)}
    ${getFunctionExpressionString(getObsidianModule)}
    return await getObsidianModule();
  })();
  const args${randomSuffix} = ${jsonWithFunctions(args)};
  const context${randomSuffix} = ${contextExpr};
  const fullArgs${randomSuffix} = Object.assign(args${randomSuffix}, { app, obsidianModule: obsidianModule${randomSuffix}, context: context${randomSuffix} });
  return JSON.stringify(await fn${randomSuffix}(fullArgs${randomSuffix}));
})()`;

  const command = ['obsidian', 'eval', `code=${expression}`];

  let resultStr: string;
  try {
    resultStr = await exec(command, { cwd, isQuiet: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(UNABLE_TO_FIND_OBSIDIAN)) {
      // Check 5: Obsidian is not running — auto-start it.
      resultStr = await ensureObsidianRunning({ command, cwd });
    } else {
      throw error;
    }
  }

  if (resultStr === '' || resultStr === 'Vault not found.') {
    throw new Error(`Unexpected empty response from Obsidian CLI for path: ${cwd}`);
  }

  const resultJson = resultStr.startsWith('=> ') ? resultStr.slice('=> '.length) : resultStr;
  if (resultJson === NO_OUTPUT) {
    return undefined as Result;
  }

  try {
    return JSON.parse(resultJson) as Result;
  } catch {
    throw new Error(`evalInObsidian: Obsidian returned non-JSON output: ${resultStr}`);
  }
}

/**
 * Checks whether the Obsidian CLI binary is available in the system PATH.
 *
 * @throws If the CLI binary is not found.
 */
async function assertObsidianCliAvailable(): Promise<void> {
  const command = process.platform === 'win32' ? 'where.exe obsidian' : 'which obsidian';
  try {
    await exec(command, { isQuiet: true });
  } catch {
    throw new Error('Obsidian CLI is not available. Ensure Obsidian is installed and its CLI is in your PATH.');
  }
}

/**
 * Launches Obsidian via the `obsidian://` URI protocol and retries the eval
 * until Obsidian becomes available.
 *
 * @param params - The exec parameters for the eval command.
 * @param params.command - The CLI command array to retry.
 * @param params.cwd - The working directory for the eval command.
 * @returns The result string from the successful eval.
 */
async function ensureObsidianRunning(params: { command: string[]; cwd: string }): Promise<string> {
  console.warn('Obsidian is not running. Starting Obsidian...');

  const vaultId = getVaultId(params.cwd);
  const uri = vaultId ? `obsidian://open?vault=${vaultId}` : 'obsidian://open';

  try {
    await exec(getOpenUriCommand(uri), { isQuiet: true });
  } catch {
    // The open command may fail on some systems — we'll still try polling.
  }

  const deadline = Date.now() + AUTO_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => {
      setTimeout(r, AUTO_START_POLL_INTERVAL_MS);
    });
    try {
      return await exec(params.command, { cwd: params.cwd, isQuiet: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(UNABLE_TO_FIND_OBSIDIAN)) {
        throw error;
      }
    }
  }

  throw new Error(`Obsidian did not start within ${String(AUTO_START_TIMEOUT_MS)}ms.`);
}

/* v8 ignore start -- Serialized via toString() and executed inside the Obsidian process, not in Node. Covered by integration tests. */

/**
 * Injected into the Obsidian process to resolve the `obsidian` module.
 * Uses a cached value on `app` if available, otherwise installs a temporary
 * plugin that calls `require('obsidian')` and caches the result.
 *
 * Must NOT reference any outer scope — it is serialized via `toString()`.
 * `getObsidianModulePluginFn` must be defined in the same scope
 * (the generated IIFE handles this).
 *
 * @returns The `obsidian` module.
 */
async function getObsidianModule(): Promise<typeof obsidian> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- We need global `app` variable.
  const app = window.app;
  interface ObsidianModuleHolder {
    obsidianModule: typeof obsidian;
  }
  const obsidianModuleHolder = app as Partial<ObsidianModuleHolder>;
  if (obsidianModuleHolder.obsidianModule) {
    return obsidianModuleHolder.obsidianModule;
  }
  const SLICE_START = 2;
  const randomSuffix = String(Math.random()).slice(SLICE_START);
  const tempModuleName = `get-obsidian-module-${randomSuffix}`;
  const dir = `${app.vault.configDir}/plugins/${tempModuleName}`;
  app.plugins.manifests[tempModuleName] = {
    author: '',
    description: '',
    dir,
    id: tempModuleName,
    isDesktopOnly: true,
    minAppVersion: '',
    name: tempModuleName,
    version: ''
  };
  await app.vault.adapter.mkdir(dir);
  await app.vault.adapter.write(`${dir}/main.js`, `(${String(getObsidianModulePluginFn)})();`);
  await app.plugins.loadPlugin(tempModuleName);
  await app.plugins.uninstallPlugin(tempModuleName);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- It will be initialized within `loadPlugin`.
  if (obsidianModuleHolder.obsidianModule) {
    return obsidianModuleHolder.obsidianModule;
  }
  throw new Error('Failed to load obsidian module');
}

/**
 * The body of the temporary plugin that extracts the `obsidian` module.
 * Serialized via `toString()` and written to `main.js` by {@link getObsidianModule}.
 * Must NOT reference any outer scope.
 */
function getObsidianModulePluginFn(): void {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- We need global `app` variable.
  const app = window.app;
  interface ObsidianModuleHolder {
    obsidianModule: typeof obsidian;
  }
  const obsidianModuleHolder = app as Partial<ObsidianModuleHolder>;

  const pluginRequire = require;
  const pluginExports = exports as {
    default: unknown;
  };

  const obsidianModule = pluginRequire('obsidian') as typeof obsidian;
  obsidianModuleHolder.obsidianModule = obsidianModule;
  pluginExports.default = obsidianModule.Plugin;
}

/* v8 ignore stop */

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
