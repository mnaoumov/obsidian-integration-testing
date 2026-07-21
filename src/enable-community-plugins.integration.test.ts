/**
 * @file
 *
 * End-to-end regression test for the `enableCommunityPlugins` global-setup option (T121, Gap 1) and the
 * {@link buildDemoVaultPopulate} seeding helper (Gap 2).
 *
 * The global setup (`enable-community-plugins-global-setup.ts`) seeds a throwaway demo vault holding two
 * inline dummy community plugins via `buildDemoVaultPopulate`, then runs
 * `createSetup({ installPlugin: false, enableCommunityPlugins: [...] })`. This suite evals from a worker and
 * asserts both dummy plugins actually loaded — which happens only if the extra-enable loop in `coreSetup`
 * enabled each seeded plugin (not just the plugin-under-test, of which there is none here).
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';

// Kept in sync with `EXTRA_PLUGIN_IDS` in `scripts/enable-community-plugins-global-setup.ts`.
const EXTRA_PLUGIN_IDS = ['enable-extra-a', 'enable-extra-b'];

describe('enableCommunityPlugins', () => {
  it('loads every seeded extra community plugin', async () => {
    const loadedPluginIds = await evalInObsidian({
      fn({ app }): string[] {
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
      fn({ app }): string[] {
        return [...app.plugins.enabledPlugins];
      }
    });

    for (const pluginId of EXTRA_PLUGIN_IDS) {
      expect(enabledPluginIds).toContain(pluginId);
    }
  });
});
