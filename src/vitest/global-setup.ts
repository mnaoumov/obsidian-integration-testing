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
import type { ObsidianTransportOptions } from '../transport-options.ts';

import { setTransportOptionsResolver } from '../context-provider.ts';
import {
  coreSetup,
  coreTeardown
} from '../global-setup-core.ts';
import { TempVault } from '../temp-vault.ts';

setTransportOptionsResolver(() => inject('obsidianTransport'));

let setupResult: CoreSetupResult | undefined;

/**
 * Returns the temporary vault provided by the global setup.
 *
 * @returns The temporary vault.
 */
export function getTempVault(): TempVault {
  const tempVaultPath = inject('tempVaultPath');
  return new TempVault(tempVaultPath);
}

/**
 * Vitest global setup function.
 *
 * Copies the built plugin into a temporary vault, enables it via the Obsidian CLI,
 * and provides `tempVaultPath` to tests.
 *
 * @param project - The Vitest project.
 */
export async function setup(project: TestProject): Promise<void> {
  const environmentOptions = project.config.environmentOptions as Record<string, unknown> | undefined;
  const transportOptions = environmentOptions?.['obsidianTransport'] as ObsidianTransportOptions | undefined;

  setupResult = await coreSetup({ transportOptions });

  project.provide('obsidianTransport', setupResult.transportOptions);
  project.provide('tempVaultPath', setupResult.tempVault.path);
}

/**
 * Vitest global teardown function.
 *
 * Removes the temporary vault created during setup.
 */
export async function teardown(): Promise<void> {
  await coreTeardown(setupResult);
}
