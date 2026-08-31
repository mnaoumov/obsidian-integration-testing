/**
 * @file
 *
 * Vitest global setup and teardown adapter.
 *
 * Delegates to the framework-agnostic core and bridges context
 * to test workers via Vitest's `project.provide` / `inject`.
 */

/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import type { TestProject } from 'vitest/node';

import { inject } from 'vitest';

import type { CoreSetupResult } from '../global-setup-core.ts';
import type { PopulateFilesParams } from '../temporary-vault.ts';
import type { ObsidianTransportOptions } from '../transport-options.ts';

import {
  setSetupErrorResolver,
  setTransportOptionsResolver,
  setVaultPathResolver
} from '../context-provider.ts';
import { errorToString } from '../error-to-string.ts';
import {
  coreSetup,
  coreTeardown
} from '../global-setup-core.ts';
import { IntegrationSetupFailedError } from '../integration-setup-failed-error.ts';
import { log } from '../log.ts';
import { TemporaryVault } from '../temporary-vault.ts';

setSetupErrorResolver(() => inject('setupError'));
setTransportOptionsResolver(() => inject('obsidianTransport'));
setVaultPathResolver(() => inject('temporaryVaultPath'));

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
   *
   * May return a promise, so the map can be built by something that needs the network — notably
   * `buildDemoVaultPopulateAsync`, which installs a demo vault's missing community plugins before
   * reading them. A synchronous thunk (e.g. `buildDemoVaultPopulate`) is unchanged.
   */
  populate?(this: void): PopulateFilesParams | Promise<PopulateFilesParams>;
}

/**
 * A Vitest `globalSetup` module's `setup` / `teardown` pair.
 */
export interface VitestGlobalSetup {
  setup(this: void, project: TestProject): Promise<void>;
  teardown(this: void): Promise<void>;
}

/**
 * Creates a Vitest global setup/teardown pair, optionally pre-populating the vault
 * before Obsidian opens it — use this for a dedicated large-vault/performance
 * project. The plain {@link setup} / {@link teardown} exports are the no-populate
 * case (`createSetup()`). Pass `{ installPlugin: false }` for a non-plugin consumer
 * that only needs a registered, empty vault (see {@link CreateSetupOptions.installPlugin}).
 *
 * @param options - Setup options.
 * @returns The `setup` and `teardown` functions to re-export from a `globalSetup` module.
 */
export function createSetup(options?: CreateSetupOptions): VitestGlobalSetup {
  let setupResult: CoreSetupResult | undefined;

  return { setup, teardown };

  async function setup(project: TestProject): Promise<void> {
    const environmentOptions = project.config.environmentOptions as Record<string, unknown> | undefined;
    const transportOptions = environmentOptions?.['obsidianTransport'] as ObsidianTransportOptions | undefined;
    const label = transportOptions?.type ?? 'obsidian-cdp';

    try {
      setupResult = await coreSetup({
        enableCommunityPlugins: options?.enableCommunityPlugins,
        installPlugin: options?.installPlugin,
        populate: await options?.populate?.(),
        transportOptions
      });
    } catch (error: unknown) {
      // Catch setup errors so that other projects' tests can still run. Every test in THIS project
      // Then fails with the stored error: `getOrCreateTransport` reads it through the setup-error
      // Resolver and throws before it can build a transport. Without that a worker gets no options
      // At all and silently rebuilds the owned DESKTOP default, whatever platform this project asked
      // For -- which is how an Android run came to report nine `Failed to parse URL from /json`
      // Failures while the real cause sat once, far above, in this log (see AGENTS.md L9).
      log(`[integration-setup:${label}] Setup failed (every test in this project will fail with this error): ${errorToString(error)}`);
      project.provide('setupError', {
        errorName: error instanceof Error ? error.name : 'Error',
        message: errorToString(error),
        transportLabel: label
      });
      return;
    }

    project.provide('obsidianTransport', setupResult.transportOptions);
    project.provide('temporaryVaultPath', setupResult.temporaryVault.path);
  }

  async function teardown(): Promise<void> {
    await coreTeardown(setupResult);
  }
}

/**
 * Returns the temporary vault provided by the global setup.
 *
 * @returns The temporary vault.
 */
export function getTemporaryVault(): TemporaryVault {
  const temporaryVaultPath = inject('temporaryVaultPath');
  const setupError = inject('setupError');
  if (setupError) {
    throw new IntegrationSetupFailedError(setupError);
  }
  return new TemporaryVault(temporaryVaultPath);
}

const defaultGlobalSetup = createSetup();

/**
 * Vitest global setup function (no pre-population).
 *
 * Copies the built plugin into a temporary vault, enables it via a renderer eval
 * over the transport, and provides `temporaryVaultPath` to tests.
 *
 * @param project - The Vitest project.
 * @returns A promise that resolves when setup completes.
 */
export const setup = defaultGlobalSetup.setup;

/**
 * Vitest global teardown function.
 *
 * Removes the temporary vault created during setup.
 *
 * @returns A promise that resolves when teardown completes.
 */
export const teardown = defaultGlobalSetup.teardown;
