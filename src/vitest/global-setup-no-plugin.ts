/**
 * @file
 *
 * Vitest **plugin-less** global setup/teardown adapter.
 *
 * The counterpart to `./global-setup.ts` (which installs and enables the built
 * plugin). This one runs {@link createSetup} with `installPlugin: false`, so it
 * launches the owned Obsidian instance, registers an **empty** temp vault, and
 * publishes the owned-instance endpoint to workers — but copies/enables no
 * plugin. Point a non-plugin consumer's `globalSetup` straight at
 * `obsidian-integration-testing/vitest-global-setup-no-plugin`; no wrapper needed.
 */

/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import { createSetup } from './global-setup.ts';

const noPluginGlobalSetup = createSetup({ installPlugin: false });

/**
 * Vitest global setup function (plugin-less; no pre-population).
 *
 * Registers an empty temp vault and provides `tempVaultPath` to tests, without
 * copying or enabling any plugin.
 */
export const setup = noPluginGlobalSetup.setup;

/**
 * Vitest global teardown function.
 *
 * Removes the temporary vault created during setup.
 */
export const teardown = noPluginGlobalSetup.teardown;

export { getTempVault } from './global-setup.ts';
