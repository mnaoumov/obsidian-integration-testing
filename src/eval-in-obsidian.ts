/**
 * @file
 *
 * Evaluates a function inside a running Obsidian instance via a pluggable transport.
 */

import type {
  App,
  Editor,
  Modifier,
  TFile
} from 'obsidian';
// eslint-disable-next-line import-x/no-namespace -- We need to reference `obsidian` module.
import type * as obsidian from 'obsidian';
import type { Promisable } from 'type-fest';

import { existsSync } from 'node:fs';
import process from 'node:process';

import type {
  ContextArguments,
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
 * - `EvalErrorEnvelope` — `callback` threw; `value` is the serialized error.
 * - `EvalUndefinedEnvelope` — `callback` returned `undefined`.
 * - `EvalValueEnvelope` — `callback` returned a JSON-serializable value.
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
 * Parameters for {@link CommonArguments.clickElement}.
 */
export interface ClickElementParams {
  /**
   * The mouse button to press.
   *
   * @default `'left'`
   */
  readonly button?: MouseButton;

  /**
   * The element to click. The pointer is moved to its center. This is a live
   * renderer DOM node — the callback runs in-renderer, so no cross-process
   * serialization is needed (same as {@link TypeIntoEditorParams.editor}).
   */
  readonly element: HTMLElement;

  /**
   * The modifier keys to hold, using Obsidian's {@link Modifier} names. `'Mod'`
   * resolves per-platform (Cmd on macOS, Ctrl elsewhere).
   *
   * @default `[]`
   */
  readonly modifiers?: readonly Modifier[];
}

/**
 * Parameters for {@link CommonArguments.clickMouse}.
 */
export interface ClickMouseParams {
  /**
   * The mouse button to press.
   *
   * @default `'left'`
   */
  readonly button?: MouseButton;

  /**
   * The modifier keys to hold, using Obsidian's {@link Modifier} names. `'Mod'`
   * resolves per-platform (Cmd on macOS, Ctrl elsewhere).
   *
   * @default `[]`
   */
  readonly modifiers?: readonly Modifier[];

  /**
   * The x coordinate (web-contents DIP) to click at.
   */
  readonly x: number;

  /**
   * The y coordinate (web-contents DIP) to click at.
   */
  readonly y: number;
}

/**
 * Common arguments automatically provided to every {@link evalInObsidian} callback.
 */
export interface CommonArguments {
  /**
   * The Obsidian {@link App} instance.
   */
  app: App;

  /**
   * The shared library bag injected into every callback — see {@link Lib}.
   *
   * Never empty: the harness pre-populates a **base** set of renderer-driving
   * helpers (trusted input — `typeIntoEditor` / `pressKey` / `moveMouse` /
   * `clickMouse` / `hoverElement` / `unhoverElement` / `clickElement` — plus
   * `waitUntil`, `createNote` and `openSettingsTab`), and provider packages
   * (chiefly `obsidian-dev-utils`) `Object.assign` their whole renderer-safe
   * library on top via {@link registerLibResolver}. A serialized closure reaches
   * every shared helper through `lib` — `lib.typeIntoEditor({ editor, text })`,
   * `lib.getFileOrNull({ app, … })` — instead of importing or hand-rolling them.
   */
  lib: Lib;

  /**
   * The `obsidian` module, resolved at runtime inside the Obsidian process.
   */
  obsidianModule: typeof obsidian;
}

/**
 * Parameters for {@link CommonArguments.createNote}.
 */
export interface CreateNoteParams {
  /**
   * The note's content. This exact string is what the created note is read back
   * against, so it is the definition of a successful write.
   */
  readonly content: string;

  /**
   * The vault-relative path to create, extension included.
   */
  readonly path: string;
}

/**
 * Parameters for {@link evalInObsidian}.
 */
export interface EvalInObsidianParams<Input extends GenericObject, Result, TContextId extends ContextId<unknown> | undefined = undefined> {
  /**
   * The function to evaluate in the Obsidian context.
   */
  callback(input: CommonArguments & ContextArguments<TContextId> & Input): Promisable<Result>;

  /**
   * A {@link ContextId} linking this call to a persistent store on `window`
   * in the Obsidian process. The callback receives a typed `context` object
   * that survives across calls sharing the same ID.
   *
   * When omitted, `context` is a fresh empty object each call.
   */
  readonly contextId?: TContextId;

  /**
   * Additional arguments to pass to the function. Values may include functions —
   * they are serialized via `toString()`.
   */
  readonly input?: Input;

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
 * Parameters for {@link CommonArguments.hoverElement}.
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
 * The shared library bag injected into every {@link evalInObsidian} callback as
 * {@link CommonArguments.lib}.
 *
 * Two layers compose into this one bag. The **base** — the harness-provided
 * renderer-driving helpers declared below (the trusted-input primitives and
 * {@link Lib.waitUntil}) — is always present. On top, provider packages register
 * a renderer-side resolver via {@link registerLibResolver} to `Object.assign`
 * their whole renderer-safe library at runtime, and augment this **augmentable**
 * interface (the `i18next` `CustomTypeOptions` idiom) via
 * `declare module 'obsidian-integration-testing'` to type it. Multiple providers
 * compose: their exports merge at runtime and their augmentations merge in the
 * type system (`interface Lib extends …`).
 *
 * @example
 * ```ts
 * declare module 'obsidian-integration-testing' {
 *   interface Lib extends (typeof import('obsidian-dev-utils/__merged')) {}
 * }
 * ```
 */
export interface Lib {
  /**
   * Clicks the center of an element using **trusted** Electron pointer input.
   *
   * The element-relative counterpart of {@link Lib.clickMouse}, mirroring the
   * {@link Lib.moveMouse} / {@link Lib.hoverElement} split. Use
   * {@link Lib.clickMouse} directly when the point to click is **not** the
   * element's center — the markdown editor's margin, for instance, lies inside
   * `cm.scrollDOM` but outside `.cm-sizer`, so no element's center lands on it.
   *
   * Synchronous: injecting the trusted click does no real awaiting, so the
   * caller does not need to `await` it.
   *
   * @param params - The element to click, the button to press and any modifiers
   *   to hold.
   */
  clickElement(this: void, params: ClickElementParams): void;

  /**
   * Clicks at the given web-contents coordinates using **trusted** Electron
   * pointer input, so Chromium synthesizes a real `click` (or `contextmenu`,
   * for the right button) with `isTrusted === true`.
   *
   * This is what `element.dispatchEvent(new MouseEvent('click'))` cannot do:
   * Obsidian and CodeMirror gate on `isTrusted`, so a dispatched event silently
   * exercises nothing while the test still passes whatever weaker assertion it
   * makes. Obsidian 1.13.7's markdown viewport (margin) menu, for example,
   * opens from a `cm.scrollDOM` `contextmenu` listener guarded by
   * `e.isTrusted`, which a dispatched event never gets past.
   *
   * It is the low-level primitive: a single trusted `mouseMove` → `mouseDown` →
   * `mouseUp` at one point, with no waiting for any effect (callers poll their
   * own readiness signal). The leading move is what puts the pointer over the
   * hit-test target before the button goes down. Prefer
   * {@link Lib.clickElement} for element-relative clicks.
   *
   * A real context menu actually opens, so a suite driving a right click must
   * close it (or remove the leftover `.menu` element) before the next test.
   *
   * Synchronous: injecting the trusted click does no real awaiting, so the
   * caller does not need to `await` it.
   *
   * @param params - The web-contents DIP coordinates to click at, the button to
   *   press and any modifiers to hold.
   */
  clickMouse(this: void, params: ClickMouseParams): void;

  /**
   * Creates a note and does not return until its content is verifiably on
   * disk, rewriting it if it is not.
   *
   * Use this instead of `app.vault.create` in any suite that may run on
   * Android. The emulator transport loses roughly **0.9 %** of `vault.create`
   * writes (measured: 7 lost in 800 creates): the file lands **0 bytes** on
   * disk while Obsidian's in-memory `TFile.stat` reports the full byte count,
   * and it does not heal on its own. A suite doing ~34 creates per run
   * therefore has a ~26 % chance of at least one lost write, and whichever test
   * loses that lottery fails on a `waitUntil` for content that was never
   * written — which is why it reads as an unrelated per-test flake rather than
   * one shared cause.
   *
   * Verification is by **reading the note back**, never by inspecting
   * `TFile.stat`: `stat` is exactly the field that lies here. A rewrite through
   * `vault.modify` with the same content lands correctly (also measured), so a
   * lost write costs a retry rather than a failure. A note whose content still
   * does not match after the bounded retries throws, naming the path and both
   * lengths, so a genuinely broken write fails loudly instead of spinning.
   *
   * Harmless everywhere else — on a transport that does not lose writes the
   * read-back matches first time and nothing is rewritten.
   *
   * @param params - The note path and content.
   * @returns A {@link Promise} resolving to the created file, once its content
   *   is confirmed.
   */
  createNote(this: void, params: CreateNoteParams): Promise<TFile>;

  /**
   * Moves the mouse pointer to the center of an element using **trusted**
   * Electron pointer input, then polls until the element actually matches
   * `:hover`.
   *
   * Because the move is trusted (see {@link Lib.moveMouse}), the real `:hover`
   * state takes effect in the CSS engine — real theme `var()` values and real
   * compositing — instead of a hand-simulated cascade. It polls the live
   * `element.matches(':hover')` state (not a fixed delay), so it is robust under
   * shared-instance load. It targets the single shared window's **global**
   * pointer, so only one element is hovered at a time.
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
   * Prefer {@link Lib.hoverElement} / {@link Lib.unhoverElement} for
   * element-relative moves; use `moveMouse` directly when an element-relative
   * target does not fit (e.g. an element spanning the full viewport width).
   *
   * Synchronous: injecting the trusted move does no real awaiting, so the caller
   * does not need to `await` it.
   *
   * @param params - The web-contents DIP coordinates to move to.
   */
  moveMouse(this: void, params: MoveMouseParams): void;

  /**
   * Opens Obsidian's settings modal on a given tab, and does not return until
   * that tab has actually rendered.
   *
   * **This exists because `app.setting.open()` on its own does not work from a
   * test.** `app.setting.containerEl` is built at startup but is never in the
   * document, and `open()` does not attach it — so the modal builds into a
   * detached tree, `open()` returns without throwing, and a screenshot taken
   * afterwards shows the untouched document. That is what made the settings tab
   * look impossible to capture, and got recorded as such in two plugins.
   *
   * The fix is one step, and its **order is load-bearing**: the container is
   * appended to `document.body` **before** `open()`. Attaching afterwards is too
   * late — whatever the modal drew on open has already gone into the detached
   * container, so it ends up on screen showing the wrong thing. That failure
   * looks like success until the captured frame is examined, which is the trap
   * this helper exists to remove.
   *
   * Re-attaching is idempotent, so a tab closed with `app.setting.close()` can
   * simply be re-opened.
   *
   * @param params - The tab to open and how long to wait for it to render.
   * @returns A {@link Promise} resolving to the names of the setting rows the
   *   tab rendered — both the proof it rendered and what a caller asserts on. A
   *   tab that legitimately renders no `.setting-item-name` rows (Hotkeys, say)
   *   resolves to an empty array.
   * @throws Error if no tab carries {@link OpenSettingsTabParams.tabId}, or if
   *   the tab does not render within the timeout.
   */
  openSettingsTab(this: void, params: OpenSettingsTabParams): Promise<string[]>;

  /**
   * Presses a single key (optionally with modifiers) using **trusted** Electron
   * keyboard input, firing the full real key pipeline —
   * `keydown` → `keypress` → `beforeinput` → `input` → `keyup`.
   *
   * This is the key-press analog of {@link Lib.typeIntoEditor}: it injects a
   * trusted `keyDown` → `char` → `keyUp` sequence via Electron's
   * `webContents.sendInputEvent`, so it is delivered to the window's DOM-focused
   * element and flows through the real input pipeline — unlike
   * `dispatchEvent(new KeyboardEvent(...))`, which is untrusted (`isTrusted:
   * false`) and ignored by CodeMirror and most key handlers. Use it for special
   * keys (`'Enter'`, `'Escape'`, `'Tab'`, arrow keys) and modifier combinations
   * (`Shift+Enter`, `Ctrl+A`) that {@link Lib.typeIntoEditor} (which types
   * printable text) does not cover.
   *
   * This is the low-level primitive: it injects the key press and does **not**
   * poll for any effect (a key press has no universal observable outcome —
   * `Enter` edits the document, `Escape` closes a modal, `ArrowDown` moves the
   * selection). The caller focuses the intended target first, then awaits the
   * expected effect via {@link Lib.waitUntil}. It targets the single shared
   * window's **global** focus, so only the DOM-focused element receives the key.
   *
   * Synchronous: injecting the trusted key press does no real awaiting, so the
   * caller does not need to `await` it.
   *
   * @param params - The key to press and any modifiers to hold.
   */
  pressKey(this: void, params: PressKeyParams): void;

  /**
   * Types text into a CodeMirror {@link Editor} using **trusted** Electron
   * keyboard input.
   *
   * Typing is pressing each character key in turn: this focuses the editor
   * (caret to end) and presses every code point of `text` via
   * {@link Lib.pressKey} — the same trusted `keyDown` → `char` → `keyUp` a real
   * user produces. Each keystroke is delivered to the window's DOM-focused
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
   * The inverse of {@link Lib.hoverElement}. It targets the single shared
   * window's **global** pointer, so only one element is hovered at a time. When
   * an element spans the full viewport (no point outside its box is reachable),
   * use {@link Lib.moveMouse} directly to move the pointer to a known empty
   * coordinate instead.
   *
   * @param params - The element to move the pointer away from.
   * @returns A {@link Promise} that resolves once the element no longer matches
   *   `:hover`.
   */
  unhoverElement(this: void, params: UnhoverElementParams): Promise<void>;

  /**
   * Polls a predicate until it becomes truthy, or rejects once a bounded
   * timeout elapses.
   *
   * Integration-test `evalInObsidian` callbacks routinely need to wait for an
   * asynchronous effect to settle (a view to open, a DOM node to appear, a
   * setting to apply). Because the callback is serialized via `toString()` and
   * cannot import modules, it can't reuse `obsidian-dev-utils`'
   * `retryWithTimeout` / `runWithTimeout`. This helper is the shared, injected
   * replacement for the per-closure poll loops consumers would otherwise
   * hand-roll.
   *
   * The `predicate` may be synchronous or asynchronous — it is awaited on every
   * poll. It is checked immediately, then re-checked every
   * `intervalInMilliseconds` until it returns truthy or `timeoutInMilliseconds`
   * elapses, at which point the returned {@link Promise} rejects (the error
   * includes `message` when provided).
   *
   * @param params - The predicate to poll plus optional timeout, interval, and
   *   timeout message.
   * @returns A {@link Promise} that resolves once the predicate is truthy.
   */
  waitUntil(this: void, params: WaitUntilParams): Promise<void>;
}

/**
 * The mouse button a trusted click presses, in Electron's `sendInputEvent`
 * spelling.
 */
export type MouseButton = 'left' | 'middle' | 'right';

/**
 * Parameters for {@link CommonArguments.moveMouse}.
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
 * Parameters for {@link Lib.openSettingsTab}.
 */
export interface OpenSettingsTabParams {
  /**
   * The id of the settings tab to open — a plugin id for a plugin's own tab, or
   * a core tab id (`'editor'`, `'hotkeys'`, …).
   *
   * Required, because opening the modal without naming a tab renders **nothing**
   * on a harness-owned instance: the modal restores the last tab the profile
   * used, and an isolated profile has never opened one, so `activeTab` stays
   * `null` and no row is drawn. An unknown id is rejected immediately, listing
   * the ids that do exist.
   */
  readonly tabId: string;

  /**
   * The maximum time to wait for the modal to open and for the requested tab to
   * render its content.
   *
   * @default `5000`
   */
  readonly timeoutInMilliseconds?: number;
}

/**
 * Parameters for {@link CommonArguments.pressKey}.
 */
export interface PressKeyParams {
  /**
   * The key to press, given as an Electron Accelerator key name — e.g.
   * `'Enter'`, `'Escape'`, `'Tab'`, `'Backspace'`, `'Delete'`, an arrow key
   * (`'Up'` / `'Down'` / `'Left'` / `'Right'`), or a printable character
   * (`'a'`, `'1'`). The produced character (when the key inserts text) is the
   * literal `key` value; case-correct text belongs to
   * {@link CommonArguments.typeIntoEditor}, not a key-press primitive.
   */
  readonly key: string;

  /**
   * The modifier keys to hold while the key is pressed, using Obsidian's
   * {@link Modifier} names (the same values as an Obsidian `Hotkey`). `'Mod'`
   * resolves per-platform (Cmd on macOS, Ctrl elsewhere); each is mapped to
   * Electron's lowercase `sendInputEvent` modifier name.
   *
   * @default `[]`
   */
  readonly modifiers?: readonly Modifier[];
}

/**
 * Parameters for {@link CommonArguments.typeIntoEditor}.
 */
export interface TypeIntoEditorParams {
  /**
   * The editor to type into. It is focused (with the caret moved to the end of
   * the document) before the keystrokes are injected.
   */
  readonly editor: Editor;

  /**
   * The text to type. Each code point is pressed via {@link CommonArguments.pressKey}
   * (a trusted `keyDown` → `char` → `keyUp`), exactly as a real user typing.
   */
  readonly text: string;
}

/**
 * Parameters for {@link CommonArguments.unhoverElement}.
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
 * Parameters for {@link CommonArguments.waitUntil}.
 */
export interface WaitUntilParams {
  /**
   * The polling interval between predicate checks.
   *
   * @default `50`
   */
  readonly intervalInMilliseconds?: number;

  /**
   * An optional detail appended to the timeout error message, describing what
   * was being waited for.
   */
  readonly message?: string;

  /**
   * The condition to wait for. Polled immediately, then on every interval until
   * it returns a truthy value. May be synchronous or asynchronous — it is
   * awaited on each poll.
   *
   * @returns Whether the awaited condition has been met.
   */
  predicate(this: void): boolean | Promise<boolean>;

  /**
   * The maximum time to wait before rejecting.
   *
   * @default `5000`
   */
  readonly timeoutInMilliseconds?: number;
}

/**
 * Evaluates a function inside the running Obsidian instance
 * via the active transport and returns the parsed result.
 *
 * The function receives an input object that includes `app`, `obsidianModule`,
 * `context`, and any additional `input` passed by the caller.
 * It is serialized via `toString()` and invoked as an IIFE.
 * The function must be self-contained — closures over local variables will not work.
 * Pass any needed values as `input` — they are JSON-serialized and deserialized on the Obsidian side.
 *
 * The result is `JSON.stringify`'d on the Obsidian side and parsed back.
 *
 * @param params - The parameters for the function to evaluate.
 * @returns A {@link Promise} that resolves to the return value of `callback`.
 */
export async function evalInObsidian<Input extends GenericObject, Result, TContextId extends ContextId<unknown> | undefined = undefined>(
  params: EvalInObsidianParams<Input, Result, TContextId>
): Promise<Result> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- `callback` can be unbound.
  const { callback, contextId, input = {}, shouldSkipPreflightChecks = false, transport: transportOverride, vaultPath } = params;
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
    callback,
    input,
    ...(contextId !== undefined && { contextId: String(contextId) })
  };

  const expression = generateNamespaceCall(namespaceCallParams);

  const resultString = await transport.evaluate(expression, { cwd });

  if (resultString === '' || resultString === NO_OUTPUT) {
    return undefined as Result;
  }

  let envelope: EvalResultEnvelope;
  try {
    envelope = JSON.parse(resultString) as EvalResultEnvelope;
  } catch {
    throw new Error(`evalInObsidian: Obsidian returned non-JSON output: ${resultString}`);
  }

  if ('type' in envelope) {
    if (envelope.type === 'error') {
      // Rewrite bare-origin localhost stack frames like "(http://localhost/:915:32)"
      // So Vitest's source-map resolver won't extract "/" as the file path and crash
      // With EISDIR when it tries to readFileSync on the root directory.
      const sanitizedDetail = envelope.value
        .replaceAll(/\(https?:\/\/localhost\/:(?<line>\d)/g, '(obsidian-webview:$<line>');
      throw new Error(`evalInObsidian: Error inside Obsidian:\n${sanitizedDetail}`);
    }

    return undefined as Result;
  }

  return envelope.value as Result;
}
