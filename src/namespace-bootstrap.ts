/**
 * @file
 *
 * Bootstraps the `window.__obsidianIntegrationTesting` namespace in the
 * Obsidian process. Extracted to its own module to avoid dependency cycles
 * between `eval-in-obsidian.ts` and the transport modules.
 */

import type { App } from 'obsidian';

import type {
  HoverElementParams,
  MoveMouseParams,
  PressKeyParams,
  TypeIntoEditorParams,
  UnhoverElementParams,
  WaitUntilParams
} from './eval-in-obsidian.ts';
import type { GenerateFunctionCallParams } from './generate-function-call.ts';
import type { LibResolver } from './lib-registry.ts';
import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { generateFunctionCall } from './generate-function-call.ts';
import {
  getBootstrapVersion,
  getRegisteredLibResolvers
} from './lib-registry.ts';

interface BootstrapNamespaceParams {
  readonly libResolvers: LibResolver[];
  readonly version: string;
}

/**
 * Ensures the `window.__obsidianIntegrationTesting` namespace is bootstrapped
 * in the Obsidian process with the current library version.
 *
 * Performs a lightweight version check via the transport. If the namespace
 * doesn't exist or has a different version, sends the full bootstrap expression
 * to register all helper functions.
 *
 * @param transport - The transport to use for evaluation.
 * @param cwd - The working directory (vault path).
 * @param timeoutInMilliseconds - Optional per-eval timeout. Forwarded to both
 *   the version check and the bootstrap eval so a hung `obsidian eval` rejects
 *   instead of blocking the caller indefinitely.
 */
export async function ensureNamespaceBootstrapped(transport: ObsidianTransport, cwd: string, timeoutInMilliseconds?: number): Promise<void> {
  const evalOptions: TransportEvalOptions = {
    cwd,
    ...(timeoutInMilliseconds !== undefined && { timeoutInMilliseconds })
  };
  const bootstrapVersion = getBootstrapVersion();
  const versionJson = JSON.stringify(bootstrapVersion);
  const checkResult = await transport.evaluate(
    `JSON.stringify(window.__obsidianIntegrationTesting?.version === ${versionJson})`,
    evalOptions
  );

  if (checkResult === 'true') {
    return;
  }

  const bootstrapExpr = generateFunctionCall(bootstrapNamespace, {
    libResolvers: [...getRegisteredLibResolvers()],
    version: bootstrapVersion
  });
  await transport.evaluate(bootstrapExpr, evalOptions);
}

/* v8 ignore start -- Serialized via toString() and executed inside the Obsidian process, not in Node. Covered by integration tests. */

/**
 * Bootstraps the `window.__obsidianIntegrationTesting` namespace with all
 * helper functions. Serialized via `toString()` and sent to Obsidian once
 * per library version.
 *
 * Preserves `contexts` across version upgrades so live {@link ContextId}
 * references survive.
 *
 * Must NOT reference any outer scope — it is serialized via `toString()`.
 *
 * @param bootstrapParams - The parameters including the library version.
 */
