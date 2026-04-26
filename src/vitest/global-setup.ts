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
import { log } from '../log.ts';
import { serializeError } from '../serialize-error.ts';
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
  const setupErrorMessage = inject('setupError');
  if (setupErrorMessage) {
    throw new Error(`Integration setup failed — cannot get temp vault: ${setupErrorMessage}`);
  }
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
  const label = transportOptions?.type ?? 'obsidian-cli';

  try {
    setupResult = await coreSetup({ transportOptions });
  } catch (error: unknown) {
    // Catch setup errors so that other projects' tests can still run.
    // Individual tests in this project will fail with the stored error
    // When they try to inject the temp vault path.
    log(`[integration-setup:${label}] Setup failed (tests for this project will be skipped): ${serializeError(error)}`);
    project.provide('setupError', serializeError(error));
    return;
  }

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
