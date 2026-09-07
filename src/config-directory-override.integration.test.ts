/**
 * @file
 *
 * End-to-end regression test: every pre-open write the harness makes has to go to the folder the
 * vault will actually read, not to a hardcoded `.obsidian`.
 *
 * The global setup (`scripts/config-directory-override-global-setup.ts`) opens a harness-owned vault under
 * `.obsidian-desktop` and seeds a dummy community plugin through `buildDemoVaultPopulate`. This suite evals
 * from a worker and asserts the override actually took **and** that the seeded plugin loaded — the second
 * assertion is the regression: before the fix the binaries were written under `.obsidian/`, a folder the
 * vault never opens, so the enable reported the generic "enabled but not loaded" with nothing naming a
 * config folder.
 *
 * The plugin-under-test install path (`copyPluginIntoVault` → `installPluginIntoVault`) is deliberately NOT
 * exercised here: `coreSetup` reads its project root from `findProjectRoot()` rather than a parameter and
 * this repo ships no plugin `dist`, so the setup forces `installPlugin: false`. That path's own override
 * handling is covered by `src/vault-plugin-install.test.ts`.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';

// Kept in sync with `CONFIG_DIRECTORY_OVERRIDE` in this project's entry in `scripts/vitest-config.ts`,
// Which is where the override is set: `createSetup` takes no transport options, reading them from the
// Project's `environmentOptions.obsidianTransport`.
const CONFIG_DIRECTORY = '.obsidian-desktop';

// Kept in sync with `OVERRIDE_PLUGIN_ID` in `scripts/config-directory-override-global-setup.ts`.
const OVERRIDE_PLUGIN_ID = 'config-directory-override-extra';

describe('configDirectory override', () => {
  it('opens the vault against the overridden config folder', async () => {
    // The premise every assertion below rests on: without this the suite would be testing the default path
    // Under a different name.
    const configDirectory = await evalInObsidian({
      callback({ app }): string {
        return app.vault.configDir;
      }
    });

    expect(configDirectory).toBe(CONFIG_DIRECTORY);
  });

  it('loads a community plugin seeded through populate, which the override used to strand', async () => {
    const loadedPluginIds = await evalInObsidian({
      callback({ app }): string[] {
        return Object.keys(app.plugins.plugins);
      }
    });

    expect(loadedPluginIds, `expected "${OVERRIDE_PLUGIN_ID}" to be loaded, got ${JSON.stringify(loadedPluginIds)}`)
      .toContain(OVERRIDE_PLUGIN_ID);
  });

  it('writes the headless defaults where the overridden vault reads them', async () => {
    // Obsidian ships `settingsPopoutWindow` as `true`, so `false` can only have come from the harness --
    // Reading it back proves the `app.json` write reached the folder the vault opened (the half fixed on 2026-09-05,
    // Re-asserted here because this is the only suite that runs under an override end to end).
    const config = await evalInObsidian({
      callback({ app }): Record<string, unknown> {
        const getConfig = app.vault.getConfig.bind(app.vault) as (configKey: string) => unknown;
        return {
          alwaysUpdateLinks: getConfig('alwaysUpdateLinks'),
          settingsPopoutWindow: getConfig('settingsPopoutWindow')
        };
      }
    });

    expect(config['alwaysUpdateLinks']).toBe(true);
    expect(config['settingsPopoutWindow']).toBe(false);
  });
});
