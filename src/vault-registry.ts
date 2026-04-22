/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

/**
 * @file
 *
 * Manages vault registration in the running Obsidian instance.
 * Delegates to the active transport.
 */

import { getTransport } from './transport-state.ts';

/**
 * Registers a vault path in the running Obsidian instance.
 *
 * Delegates to the active transport's {@link ObsidianTransport.registerVault}.
 *
 * @param vaultPath - The absolute path to the vault folder.
 */
export async function registerVault(vaultPath: string): Promise<void> {
  await getTransport().registerVault(vaultPath);
}

/**
 * Unregisters a vault path from the running Obsidian instance.
 *
 * Delegates to the active transport's {@link ObsidianTransport.unregisterVault}.
 *
 * @param vaultPath - The absolute path to the vault folder.
 */
export async function unregisterVault(vaultPath: string): Promise<void> {
  await getTransport().unregisterVault(vaultPath);
}

/* v8 ignore stop */
