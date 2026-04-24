/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

/**
 * @file
 *
 * Manages vault registration in the running Obsidian instance.
 * Delegates to the transport resolved from vitest-provided options.
 */

import { inject } from 'vitest';

import type { ObsidianTransport } from './transport.ts';

import { getOrCreateTransport } from './transport-factory.ts';

/**
 * Registers a vault path in the running Obsidian instance.
 *
 * Delegates to the active transport's {@link ObsidianTransport.registerVault}.
 *
 * @param vaultPath - The absolute path to the vault folder.
 * @param transportOverride - An explicit transport to use. When omitted,
 *   falls back to `inject('obsidianTransport')` (requires vitest worker context).
 */
export async function registerVault(vaultPath: string, transportOverride?: ObsidianTransport): Promise<void> {
  const transport = transportOverride ?? await getOrCreateTransport(inject('obsidianTransport'));
  await transport.registerVault(vaultPath);
}

/**
 * Unregisters a vault path from the running Obsidian instance.
 *
 * Delegates to the active transport's {@link ObsidianTransport.unregisterVault}.
 *
 * @param vaultPath - The absolute path to the vault folder.
 * @param transportOverride - An explicit transport to use. When omitted,
 *   falls back to `inject('obsidianTransport')` (requires vitest worker context).
 */
export async function unregisterVault(vaultPath: string, transportOverride?: ObsidianTransport): Promise<void> {
  const transport = transportOverride ?? await getOrCreateTransport(inject('obsidianTransport'));
  await transport.unregisterVault(vaultPath);
}

/* v8 ignore stop */
