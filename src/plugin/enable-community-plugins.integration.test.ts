/**
 * @file
 *
 * End-to-end regression test for the `enableCommunityPlugins` global-setup option (Gap 1) and the
 * {@link buildDemoVaultPopulate} seeding helper (Gap 2).
 *
 * The global setup (`enable-community-plugins-global-setup.ts`) seeds a throwaway demo vault holding three
 * inline dummy community plugins via `buildDemoVaultPopulate`, then runs
 * `createSetup({ installPlugin: false, enableCommunityPlugins: [...] })`. This suite evals from a worker and
 * asserts every dummy plugin actually loaded — which happens only if the extra-enable loop in `coreSetup`
 * enabled each seeded plugin (not just the plugin-under-test, of which there is none here).
 *
 * It also asserts what the third dummy leaves behind. That one patches `app.plugins.loadPlugin` and
 * `console.error` from its own `onload`, which is the window in which `enablePluginWithErrorCapture` holds
 * its own patches on the same two slots — so its patches survive only because that helper restores a slot
 * exclusively while the function it installed is still the one there. An unconditional restore puts back the
 * value read before the plugin existed and the patch is gone with no error and no warning, which is the
 * regression these two assertions pin.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { enablePluginWithErrorCapture } from './enable-plugin.ts';

// Kept in sync with `EXTRA_PLUGIN_IDS` in `scripts/test-setups/enable-community-plugins-global-setup.ts`.
const EXTRA_PLUGIN_IDS = ['enable-extra-patcher', 'enable-extra-a', 'enable-extra-b'];

describe('enableCommunityPlugins', () => {
  it('loads every seeded extra community plugin', async () => {
    const loadedPluginIds = await evalInObsidian({
      callback({ app }): string[] {
        return Object.keys(app.plugins.plugins);
      }
    });

    for (const pluginId of EXTRA_PLUGIN_IDS) {
      expect(loadedPluginIds, `expected "${pluginId}" to be loaded, got ${JSON.stringify(loadedPluginIds)}`)
        .toContain(pluginId);
    }
  });

  it('marks every seeded extra community plugin as enabled', async () => {
    const enabledPluginIds = await evalInObsidian({
      callback({ app }): string[] {
        return [...app.plugins.enabledPlugins];
      }
    });

    for (const pluginId of EXTRA_PLUGIN_IDS) {
      expect(enabledPluginIds).toContain(pluginId);
    }
  });
});

describe('a plugin enabled in community-plugins.json', () => {
  it('loads during startup, before the workspace layout exists', async () => {
    const probe = await evalInObsidian({
      callback(): unknown {
        // The property name is duplicated from the startup probe's source in the global setup.
        return Reflect.get(globalThis, 'obsidianIntegrationTestingStartupProbe') ?? null;
      }
    });

    // A fresh owned profile opens its vault in restricted mode; without the harness turning that off and
    // reloading, the probe never loads at all (nothing else enables it), and the record is missing.
    expect(probe).toEqual({ isLayoutReady: false, isRootSplitNull: true });
  });
});

describe('a plugin whose startup onload is asynchronous', () => {
  it('has finished its onload before the setup hands the vault to a worker', async () => {
    const state = await evalInObsidian({
      callback({ app }): unknown {
        return {
          // The property name and the id are duplicated from the global setup: this callback is serialized.
          loadingPluginId: app.plugins.loadingPluginId ?? null,
          record: Reflect.get(globalThis, 'obsidianIntegrationTestingSlowStartup') ?? null
        };
      }
    });

    // `Plugins.loadPlugin` puts the instance in `app.plugins.plugins` before it awaits `onload`, so a readiness
    // check on registration alone passes while this `onload` still runs, and the record reads `isFinished: false`.
    expect(state).toEqual({ loadingPluginId: null, record: { isFinished: true } });
  });

  it('is waited for when the enable helper runs while its load is still in flight', async () => {
    // Start a load and do not await it, so the plugin is registered and its `onload` is still running.
    await evalInObsidian({
      async callback({ app }): Promise<void> {
        const id = 'enable-extra-slow-startup';
        await app.plugins.disablePlugin(id);
        Reflect.deleteProperty(globalThis, 'obsidianIntegrationTestingSlowStartup');
        // Deliberately not awaited; a failure surfaces in the assertions below.
        app.plugins.enablePlugin(id).catch((error: unknown) => {
          console.error(error);
        });
      }
    });

    const result = await evalInObsidian({
      callback: enablePluginWithErrorCapture,
      input: { pluginId: 'enable-extra-slow-startup' }
    });
    const record = await evalInObsidian({
      callback(): unknown {
        return Reflect.get(globalThis, 'obsidianIntegrationTestingSlowStartup') ?? null;
      }
    });

    // `loadPlugin` returns an instance that is already registered at once, so without the wait the helper
    // returns, reporting the plugin loaded, while the first load's `onload` is still running.
    expect(result.isLoaded).toBe(true);
    expect(record).toEqual({ isFinished: true });
  });
});

describe('a plugin patching a slot the enable helper also patches', () => {
  it('keeps its `app.plugins.loadPlugin` patch', async () => {
    const isPatchStillInstalled = await evalInObsidian({
      callback({ app }): boolean {
        // The literal is duplicated from `PATCH_MARKER`: this callback is serialized into the renderer.
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Inspecting the function in the slot, not calling it.
        return Object.hasOwn(app.plugins.loadPlugin, 'obsidianIntegrationTestingPatchMarker');
      }
    });

    expect(isPatchStillInstalled).toBe(true);
  });

  it('keeps its `console.error` patch', async () => {
    const isPatchStillInstalled = await evalInObsidian({
      callback(): boolean {
        return Object.hasOwn(console.error, 'obsidianIntegrationTestingPatchMarker');
      }
    });

    expect(isPatchStillInstalled).toBe(true);
  });
});
