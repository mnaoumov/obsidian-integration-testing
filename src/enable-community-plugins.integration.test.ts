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

import { evalInObsidian } from './eval-in-obsidian.ts';

// Kept in sync with `EXTRA_PLUGIN_IDS` in `scripts/enable-community-plugins-global-setup.ts`.
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
