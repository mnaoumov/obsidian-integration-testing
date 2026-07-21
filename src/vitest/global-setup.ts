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
import type { PopulateFilesParams } from '../temp-vault.ts';
import type { ObsidianTransportOptions } from '../transport-options.ts';

import {
  setTransportOptionsResolver,
  setVaultPathResolver
} from '../context-provider.ts';
import { errorToString } from '../error-to-string.ts';
import {
  coreSetup,
  coreTeardown
} from '../global-setup-core.ts';
import { log } from '../log.ts';
import { TempVault } from '../temp-vault.ts';

setTransportOptionsResolver(() => inject('obsidianTransport'));
setVaultPathResolver(() => inject('tempVaultPath'));

/**
 * Options for {@link createSetup}.
 */
export interface CreateSetupOptions {
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
      setupResult = await coreSetup({ installPlugin: options?.installPlugin, populate: options?.populate?.(), transportOptions });
    } catch (error: unknown) {
      // Catch setup errors so that other projects' tests can still run.
      // Individual tests in this project will fail with the stored error
      // When they try to inject the temp vault path.
      log(`[integration-setup:${label}] Setup failed (tests for this project will be skipped): ${errorToString(error)}`);
      project.provide('setupError', errorToString(error));
      return;
    }

    project.provide('obsidianTransport', setupResult.transportOptions);
    project.provide('tempVaultPath', setupResult.tempVault.path);
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
export function getTempVault(): TempVault {
  const tempVaultPath = inject('tempVaultPath');
  const setupErrorMessage = inject('setupError');
  if (setupErrorMessage) {
    throw new Error(`Integration setup failed — cannot get temp vault: ${setupErrorMessage}`);
  }
  return new TempVault(tempVaultPath);
}

const defaultGlobalSetup = createSetup();

/**
 * Vitest global setup function (no pre-population).
 *
 * Copies the built plugin into a temporary vault, enables it via the Obsidian CLI,
 * and provides `tempVaultPath` to tests.
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
