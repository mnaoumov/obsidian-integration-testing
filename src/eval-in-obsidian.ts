/**
 * @file
 *
 * Evaluates a function inside a running Obsidian instance via a pluggable transport.
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
import type { ObsidianTransport } from './transport.ts';

import { getTransportOptions } from './context-provider.ts';
import { generateFunctionCall } from './generate-function-call.ts';
import { serializeError } from './serialize-error.ts';
import { getOrCreateTransport } from './transport-factory.ts';

/**
 * Discriminated envelope returned by {@link evalWrapper} from inside the Obsidian process.
 *
 * - `{ type: 'error', value: string }` — `fn` threw; `value` is the serialized error.
 * - `{ type: 'undefined' }` — `fn` returned `undefined`.
 * - `{ value: unknown }` — `fn` returned a JSON-serializable value.
 */
type EvalResultEnvelope =
  | { type: 'error'; value: string }
  | { type: 'undefined' }
  | { value: unknown };

interface ExportsWithDefault {
  default: unknown;
}

const NO_OUTPUT = '(no output)';

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
   * Override the transport for this call. When omitted, uses the transport
   * configured via the context provider (set by the framework adapter's global setup).
   */
  transport?: ObsidianTransport;

  /**
   * The path to the Obsidian vault. Defaults to `process.cwd()`.
   */
  vaultPath?: string;
}

/**
 * A plain object with string keys.
 */
export type GenericObject = Record<string, unknown>;

interface EvalWrapperParams {
  args: Record<string, unknown>;
  contextId: string | undefined;
  fn: (args: Record<string, unknown>) => unknown;
  resolveObsidianModule: () => Promise<typeof obsidian>;
  stringifyError: (error: unknown, depth?: number) => string;
}

interface ObsidianModuleHolder {
  obsidianModule: typeof obsidian;
}

/* v8 ignore start -- Serialized via toString() and executed inside the Obsidian process, not in Node. Covered by integration tests. */

/**
 * Evaluates a function inside the running Obsidian instance
 * via the active transport and returns the parsed result.
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
  const { args = {}, contextId, fn, shouldSkipPreflightChecks = false, transport: transportOverride, vaultPath } = params;
  const cwd = vaultPath ?? process.cwd();

  // Check: Vault path exists on disk.
  if (vaultPath !== undefined && !existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}`);
  }

  const transport = transportOverride ?? await getOrCreateTransport(getTransportOptions());

  if (!shouldSkipPreflightChecks) {
    await transport.preflightCheck(cwd);
  }

  const expression = generateFunctionCall(evalWrapper, {
    args,
    contextId: contextId ? String(contextId) : undefined,
    fn,
    resolveObsidianModule: getObsidianModule,
    stringifyError: serializeError
  });

  const resultStr = await transport.evaluate(expression, { cwd });

  if (resultStr === '' || resultStr === NO_OUTPUT) {
    return undefined as Result;
  }

  let envelope: EvalResultEnvelope;
  try {
    envelope = JSON.parse(resultStr) as EvalResultEnvelope;
  } catch {
    throw new Error(`evalInObsidian: Obsidian returned non-JSON output: ${resultStr}`);
  }

  if ('type' in envelope) {
    if (envelope.type === 'error') {
      // Rewrite bare-origin localhost stack frames like "(http://localhost/:915:32)"
      // So Vitest's source-map resolver won't extract "/" as the file path and crash
      // With EISDIR when it tries to readFileSync on the root directory.
      const sanitizedDetail = envelope.value
        .replace(/\(https?:\/\/localhost\/:(?<line>\d)/g, '(obsidian-webview:$<line>');
      throw new Error(`evalInObsidian: Error inside Obsidian:\n${sanitizedDetail}`);
    }

    return undefined as Result;
  }

  return envelope.value as Result;
}

/**
 * The top-level wrapper that is serialized and invoked inside the Obsidian
 * process via {@link generateFunctionCall}. It wires up the obsidian module,
 * context, and error handling, then delegates to the caller-supplied `fn`.
 *
 * Must NOT reference any outer scope — it is serialized via `toString()`.
 *
 * @param params - The parameters for the wrapper.
 * @param params.args - The user-supplied arguments to pass to `fn`.
 * @param params.contextId - The context identifier for persistent storage.
 * @param params.fn - The user function to evaluate.
 * @param params.resolveObsidianModule - Resolves the `obsidian` module at runtime.
 * @param params.stringifyError - Serializes an error into a human-readable string.
 * @returns A JSON-stringified {@link EvalResultEnvelope}.
 */
async function evalWrapper({
  args,
  contextId,
  fn,
  resolveObsidianModule,
  stringifyError
}: EvalWrapperParams): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- We need global `app` variable.
  const app = window.app;
  if (!app.workspace.layoutReady) {
    await new Promise<void>((resolve) => {
      app.workspace.onLayoutReady(resolve);
    });
  }
  if (!app.plugins.isEnabled()) {
    await app.plugins.setEnable(true);
  }
  const obsidianModule = await resolveObsidianModule();
  interface ContextHolder {
    __obsidianContexts__: Record<string, Record<string, unknown>>;
  }
  const contextHolder = window as Partial<ContextHolder>;
  const context = contextId
    ? ((contextHolder.__obsidianContexts__ ??= {})[contextId] ??= {})
    : {};
  const fullArgs = Object.assign(args, { app, context, obsidianModule });
  try {
    const result = await fn(fullArgs);
    if (result === undefined) {
      return JSON.stringify({ type: 'undefined' });
    }
    return JSON.stringify({ value: result });
  } catch (evalError) {
    return JSON.stringify({ type: 'error', value: stringifyError(evalError) });
  }
}

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
    isDesktopOnly: false,
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

  /**
   * The body of the temporary plugin that extracts the `obsidian` module.
   * Serialized via `toString()` and written to `main.js` by {@link getObsidianModule}.
   * Must NOT reference any outer scope.
   */
  function getObsidianModulePluginFn(): void {
    // eslint-disable-next-line @typescript-eslint/no-deprecated, no-shadow -- We need global `app` variable. Intentional redeclaration — self-contained serialized function.
    const app = window.app;

    const obsidianModuleHolder2 = app as Partial<ObsidianModuleHolder>;

    const pluginRequire = require;
    const pluginExports = exports as ExportsWithDefault;

    const obsidianModule = pluginRequire('obsidian') as typeof obsidian;
    obsidianModuleHolder2.obsidianModule = obsidianModule;
    pluginExports.default = obsidianModule.Plugin;
  }
}

/* v8 ignore stop */
