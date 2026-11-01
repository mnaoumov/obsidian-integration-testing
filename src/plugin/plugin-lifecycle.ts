/**
 * @file
 *
 * Node-side helpers for the plugin-lifecycle cases every plugin should be tested against, and which every suite used
 * to hand-roll or skip:
 *
 * - {@link reloadPlugin}: disable the plugin, put its `data.json` into a given state — absent, as on a fresh install,
 *   or holding text that is not JSON, as after a crash mid-write or a bad Sync merge — and enable it again. The
 *   enable happens with the vault open and its layout ready, so it is also the "turned on later, in settings" path.
 * - {@link detectPluginUnloadLeak}: disable the plugin and report whether its instance was garbage
 *   collected. A plugin that leaves a listener, an interval or a patch behind on unload keeps its instance alive
 *   through it, and every disable and re-enable then leaks a whole plugin.
 *
 * Both run on the **Node** side, like `app-config.ts`, because each is several evaluations with work in between (a
 * garbage collection is a CDP command, not something a renderer closure can ask for).
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian via evalInObsidian) covered by integration tests, not unit tests. */

import type { Except } from 'type-fest';

import process from 'node:process';

import type { GenericObject } from '../eval/eval-in-obsidian.ts';
import type { ObsidianTransport } from '../transport/transport.ts';
import type { EnablePluginResult } from './enable-plugin.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import {
  getTransportOptions,
  getVaultPath
} from '../transport/context-provider.ts';
import { getOrCreateTransport } from '../transport/transport-factory.ts';
import { enablePluginWithErrorCapture } from './enable-plugin.ts';

/**
 * How many garbage collections {@link detectPluginUnloadLeak} runs before it calls the instance leaked.
 * One is normally enough; the others cover an instance that only became unreachable once a task queued by the
 * unload had run.
 */
const MAX_COLLECTION_ATTEMPTS = 3;

/**
 * Parameters for {@link detectPluginUnloadLeak}.
 */
export interface DetectPluginUnloadLeakParams extends PluginLifecycleTarget {
  /**
   * Whether to enable the plugin again afterwards, so the rest of the suite finds it as it was.
   *
   * @default true
   */
  readonly shouldReenable?: boolean;
}

/**
 * Which plugin, and where. Shared by both helpers here.
 */
export interface PluginLifecycleTarget {
  /**
   * The id of the plugin to act on. Its files must be in the vault's `plugins` folder.
   */
  readonly pluginId: string;

  /**
   * Override the transport. When omitted, the transport the current test context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian instance to act in. When omitted, the current test context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * What {@link detectPluginUnloadLeak} found.
 */
export interface PluginUnloadLeakResult {
  /**
   * How many garbage collections ran before the answer.
   */
  readonly collectionCount: number;

  /**
   * Whether the plugin's instance survived the unload and every garbage collection. `true` means something outside
   * the plugin still references it: a listener registered outside `registerEvent` / `registerDomEvent`, an interval
   * outside `registerInterval`, a patch that was never removed, or the plugin storing itself on a global.
   */
  readonly isLeaked: boolean;
}

/**
 * Parameters for {@link reloadPlugin}.
 */
export interface ReloadPluginParams extends PluginLifecycleTarget {
  /**
   * Text to write as the plugin's `data.json` while it is disabled, verbatim: `JSON.stringify(settings)` for given
   * settings, or text that is not JSON for a corrupt file. When omitted, the file is left as it is.
   */
  readonly dataJsonText?: string;

  /**
   * Whether to delete the plugin's `data.json` while it is disabled, so it loads as on a fresh install.
   *
   * @default false
   */
  readonly shouldRemoveDataJson?: boolean;
}

/**
 * What {@link reloadPlugin} found when it enabled the plugin again.
 */
export interface ReloadPluginResult {
  /**
   * The error the plugin's load threw, or what it wrote to the console while failing to load. `undefined` when it
   * loaded cleanly.
   */
  readonly errorMessage: string | undefined;

