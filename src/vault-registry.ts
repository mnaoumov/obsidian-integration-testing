/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

/**
 * @file
 *
 * Manages vault registration in the running Obsidian instance.
 * Delegates to the transport resolved from vitest-provided options.
 */

import { inject } from 'vitest';

import { getOrCreateTransport } from './transport-factory.ts';

/**
 * Registers a vault path in the running Obsidian instance.
 *
 * Delegates to the active transport's {@link ObsidianTransport.registerVault}.
 *
 * @param vaultPath - The absolute path to the vault folder.
 */
export async function registerVault(vaultPath: string): Promise<void> {
  const transport = await getOrCreateTransport(inject('obsidianTransport'));
  await transport.registerVault(vaultPath);
}

/**
 * Unregisters a vault path from the running Obsidian instance.
 *
 * Delegates to the active transport's {@link ObsidianTransport.unregisterVault}.
 *
 * @param vaultPath - The absolute path to the vault folder.
 */
export async function unregisterVault(vaultPath: string): Promise<void> {
  const transport = await getOrCreateTransport(inject('obsidianTransport'));
  await transport.unregisterVault(vaultPath);
}

/* v8 ignore stop */
