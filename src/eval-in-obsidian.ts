/**
 * @file
 *
 * Evaluates a function inside a running Obsidian instance via a pluggable transport.
 */

import type {
  App,
  Editor
} from 'obsidian';
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
   * Moves the mouse pointer to the center of an element using **trusted**
   * Electron pointer input, then polls until the element actually matches
   * `:hover`.
   *
   * Because the move is trusted (see {@link CommonArgs.moveMouse}), the real
   * `:hover` state takes effect in the CSS engine — real theme `var()` values
   * and real compositing — instead of a hand-simulated cascade. It polls the
   * live `element.matches(':hover')` state (not a fixed delay), so it is robust
   * under shared-instance load. It targets the single shared window's
   * **global** pointer, so only one element is hovered at a time.
   *
   * @param params - The element to hover.
   * @returns A {@link Promise} that resolves once the element matches `:hover`.
   */
  hoverElement(this: void, params: HoverElementParams): Promise<void>;

  /**
   * Moves the mouse pointer to the given web-contents coordinates using a
   * **trusted** Electron pointer move.
   *
   * A trusted move (injected via Electron's `webContents.sendInputEvent`)
   * updates the real pointer state in the CSS engine, so `:hover` rules
   * genuinely apply — unlike `dispatchEvent(new MouseEvent('mouseover'))`,
   * which is untrusted and never sets `:hover`. It targets the single shared
   * window's **global** pointer, so only one element is hovered at a time.
   *
   * This is the low-level primitive: it performs a single move and does **not**
   * wait for any state to settle (callers poll their own readiness signal).
   * Prefer {@link CommonArgs.hoverElement} / {@link CommonArgs.unhoverElement}
   * for element-relative moves; use `moveMouse` directly when an
   * element-relative target does not fit (e.g. an element spanning the full
   * viewport width).
   *
   * @param params - The web-contents DIP coordinates to move to.
   * @returns A {@link Promise} that resolves once the move has been injected.
   */
  moveMouse(this: void, params: MoveMouseParams): Promise<void>;

  /**
   * The `obsidian` module, resolved at runtime inside the Obsidian process.
   */
  obsidianModule: typeof obsidian;

  /**
   * Types text into a CodeMirror {@link Editor} using **trusted** Electron
   * keyboard input.
   *
   * A trusted event (injected via Electron's `webContents.sendInputEvent`)
   * behaves like a real keypress: it is delivered to the window's DOM-focused
   * element and flows through CodeMirror's real input pipeline, so the typed
   * text reaches the document **only if the editor genuinely holds focus**.
   * This makes "the user typed into the editor" a faithful end-to-end check,
   * unlike `dispatchEvent(new KeyboardEvent(...))` (untrusted — ignored by
   * CodeMirror) or `execCommand('insertText')` (mutates the selection even
   * when the editor is not focused, masking focus bugs as false positives).
   *
   * After injecting the keystrokes it polls until the document reflects the
   * input, or a bounded timeout elapses (the expected outcome when the editor
   * is read-only and rejects the input, or when focus was stolen).
   *
   * @param params - The editor to type into and the text to type.
   * @returns A {@link Promise} that resolves once the keystrokes have settled.
   */
  typeIntoEditor(this: void, params: TypeIntoEditorParams): Promise<void>;

  /**
   * Moves the mouse pointer to a point just outside an element's bounding box
   * using a **trusted** Electron pointer move, then polls until the element no
   * longer matches `:hover`.
   *
   * The inverse of {@link CommonArgs.hoverElement}. It targets the single
   * shared window's **global** pointer, so only one element is hovered at a
   * time. When an element spans the full viewport (no point outside its box is
   * reachable), use {@link CommonArgs.moveMouse} directly to move the pointer
   * to a known empty coordinate instead.
   *
   * @param params - The element to move the pointer away from.
   * @returns A {@link Promise} that resolves once the element no longer matches
   *   `:hover`.
   */
  unhoverElement(this: void, params: UnhoverElementParams): Promise<void>;
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
 * Parameters for {@link CommonArgs.hoverElement}.
 */
export interface HoverElementParams {
  /**
   * The element to hover. The pointer is moved to its center. This is a live
   * renderer DOM node — the callback runs in-renderer, so no cross-process
   * serialization is needed (same as {@link TypeIntoEditorParams.editor}).
   */
  readonly element: HTMLElement;
}

/**
 * Parameters for {@link CommonArgs.moveMouse}.
 */
export interface MoveMouseParams {
  /**
   * The x coordinate (web-contents DIP) to move the pointer to.
   */
  readonly x: number;

  /**
   * The y coordinate (web-contents DIP) to move the pointer to.
   */
  readonly y: number;
}

/**
 * Parameters for {@link CommonArgs.typeIntoEditor}.
 */
export interface TypeIntoEditorParams {
  /**
   * The editor to type into. It is focused (with the caret moved to the end of
   * the document) before the keystrokes are injected.
   */
  readonly editor: Editor;

  /**
   * The text to type, one trusted character event per code point.
   */
  readonly text: string;
}

/**
 * Parameters for {@link CommonArgs.unhoverElement}.
 */
export interface UnhoverElementParams {
  /**
   * The element to move the pointer away from. The pointer is moved to a point
   * just outside its bounding box. This is a live renderer DOM node — the
   * callback runs in-renderer, so no cross-process serialization is needed
   * (same as {@link TypeIntoEditorParams.editor}).
   */
  readonly element: HTMLElement;
}

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
