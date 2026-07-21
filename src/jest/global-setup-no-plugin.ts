/**
 * @file
 *
 * Jest **plugin-less** global setup entry point.
 *
 * The counterpart to `./global-setup.ts` (which installs and enables the built
 * plugin). This one runs {@link createSetup} with `installPlugin: false`, so it
 * registers an **empty** temp vault and publishes the owned-instance endpoint to
 * workers without copying or enabling any plugin. Its default export is the setup
 * function, as Jest's `globalSetup` loader requires.
 */

/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import { createSetup } from './global-setup.ts';

const noPluginGlobalSetup = createSetup({ installPlugin: false });

/**
 * Jest global setup function (plugin-less).
 *
 * Registers an empty temp vault and populates `globalThis.__obsidianIntegrationTesting`
 * for tests, without copying or enabling any plugin.
 */
export const setup = noPluginGlobalSetup.setup;

/**
 * Jest global teardown function.
 *
 * Removes the temporary vault created during setup.
 */
export const teardown = noPluginGlobalSetup.teardown;

export {
  getTempVault,
  getTransportOptions
} from './global-setup.ts';

// Jest's `globalSetup` config can reference this module directly because its default export is the setup function.
// eslint-disable-next-line import-x/no-default-export -- Jest's globalSetup loader requires a default-export function.
export default setup;
