/**
 * @file
 *
 * Bootstraps the `window.__obsidianIntegrationTesting` namespace in the
 * Obsidian process. Extracted to its own module to avoid dependency cycles
 * between `eval-in-obsidian.ts` and the transport modules.
 */

import type {
  App,
  Editor
} from 'obsidian';

import type { GenerateFunctionCallParams } from './generate-function-call.ts';
import type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';

import { generateFunctionCall } from './generate-function-call.ts';
import { LIBRARY_VERSION } from './library.ts';

interface BootstrapNamespaceParams {
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
  const versionJson = JSON.stringify(LIBRARY_VERSION);
  const checkResult = await transport.evaluate(
    `JSON.stringify(window.__obsidianIntegrationTesting?.version === ${versionJson})`,
    evalOptions
  );

  if (checkResult === 'true') {
    return;
  }

  const bootstrapExpr = generateFunctionCall(bootstrapNamespace, { version: LIBRARY_VERSION });
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
    obsidianModule?: unknown;
    version: string;
  }

  interface IntegrationTestingNamespace extends IntegrationTestingNamespaceState {
    readonly app: App;
    destroyCurrentWindow(): Promise<void>;
    ensureLayoutReady(): Promise<void>;
    evalWrapper(nsParams: EvalWrapperParams): Promise<string>;
    getObsidianModule(): Promise<unknown>;
    ipcSendSync(nsParams: IpcSendSyncParams): Promise<void>;
    pollVaultBasePath(): Promise<string>;
    serializeError(error: unknown, depth?: number): string;
    setLocalStorageItem(nsParams: SetLocalStorageItemParams): Promise<void>;
  }

  interface EvalWrapperParams {
    readonly args: Record<string, unknown>;
    readonly contextId?: string;
    fn(fnArgs: Record<string, unknown>): unknown;
  }

  interface FileSystemAdapterLike {
    getBasePath(): string;
  }

  interface IpcSendSyncParams {
    readonly args: unknown[];
    readonly channel: string;
  }

  interface SetLocalStorageItemParams {
    readonly key: string;
    readonly value: string;
  }

  interface TypeIntoEditorNsParams {
    readonly editor: Editor;
    readonly text: string;
  }

  interface ElectronWebContentsWithSendInputEvent {
    sendInputEvent(inputEvent: SendInputEventKeyboardInput): void;
  }

  interface SendInputEventKeyboardInput {
    keyCode: string;
    type: 'char' | 'keyDown' | 'keyUp';
  }

  /**
   * Delay (in ms) before invoking `electronWindow.destroy()` so the eval that
   * triggered the call has time to return its result to the caller. Without
   * it the renderer dies before the IPC reply ships, the caller waits for the
   * full eval timeout, and stale `BrowserWindow` entries pile up.
   */
  const DESTROY_DELAY_IN_MILLISECONDS = 50;

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

    async evalWrapper(this: IntegrationTestingNamespace, params): Promise<string> {
      if (!this.app.plugins.isEnabled()) {
        await this.app.plugins.setEnable(true);
      }
      const obsidianModule = await this.getObsidianModule();
      const context = params.contextId
        ? (this.contexts[params.contextId] ??= {})
        : {};
      const fullArgs = { ...params.args, app: this.app, context, obsidianModule, typeIntoEditor };
      try {
        const result = await params.fn(fullArgs);
        if (result === undefined) {
          return JSON.stringify({ type: 'undefined' });
        }
        return JSON.stringify({ value: result });
      } catch (evalError) {
        return JSON.stringify({ type: 'error', value: this.serializeError(evalError) });
      }
    },

    async getObsidianModule(this: IntegrationTestingNamespace): Promise<unknown> {
      if (this.obsidianModule) {
        return this.obsidianModule;
      }

      const SLICE_START = 2;
      const randomSuffix = String(Math.random()).slice(SLICE_START);
      const tempModuleName = `get-obsidian-module-${randomSuffix}`;
      const dir = `${this.app.vault.configDir}/plugins/${tempModuleName}`;
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

    obsidianModule: existingObsidianModule,

    async pollVaultBasePath(this: IntegrationTestingNamespace): Promise<string> {
      await this.ensureLayoutReady();

      // eslint-disable-next-line no-restricted-syntax -- DataAdapter is actually FileSystemAdapter at runtime on desktop.
      return JSON.stringify((this.app.vault.adapter as unknown as FileSystemAdapterLike).getBasePath());
    },

    serializeError(this: IntegrationTestingNamespace, error: unknown, depth = 0): string {
      const CAUSE_INDENT_SIZE = 2;
      const indent = ' '.repeat(depth * CAUSE_INDENT_SIZE);

      if (!(error instanceof Error)) {
        return `${indent}${String(error)}`;
      }

      const stackOrMessage = error.stack ?? `${error.name}: ${error.message}`;
      let result = stackOrMessage.split('\n').map((line) => `${indent}${line}`).join('\n');

      if (error.cause !== undefined) {
        result += `\n${indent}[cause]:`;
        result += `\n${this.serializeError(error.cause, depth + 1)}`;
      }

      return result;
    },

    async setLocalStorageItem(this: IntegrationTestingNamespace, params): Promise<void> {
      await this.ensureLayoutReady();
      localStorage.setItem(params.key, params.value);
    },

    version: bootstrapParams.version
  };

  // eslint-disable-next-line no-restricted-syntax -- Approved double cast: `__obsidianIntegrationTesting` is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
  (window as unknown as Partial<IntegrationTestingHolder>).__obsidianIntegrationTesting = ns;

  async function typeIntoEditor(typeParams: TypeIntoEditorNsParams): Promise<void> {
    const FOCUS_SETTLE_DELAY_IN_MILLISECONDS = 300;
    const INPUT_POLL_INTERVAL_IN_MILLISECONDS = 50;
    const INPUT_TIMEOUT_IN_MILLISECONDS = 5000;

    const { editor, text } = typeParams;
    const valueBeforeTyping = editor.getValue();

    // Focus the editor and place the caret at the end of the document.
    editor.focus();
    const lastLine = editor.lastLine();
    editor.setCursor(lastLine, editor.getLine(lastLine).length);

    // Let any focus trap (a `setTimeout(0)` re-focus) fire before typing, so stolen focus is detected.
    await sleep(FOCUS_SETTLE_DELAY_IN_MILLISECONDS);

    // eslint-disable-next-line no-restricted-syntax -- Approved double cast: obsidian-typings' `ElectronWebContents` omits the stable `sendInputEvent`, which is what injects a trusted (real) keypress.
    const webContents = window.electron.remote.getCurrentWebContents() as unknown as ElectronWebContentsWithSendInputEvent;
    for (const char of text) {
      webContents.sendInputEvent({ keyCode: char, type: 'char' });
    }

    // Poll until the document reflects the input or the timeout elapses, instead of a fixed settle.
    const startTime = Date.now();
    while (editor.getValue() === valueBeforeTyping && Date.now() - startTime < INPUT_TIMEOUT_IN_MILLISECONDS) {
      await sleep(INPUT_POLL_INTERVAL_IN_MILLISECONDS);
    }
  }
}

/* v8 ignore stop */