  /**
   * Whether the plugin's instance exists after the enable. Obsidian stores the instance before it calls `load()`, so
   * this stays `true` when `onload` throws: {@link errorMessage} is the signal for that. `false` means the plugin
   * never got as far as an instance (its `main.js` threw, or exported nothing).
   */
  readonly isLoaded: boolean;
}

interface DisableInput extends GenericObject {
  readonly dataJsonText: string | undefined;
  readonly pluginId: string;
  readonly shouldRemoveDataJson: boolean;
}

// A `window` property rather than a closure variable: the WeakRef has to outlive the evaluation that made it, across
// the garbage collection, and a WeakRef is not serializable. Kept local, like every other holder of a harness
// `window` property, so it never leaks into consumer types.
interface LeakProbeHolder {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- The probe is set by one evaluation and cleared by a later one.
  __obsidianIntegrationTestingLeakProbe?: undefined | WeakRef<object>;
}

interface PluginIdInput extends GenericObject {
  readonly pluginId: string;
}

/**
 * Disables a plugin, checks whether its instance is garbage collected, and enables it again.
 *
 * The instance is the sentinel: everything a plugin owns is reachable only through it, so a collected instance means
 * the unload released the plugin's whole graph, and a surviving one means something outside the plugin still holds
 * it. A `WeakRef` gives an exact answer where a heap measurement would be noisy.
 *
 * Needs a transport that can force a garbage collection (`collectGarbage`): desktop, and Android over local `adb`.
 *
 * @param params - The plugin, whether to enable it again, and transport / vault overrides.
 * @returns A {@link Promise} resolving to whether the instance leaked.
 * @throws Error when the transport cannot force a garbage collection, the plugin is not loaded, or the plugin fails
 *   to load again.
 */
export async function detectPluginUnloadLeak(params: DetectPluginUnloadLeakParams): Promise<PluginUnloadLeakResult> {
  const { pluginId, shouldReenable = true } = params;
  const { transport, vaultPath } = await resolveTarget(params);
  if (!transport.collectGarbage) {
    throw new Error('detectPluginUnloadLeak: the active transport cannot force a garbage collection.');
  }

  await evalInObsidian<PluginIdInput, undefined>({
    async callback({ app, pluginId: id }): Promise<undefined> {
      const plugin = app.plugins.plugins[id];
      if (!plugin) {
        throw new Error(`Plugin "${id}" is not loaded, so there is no instance to watch.`);
      }

      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the leak probe is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      (globalThis as unknown as LeakProbeHolder).__obsidianIntegrationTestingLeakProbe = new WeakRef(plugin);
      await app.plugins.disablePlugin(id);
    },
    input: { pluginId },
    transport,
    vaultPath
  });

  let collectionCount = 0;
  let isCollected = false;
  let reenableFailure: string | undefined;
  try {
    while (!isCollected && collectionCount < MAX_COLLECTION_ATTEMPTS) {
      await transport.collectGarbage(vaultPath);
      collectionCount++;
      isCollected = await evalInObsidian<Record<string, never>, boolean>({
        callback(): boolean {
          // eslint-disable-next-line no-restricted-syntax -- Approved double cast: see the probe's write above.
          return (globalThis as unknown as LeakProbeHolder).__obsidianIntegrationTestingLeakProbe?.deref() === undefined;
        },
        transport,
        vaultPath
      });
    }
  } finally {
    await evalInObsidian<Record<string, never>, undefined>({
      callback(): undefined {
        // eslint-disable-next-line no-restricted-syntax -- Approved double cast: see the probe's write above.
        delete (globalThis as unknown as LeakProbeHolder).__obsidianIntegrationTestingLeakProbe;
      },
      transport,
      vaultPath
    });

    if (shouldReenable) {
      const result = await enable({ pluginId, transport, vaultPath });
      if (!result.isLoaded || result.errorMessage !== undefined) {
        reenableFailure = result.errorMessage ?? result.rendererConsoleErrors ?? 'no error was captured';
      }
    }
  }

  if (reenableFailure !== undefined) {
    throw new Error(`detectPluginUnloadLeak: plugin "${pluginId}" did not load again: ${reenableFailure}`);
  }

  return { collectionCount, isLeaked: !isCollected };
}
/**
 * Disables a plugin, optionally puts its `data.json` into a given state, and enables it again.
 *
 * Covers three cases a suite otherwise never reaches, because the setup always enables the plugin once, at startup,
 * with whatever settings it last saved:
 *
 * - **a fresh install**: `shouldRemoveDataJson: true`, so `loadData()` resolves `null`;
 * - **a corrupt file**: `dataJsonText: '{ not json'`, so `loadData()` resolves `undefined` (Obsidian's `readJson`
 *   logs the parse error and returns nothing), and a plugin that then calls `saveData()` overwrites the user's file;
 * - **enabled later**: the enable runs with the layout already ready, so `onLayoutReady` fires at once.
 *
 * The result is returned rather than thrown, because a test of a corrupt `data.json` asserts on exactly whether the
 * plugin's `onload` survived it.
 *
 * @param params - The plugin, the `data.json` state, and transport / vault overrides.
 * @returns A {@link Promise} resolving to whether the plugin loaded, and the error it raised if not.
 * @throws Error when both a `data.json` text and its removal are asked for, or the plugin's manifest is unknown.
 */
export async function reloadPlugin(params: ReloadPluginParams): Promise<ReloadPluginResult> {
  const { dataJsonText, pluginId, shouldRemoveDataJson = false } = params;
  if (shouldRemoveDataJson && dataJsonText !== undefined) {
    throw new Error('reloadPlugin: pass either dataJsonText or shouldRemoveDataJson, not both.');
  }

  const { transport, vaultPath } = await resolveTarget(params);

  await evalInObsidian<DisableInput, undefined>({
    async callback({ app, dataJsonText: text, pluginId: id, shouldRemoveDataJson: shouldRemove }): Promise<undefined> {
      const manifest = app.plugins.manifests[id];
      if (!manifest) {
        throw new Error(`Plugin "${id}" has no manifest in this vault, so there is nothing to reload.`);
      }

      await app.plugins.disablePlugin(id);

      const dataJsonPath = `${manifest.dir ?? `${app.vault.configDir}/plugins/${id}`}/data.json`;
      if (shouldRemove) {
        if (await app.vault.adapter.exists(dataJsonPath)) {
          await app.vault.adapter.remove(dataJsonPath);
        }
      } else if (text !== undefined) {
        await app.vault.adapter.write(dataJsonPath, text);
      }
    },
    input: { dataJsonText, pluginId, shouldRemoveDataJson },
    transport,
    vaultPath
  });

  const result = await enable({ pluginId, transport, vaultPath });
  return {
    errorMessage: result.errorMessage ?? result.rendererConsoleErrors,
    isLoaded: result.isLoaded
  };
}

async function enable(params: Required<PluginLifecycleTarget>): Promise<EnablePluginResult> {
  const { pluginId, transport, vaultPath } = params;
  return await evalInObsidian({
    callback: enablePluginWithErrorCapture,
    input: { pluginId },
    transport,
    vaultPath
  });
}

async function resolveTarget(params: PluginLifecycleTarget): Promise<Required<Except<PluginLifecycleTarget, 'pluginId'>>> {
  return {
    transport: params.transport ?? await getOrCreateTransport(getTransportOptions()),
    vaultPath: params.vaultPath ?? getVaultPath() ?? process.cwd()
  };
}

/* v8 ignore stop */
