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
import type { GenerateNamespaceCallParams } from './generate-function-call.ts';
import type { ObsidianTransport } from './transport.ts';

import {
  getTransportOptions,
  getVaultPath
} from './context-provider.ts';
import { generateNamespaceCall } from './generate-function-call.ts';
import { ensureNamespaceBootstrapped } from './namespace-bootstrap.ts';
import { getOrCreateTransport } from './transport-factory.ts';

interface EvalErrorEnvelope {
  type: 'error';
  value: string;
}

/**
 * Discriminated envelope returned by the registered `evalWrapper` from inside the Obsidian process.
 *
 * - `EvalErrorEnvelope` — `fn` threw; `value` is the serialized error.
 * - `EvalUndefinedEnvelope` — `fn` returned `undefined`.
 * - `EvalValueEnvelope` — `fn` returned a JSON-serializable value.
 */
type EvalResultEnvelope =
  | EvalErrorEnvelope
  | EvalUndefinedEnvelope
  | EvalValueEnvelope;

interface EvalUndefinedEnvelope {
  type: 'undefined';
}

interface EvalValueEnvelope {
  value: unknown;
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
  readonly args?: Args;

  /**
   * A {@link ContextId} linking this call to a persistent store on `window`
   * in the Obsidian process. The callback receives a typed `context` object
   * that survives across calls sharing the same ID.
   *
   * When omitted, `context` is a fresh empty object each call.
   */
  readonly contextId?: TContextId;

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
  readonly shouldSkipPreflightChecks?: boolean;

  /**
   * Override the transport for this call. When omitted, uses the transport
   * configured via the context provider (set by the framework adapter's global setup).
   */
  readonly transport?: ObsidianTransport;

  /**
   * The path to the Obsidian vault. Defaults to `process.cwd()`.
   */
  readonly vaultPath?: string;
}

/**
 * A plain object with string keys.
 */
export type GenericObject = Record<string, unknown>;

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
  const cwd = vaultPath ?? getVaultPath() ?? process.cwd();

  // Check: Vault path exists on disk.
  if (vaultPath !== undefined && !existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}`);
  }

  const transport = transportOverride ?? await getOrCreateTransport(getTransportOptions());

  if (!shouldSkipPreflightChecks) {
    await transport.preflightCheck(cwd);
  }

  await ensureNamespaceBootstrapped(transport, cwd);

  const namespaceCallParams: GenerateNamespaceCallParams = {
    args,
    fn,
    ...(contextId !== undefined && { contextId: String(contextId) })
  };

  const expression = generateNamespaceCall(namespaceCallParams);

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
