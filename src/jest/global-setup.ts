/**
 * @file
 *
 * Jest global setup and teardown adapter.
 *
 * Delegates to the framework-agnostic core and bridges context
 * to test workers via `globalThis.__obsidianIntegrationTesting`.
 */

/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import type { CoreSetupResult } from '../global-setup-core.ts';
import type { PopulateFilesParams } from '../temp-vault.ts';
import type { ObsidianTransportOptions } from '../transport-options.ts';

import {
  setTransportOptionsResolver,
  setVaultPathResolver
} from '../context-provider.ts';
import {
  coreSetup,
  coreTeardown
} from '../global-setup-core.ts';
import { TempVault } from '../temp-vault.ts';

/**
 * Shape of `globalThis.__obsidianIntegrationTesting`.
 *
 * Consumers may pre-populate `transportOptions` before the global setup runs
 * (e.g., via Jest config `globals`). The setup then adds `tempVaultPath`.
 */
interface ObsidianIntegrationTestingGlobal {
  /** Temp vault path, set by the global setup for test workers. */
  tempVaultPath?: string | undefined;

  /** Transport options. Set by the consumer before setup, or by the setup itself. */
  transportOptions?: ObsidianTransportOptions | undefined;
}

/* eslint-disable vars-on-top -- Required for `declare global` augmentation. */
declare global {
  /**
   * Namespace for all `obsidian-integration-testing` global state.
   * Consumers configure transport options here; the setup populates the rest.
   */
  var __obsidianIntegrationTesting: ObsidianIntegrationTestingGlobal | undefined;
}
/* eslint-enable vars-on-top -- End of `declare global` block. */

setTransportOptionsResolver(() => globalThis.__obsidianIntegrationTesting?.transportOptions);
setVaultPathResolver(() => globalThis.__obsidianIntegrationTesting?.tempVaultPath);

/**
 * Options for {@link createSetup}.
 */
export interface CreateSetupOptions {
  /**
   * Community-plugin ids to enable in the vault in addition to the plugin-under-test,
   * after it is enabled (see {@link CoreSetupParams.enableCommunityPlugins}). Seed each
   * plugin's built files via {@link CreateSetupOptions.populate} (e.g. with `buildDemoVaultPopulate`)
   * so the enable finds them on disk.
   */
  readonly enableCommunityPlugins?: readonly string[];

  /**
   * Whether to install and enable the built plugin in the temp vault. Defaults
   * to `true`. Set to `false` for a **non-plugin** consumer that only needs a
   * registered, empty vault to `evalInObsidian` against — the owned instance is
   * still launched and its endpoint published to workers, so re-exporting
   * `createSetup({ installPlugin: false })` reuses the same attach wiring with no
   * plugin copy/enable. See {@link CoreSetupParams.installPlugin}.
   */
  readonly installPlugin?: boolean;

  /**
   * Returns files/folders to write into the vault before Obsidian opens it (see
   * {@link CoreSetupParams.populate}). A thunk so large fixtures are built lazily,
   * once, in the setup process.
   */
  populate?(this: void): PopulateFilesParams;
}

/**
 * A Jest `globalSetup` / `globalTeardown` module's `setup` / `teardown` pair.
 */
export interface JestGlobalSetup {
  setup(this: void): Promise<void>;
  teardown(this: void): Promise<void>;
}

/**
 * Creates a Jest global setup/teardown pair, optionally pre-populating the vault
 * before Obsidian opens it — use this for a dedicated large-vault/performance
 * setup. The plain {@link setup} / {@link teardown} exports are the no-populate
 * case (`createSetup()`). Pass `{ installPlugin: false }` for a non-plugin consumer
 * that only needs a registered, empty vault (see {@link CreateSetupOptions.installPlugin}).
 *
 * @param options - Setup options.
 * @returns The `setup` and `teardown` functions to re-export from a `globalSetup` module.
 */
export function createSetup(options?: CreateSetupOptions): JestGlobalSetup {
  let setupResult: CoreSetupResult | undefined;

  return { setup, teardown };

  async function setup(): Promise<void> {
    const transportOptions = globalThis.__obsidianIntegrationTesting?.transportOptions;

    setupResult = await coreSetup({
      enableCommunityPlugins: options?.enableCommunityPlugins,
      installPlugin: options?.installPlugin,
      populate: options?.populate?.(),
      transportOptions
    });

    globalThis.__obsidianIntegrationTesting = {
      ...globalThis.__obsidianIntegrationTesting,
      tempVaultPath: setupResult.tempVault.path,
      transportOptions: setupResult.transportOptions
    };
  }

  async function teardown(): Promise<void> {
    await coreTeardown(setupResult);
  }
}

/**
 * Returns the temporary vault provided by the global setup.
 *
 * Reads the vault path from `globalThis.__obsidianIntegrationTesting.tempVaultPath`,
 * which is set by the Jest global setup.
 *
 * @returns The temporary vault.
 */
export function getTempVault(): TempVault {
  const tempVaultPath = globalThis.__obsidianIntegrationTesting?.tempVaultPath;
  if (!tempVaultPath) {
    throw new Error(
      'globalThis.__obsidianIntegrationTesting.tempVaultPath is not set. Did you configure obsidian-integration-testing/jest-global-setup as a Jest globalSetup?'
    );
  }
  return new TempVault(tempVaultPath);
}

/**
 * Returns the transport options provided by the global setup.
 *
 * @returns The transport options, or `undefined` if not configured.
 */
export function getTransportOptions(): ObsidianTransportOptions | undefined {
  return globalThis.__obsidianIntegrationTesting?.transportOptions;
}

const defaultGlobalSetup = createSetup();

/**
 * Jest global setup function (no pre-population).
 *
 * Copies the built plugin into a temporary vault, enables it via a renderer eval
 * over the transport, and populates `globalThis.__obsidianIntegrationTesting` for tests.
 *
 * Transport options are read from `globalThis.__obsidianIntegrationTesting.transportOptions`.
 * Set this in your Jest config via the `globals` option.
 *
 * @returns A promise that resolves when setup completes.
 */
export const setup = defaultGlobalSetup.setup;

/**
 * Jest global teardown function.
 *
 * Removes the temporary vault created during setup.
 *
 * @returns A promise that resolves when teardown completes.
 */
export const teardown = defaultGlobalSetup.teardown;

// Jest's `globalSetup` config can reference this module directly because its default export is the setup function.
// eslint-disable-next-line import-x/no-default-export -- Jest's globalSetup loader requires a default-export function.
export default setup;
