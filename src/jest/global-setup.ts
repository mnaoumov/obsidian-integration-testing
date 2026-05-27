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

let setupResult: CoreSetupResult | undefined;

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

/**
 * Jest global setup function.
 *
 * Copies the built plugin into a temporary vault, enables it via the Obsidian CLI,
 * and populates `globalThis.__obsidianIntegrationTesting` for tests.
 *
 * Transport options are read from `globalThis.__obsidianIntegrationTesting.transportOptions`.
 * Set this in your Jest config via the `globals` option.
 */
export async function setup(): Promise<void> {
  const transportOptions = globalThis.__obsidianIntegrationTesting?.transportOptions;

  setupResult = await coreSetup({ transportOptions });

  globalThis.__obsidianIntegrationTesting = {
    ...globalThis.__obsidianIntegrationTesting,
    tempVaultPath: setupResult.tempVault.path,
    transportOptions: setupResult.transportOptions
  };
}

/**
 * Jest global teardown function.
 *
 * Removes the temporary vault created during setup.
 */
export async function teardown(): Promise<void> {
  await coreTeardown(setupResult);
}