function bootstrapNamespace(bootstrapParams: GenerateFunctionCallParams<BootstrapNamespaceParams>): void {
  interface IntegrationTestingHolder {
    __obsidianIntegrationTesting: IntegrationTestingNamespaceState;
  }

  interface IntegrationTestingNamespaceState {
    contexts: Record<string, Record<string, unknown>>;
    libResolvers: LibResolver[];
    obsidianModule?: unknown;
    version: string;
  }

  interface IntegrationTestingNamespace extends IntegrationTestingNamespaceState {
    /**
     * Intentionally NOT migrated to `obsidian-dev-utils`: trivial — reads
     * `window.app`, which every closure already receives directly as its `app`
     * arg, so there is nothing general-purpose to share.
     */
    readonly app: App;

    /**
     * Intentionally NOT migrated to `obsidian-dev-utils`: transport-only. It
     * owns the harness test window's lifecycle via Electron (`window.electronWindow`),
     * which is the harness's concern, not a general utility.
     */
    destroyCurrentWindow(): Promise<void>;

    /**
     * Synced with `obsidian-dev-utils` (mirror `workspace.ts`) — see L17.
     */
    ensureLayoutReady(): Promise<void>;

    /**
     * Synced with `obsidian-dev-utils` (mirror `error.ts`) — see L17.
     */
    errorToString(error: unknown): string;

    /**
     * Intentionally NOT migrated to `obsidian-dev-utils`: transport-only. This
     * is the harness's own eval plumbing (builds the `lib` bag, resolves the
     * module, invokes the closure, envelopes the result) — meaningless outside
     * the harness.
     */
    evalWrapper(nsParams: EvalWrapperParams): Promise<string>;

    /**
     * Intentionally NOT migrated to `obsidian-dev-utils`: transport-only. It is
     * the harness's one-time bootstrap that resolves the `obsidian` module for
     * the process; closures obtain it directly via their `obsidianModule` arg.
     */
    getObsidianModule(): Promise<unknown>;

    /**
     * Intentionally NOT migrated to `obsidian-dev-utils`: transport-only. Raw
     * Electron IPC (`window.electron.ipcRenderer.sendSync`) is a harness/transport
     * primitive, not a general-purpose helper.
     */
    ipcSendSync(nsParams: IpcSendSyncParams): Promise<void>;

    /**
     * Intentionally NOT migrated to `obsidian-dev-utils`: transport-only. It is
     * part of the harness's vault-path handshake with the Node side, not a
     * general utility.
     */
    pollVaultBasePath(): Promise<string>;

    /**
     * Intentionally NOT migrated to `obsidian-dev-utils`: niche/trivial — a
     * one-line `localStorage.setItem` wrapper used only by the harness.
     */
    setLocalStorageItem(nsParams: SetLocalStorageItemParams): Promise<void>;
  }

  interface EvalWrapperParams {
    readonly args: Record<string, unknown>;
    readonly contextId?: string;
    fn(fnArgs: Record<string, unknown>): unknown;
  }

  interface FileSystemAdapterLike {
    basePath?: string;
    getBasePath?: () => string;
  }

  interface IpcSendSyncParams {
    readonly args: unknown[];
    readonly channel: string;
  }

  // Community-plugin API members that old Obsidian versions (e.g. 0.6.x) lack.
  // `obsidian-typings` declares them as always-present, so probe through this
  // Optional-member view to detect their runtime absence without a false
  // `no-unnecessary-condition`.
  interface PluginsLike {
    isEnabled?: () => boolean;
    loadPlugin?: (id: string) => Promise<void>;
    manifests?: unknown;
  }

  interface SetLocalStorageItemParams {
    readonly key: string;
    readonly value: string;
  }

  // `Vault.configDir` is declared always-present by `obsidian-typings`, but old
  // Obsidian versions (e.g. 0.9.10) leave it undefined at runtime. Probe through
  // This optional-member view so a `?? '.obsidian'` default is not flagged as an
  // Unnecessary condition.
  interface VaultLike {
    configDir?: string;
  }

  type CurrentWebContents = ReturnType<Window['electron']['remote']['getCurrentWebContents']>;

  // The Electron modifier-key names `sendInputEvent` accepts (e.g. 'meta', 'control', 'shift', 'alt').
  // Derived from the web-contents type so it stays in sync with the Electron typings.
  type ElectronModifier = NonNullable<Parameters<CurrentWebContents['sendInputEvent']>[0]['modifiers']>[number];

  interface ObsidianModuleWithPlatform {
    Platform: ObsidianPlatform;
  }

  interface ObsidianPlatform {
    isMacOS: boolean;
  }

  /**
   * Delay (in ms) before invoking `electronWindow.destroy()` so the eval that
   * triggered the call has time to return its result to the caller. Without
   * it the renderer dies before the IPC reply ships, the caller waits for the
   * full eval timeout, and stale `BrowserWindow` entries pile up.
   */
  const DESTROY_DELAY_IN_MILLISECONDS = 50;

  /**
   * Interval (in ms) between polls while waiting for a trusted input event to
   * take effect (the editor document updates, or an element's `:hover` state
   * flips). Shared by every trusted-input helper.
   */
  const INPUT_POLL_INTERVAL_IN_MILLISECONDS = 50;

  /**
   * Maximum time (in ms) to wait for a trusted input event to take effect
   * before giving up (the expected outcome when the input is rejected — e.g. a
   * read-only editor, or a pointer move that never lands on the element).
   */
  const INPUT_TIMEOUT_IN_MILLISECONDS = 5000;

  /**
   * Default interval (in ms) between {@link waitUntil} predicate checks when the
   * caller does not override it.
   */
  const WAIT_UNTIL_POLL_INTERVAL_IN_MILLISECONDS = 50;

  /**
   * Default maximum time (in ms) {@link waitUntil} waits for its predicate to
   * become truthy before rejecting, when the caller does not override it.
   */
  const WAIT_UNTIL_TIMEOUT_IN_MILLISECONDS = 5000;

  /**
   * Prefix used by {@link errorToString}'s nested-error separator lines, matching
   * the `    at` prefix of a V8 stack-trace frame so the separators blend into
   * the surrounding stack. Kept identical to `obsidian-dev-utils`' `errorToString`.
   */
  const STACK_TRACE_PREFIX = '    at';

  // eslint-disable-next-line no-restricted-syntax -- Approved double cast: `__obsidianIntegrationTesting` is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
  const holder = window as unknown as Partial<IntegrationTestingHolder>;
  const existingContexts = holder.__obsidianIntegrationTesting?.contexts ?? {};
  const existingObsidianModule = holder.__obsidianIntegrationTesting?.obsidianModule;

  const ns: IntegrationTestingNamespace = {
    get app() {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- `app` getter reads `window.app` which is set by Obsidian.
      return window.app;
    },

    contexts: existingContexts,

    async destroyCurrentWindow(this: IntegrationTestingNamespace): Promise<void> {
      await this.ensureLayoutReady();
      await sleep(0);
      const electronWindow = window.electronWindow;
      window.setTimeout(() => {
        electronWindow.destroy();
      }, DESTROY_DELAY_IN_MILLISECONDS);
    },

    async ensureLayoutReady(this: IntegrationTestingNamespace): Promise<void> {
      await new Promise<void>((resolve) => {
        this.app.workspace.onLayoutReady(resolve);
      });
    },

    errorToString(this: IntegrationTestingNamespace, error: unknown): string {
      return errorToStringImpl(error);
    },

    async evalWrapper(this: IntegrationTestingNamespace, params): Promise<string> {
      // Old Obsidian (e.g. 0.6.x) predates the community-plugin API: `plugins`
      // Exists but has no `isEnabled`/`setEnable`, and there are no third-party
      // Plugins to enable, so skip this step when the API is absent.
      // eslint-disable-next-line no-restricted-syntax -- probe the runtime-optional community-plugin API.
      const plugins = this.app.plugins as unknown as PluginsLike;
      if (plugins.isEnabled && !plugins.isEnabled()) {
        await this.app.plugins.setEnable(true);
      }
      const obsidianModule = await this.getObsidianModule();
      // Avoid `??=`: old Obsidian's Chromium (e.g. 0.6.x on Chromium 80) predates
      // ES2021 logical-assignment and cannot parse it in this serialized bootstrap.
      let context: Record<string, unknown> = {};
      if (params.contextId) {
        const existingContext = this.contexts[params.contextId];
        if (existingContext) {
          context = existingContext;
        } else {
          this.contexts[params.contextId] = context;
        }
      }
      // The injected `lib` bag: base helpers from the harness, then providers on top.
      // Resolvers run in-renderer (they read renderer globals a provider published).
      // Rebuilding per eval keeps `lib` fresh and tolerant of a late-loaded provider.
      const lib = { hoverElement, moveMouse, pressKey, typeIntoEditor, unhoverElement, waitUntil };
      for (const resolveLib of this.libResolvers) {
        Object.assign(lib, resolveLib());
      }
      const fullArgs = { ...params.args, app: this.app, context, lib, obsidianModule };
      try {
        const result = await params.fn(fullArgs);
        if (result === undefined) {
          return JSON.stringify({ type: 'undefined' });
        }
        return JSON.stringify({ value: result });
      } catch (evalError) {
        return JSON.stringify({ type: 'error', value: this.errorToString(evalError) });
      }
    },

    async getObsidianModule(this: IntegrationTestingNamespace): Promise<unknown> {
      if (this.obsidianModule) {
        return this.obsidianModule;
      }

      // The temp-plugin trick below resolves `require('obsidian')`, which only
      // Works inside a plugin-load context. It needs the community-plugin registry
      // (`loadPlugin` + `manifests`); versions that lack it entirely (e.g. 0.6.x has
      // No `manifests`) cannot run it, so return `undefined` — app-only closures
      // Still run.
      // eslint-disable-next-line no-restricted-syntax -- probe the runtime-optional community-plugin API.
      const plugins = this.app.plugins as unknown as PluginsLike;
      if (!plugins.loadPlugin || !plugins.manifests) {
        return undefined;
      }

      const SLICE_START = 2;
      const randomSuffix = String(Math.random()).slice(SLICE_START);
      const tempModuleName = `get-obsidian-module-${randomSuffix}`;
      // Old versions (e.g. 0.9.10) leave `vault.configDir` undefined; fall back to
      // Obsidian's default config dir so the temp plugin still gets a valid path,
      // Loads, and its `require('obsidian')` resolves the module.
      // eslint-disable-next-line no-restricted-syntax -- configDir is runtime-optional on old versions.
      const configDir = (this.app.vault as unknown as VaultLike).configDir ?? '.obsidian';
      const pluginsDir = `${configDir}/plugins`;
      const dir = `${pluginsDir}/${tempModuleName}`;
      this.app.plugins.manifests[tempModuleName] = {
        author: '',
        description: '',
        dir,
        id: tempModuleName,
        isDesktopOnly: false,
        minAppVersion: '',
        name: tempModuleName,
        version: ''
      };
      // `adapter.mkdir` is not recursive, and an old version on a fresh vault may not
      // Have the config/plugins dirs yet — create the chain so `loadPlugin` finds the
      // Temp plugin at `<configDir>/plugins/<id>`.
      if (!(await this.app.vault.adapter.exists(configDir))) {
        await this.app.vault.adapter.mkdir(configDir);
      }
      if (!(await this.app.vault.adapter.exists(pluginsDir))) {
        await this.app.vault.adapter.mkdir(pluginsDir);
      }
      await this.app.vault.adapter.mkdir(dir);

      const pluginFnBody = 'const r=require,e=exports;const m=r(\'obsidian\');window.__obsidianIntegrationTesting.obsidianModule=m;e.default=m.Plugin;';
      await this.app.vault.adapter.write(`${dir}/main.js`, pluginFnBody);

      await this.app.plugins.loadPlugin(tempModuleName);
      await this.app.plugins.uninstallPlugin(tempModuleName);

      if (this.obsidianModule) {
        return this.obsidianModule;
      }

      throw new Error('Failed to load obsidian module');
    },

    async ipcSendSync(this: IntegrationTestingNamespace, params): Promise<void> {
      await this.ensureLayoutReady();
      window.electron.ipcRenderer.sendSync(params.channel, ...params.args);
    },

    libResolvers: bootstrapParams.libResolvers,

    obsidianModule: existingObsidianModule,

    async pollVaultBasePath(this: IntegrationTestingNamespace): Promise<string> {
      // Old Obsidian versions (e.g. 0.9.x) predate `Workspace.onLayoutReady`.
      // `ensureLayoutReady` calls it unconditionally, so it throws there — but those
      // Versions already expose the `layoutReady` flag, which is `true` by the time
      // An owned vault window is up. Only wait when layout is not yet ready, so the
      // Missing method is never invoked on old versions.
      if (!this.app.workspace.layoutReady) {
        await this.ensureLayoutReady();
      }

      // eslint-disable-next-line no-restricted-syntax -- DataAdapter is actually FileSystemAdapter at runtime on desktop.
      const adapter = this.app.vault.adapter as unknown as FileSystemAdapterLike;
      // Old Obsidian versions (e.g. 0.6.x) predate the `getBasePath()` method but
      // Expose the `basePath` property; the method exists from ~0.9.20 onward.
      const basePath = adapter.getBasePath ? adapter.getBasePath() : (adapter.basePath ?? '');
      return JSON.stringify(basePath);
    },

    async setLocalStorageItem(this: IntegrationTestingNamespace, params): Promise<void> {
      await this.ensureLayoutReady();
      localStorage.setItem(params.key, params.value);
    },

    version: bootstrapParams.version
  };

  // eslint-disable-next-line no-restricted-syntax -- Approved double cast: `__obsidianIntegrationTesting` is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
  (window as unknown as Partial<IntegrationTestingHolder>).__obsidianIntegrationTesting = ns;

  async function typeIntoEditor(typeParams: TypeIntoEditorParams): Promise<void> {
    const FOCUS_SETTLE_DELAY_IN_MILLISECONDS = 300;

    const { editor, text } = typeParams;
    const valueBeforeTyping = editor.getValue();

    // Focus the editor and place the caret at the end of the document.
    editor.focus();
    const lastLine = editor.lastLine();
    editor.setCursor(lastLine, editor.getLine(lastLine).length);

    // Let any focus trap (a `setTimeout(0)` re-focus) fire before typing, so stolen focus is detected.
    await sleep(FOCUS_SETTLE_DELAY_IN_MILLISECONDS);

    // Typing is pressing each character key in turn: `pressKey` injects the same trusted
    // `keyDown` -> `char` -> `keyUp` a real user produces — text lands only if the editor holds focus.
    for (const char of text) {
      pressKey({ key: char });
    }

    // Poll until the document reflects the input or the timeout elapses, instead of a fixed settle.
    const startTime = Date.now();
    while (editor.getValue() === valueBeforeTyping && Date.now() - startTime < INPUT_TIMEOUT_IN_MILLISECONDS) {
      await sleep(INPUT_POLL_INTERVAL_IN_MILLISECONDS);
    }
  }

  function pressKey(pressParams: PressKeyParams): void {
    const { key, modifiers = [] } = pressParams;

    // 'Mod' is Obsidian's platform-agnostic modifier: Cmd (meta) on macOS, Ctrl elsewhere.
    // Reading `Platform.isMacOS` off the resolved obsidian module is safe here:
    // `evalWrapper` always resolves that module before any callback (and thus `pressKey`) can run.
    const isMacOS = (ns.obsidianModule as ObsidianModuleWithPlatform).Platform.isMacOS;

    // Map Obsidian's `Modifier` names to Electron's lowercase `sendInputEvent` modifier names.
    // Names 'Meta', 'Alt', 'Shift' lowercase directly; 'Ctrl' -> 'control'; 'Mod' resolves per-platform.
    const electronModifiers = modifiers.map((modifier): ElectronModifier => {
      switch (modifier) {
        case 'Alt':
          return 'alt';
        case 'Ctrl':
          return 'control';
        case 'Meta':
          return 'meta';
        case 'Mod':
          return isMacOS ? 'meta' : 'control';
        case 'Shift':
          return 'shift';
        default: {
          // Exhaustiveness guard: adding a `Modifier` member without a case above becomes a compile error.
          const unknownModifier: never = modifier;
          throw new Error(`Unknown modifier: ${String(unknownModifier)}`);
        }
      }
    });

    const webContents = window.electron.remote.getCurrentWebContents();

    // A trusted key press is keyDown -> char -> keyUp: keyDown fires `keydown`, char fires
    // `keypress`/`beforeinput`/`input`, keyUp fires `keyup` — the full real key pipeline.
    webContents.sendInputEvent({ keyCode: key, modifiers: electronModifiers, type: 'keyDown' });
    webContents.sendInputEvent({ keyCode: key, modifiers: electronModifiers, type: 'char' });
    webContents.sendInputEvent({ keyCode: key, modifiers: electronModifiers, type: 'keyUp' });
  }

  async function hoverElement(hoverParams: HoverElementParams): Promise<void> {
    const CENTER_DIVISOR = 2;

    const { element } = hoverParams;

    // Viewport coords equal web-contents DIP coords for the full-window `BrowserWindow`.
    const rect = element.getBoundingClientRect();
    moveMouse({ x: rect.left + rect.width / CENTER_DIVISOR, y: rect.top + rect.height / CENTER_DIVISOR });

    // Poll until the real `:hover` state has actually taken, instead of a fixed settle.
    const startTime = Date.now();
    while (!element.matches(':hover') && Date.now() - startTime < INPUT_TIMEOUT_IN_MILLISECONDS) {
      await sleep(INPUT_POLL_INTERVAL_IN_MILLISECONDS);
    }
  }

  function moveMouse(moveParams: MoveMouseParams): void {
    const webContents = window.electron.remote.getCurrentWebContents();
    webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(moveParams.x), y: Math.round(moveParams.y) });
  }

  async function unhoverElement(unhoverParams: UnhoverElementParams): Promise<void> {
    const CENTER_DIVISOR = 2;
    const OUTSIDE_OFFSET_IN_PIXELS = 1;

    const { element } = unhoverParams;

    // Move to a point just outside the element's box.
    // When flush against the viewport's left edge, use just past the right edge.
    // A full-viewport-width element should use `moveMouse` directly instead.
    const rect = element.getBoundingClientRect();
    const x = rect.left >= OUTSIDE_OFFSET_IN_PIXELS ? rect.left - OUTSIDE_OFFSET_IN_PIXELS : rect.right + OUTSIDE_OFFSET_IN_PIXELS;
    const y = rect.top + rect.height / CENTER_DIVISOR;
    moveMouse({ x, y });

    // Poll until the real `:hover` state has actually cleared, instead of a fixed settle.
    const startTime = Date.now();
    while (element.matches(':hover') && Date.now() - startTime < INPUT_TIMEOUT_IN_MILLISECONDS) {
      await sleep(INPUT_POLL_INTERVAL_IN_MILLISECONDS);
    }
  }

  async function waitUntil(waitParams: WaitUntilParams): Promise<void> {
    const {
      intervalInMilliseconds = WAIT_UNTIL_POLL_INTERVAL_IN_MILLISECONDS,
      message,
      predicate,
      timeoutInMilliseconds = WAIT_UNTIL_TIMEOUT_IN_MILLISECONDS
    } = waitParams;

    const startTime = Date.now();
    while (!(await predicate())) {
      if (Date.now() - startTime >= timeoutInMilliseconds) {
        const suffix = message === undefined ? '' : `: ${message}`;
        throw new Error(`waitUntil timed out after ${String(timeoutInMilliseconds)} milliseconds${suffix}`);
      }
      await sleep(intervalInMilliseconds);
    }
  }

  function errorToStringImpl(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    let message = error.stack ?? `${error.name}: ${error.message}`;
    if (error.cause !== undefined) {
      message = appendNestedError(message, error.cause, 'Caused by:');
    }
    if (error instanceof AggregateError) {
      const aggregatedErrors: readonly unknown[] = error.errors;
      for (const [index, aggregatedError] of aggregatedErrors.entries()) {
        message = appendNestedError(message, aggregatedError, `Aggregated error #${String(index + 1)}:`);
      }
    }
    return message;
  }

  function appendNestedError(message: string, nestedError: unknown, title: string): string {
    let result = `${message}\n${generateStackTraceLine(title)}`;
    for (const line of errorToStringImpl(nestedError).split('\n')) {
      if (!line.trim()) {
        continue;
      }
      result += line.startsWith(STACK_TRACE_PREFIX)
        ? `\n${line}`
        : `\n${generateStackTraceLine(line)}`;
    }
    return result;
  }

  function generateStackTraceLine(title: string): string {
    return `${STACK_TRACE_PREFIX} --- ${title} --- (0)`;
  }
}

/* v8 ignore stop */
