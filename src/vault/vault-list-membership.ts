/**
 * @file
 *
 * Pure reading of the vault registry an Obsidian instance reports over its `vault-list` IPC.
 *
 * An attached transport opens a vault in somebody else's running Obsidian over `vault-open`, and on teardown it used
 * to send `vault-remove` for it as well. `vault-remove` deletes the vault's entry from that instance's
 * `obsidian.json`, so a vault the user already had in the vault list, but not open, was dropped from it by an attach
 * that only meant to look at it. Whether the vault was in the registry BEFORE this transport touched it is therefore
 * what decides whether its entry may be removed afterwards.
 *
 * `vault-list` answers with the main process's own registry object, `{ [id]: { path, ts, open? } }` (read from the
 * Obsidian 1.x `main.js`). Kept out of the integration-only transport module so the reading is unit-tested.
 */

import { areVaultPathsMatching } from './vault-path-match.ts';

/**
 * Whether a vault path is listed in a `vault-list` answer.
 *
 * An answer that is not the expected object shape counts as listing the vault: the caller uses the result to decide
 * whether it may remove the vault's entry later, and leaving a stale entry behind is recoverable while removing the
 * user's own is not.
 *
 * @param registry - The value the `vault-list` IPC returned, or `undefined` when it could not be read.
 * @param vaultPath - The vault path to look for.
 * @returns `true` when the vault is listed, or when the answer cannot tell.
 */
export function checkIsVaultListed(registry: unknown, vaultPath: string): boolean {
  return typeof registry !== 'object' || registry === null || Object.values(registry).some((entry: unknown) => {
    return typeof entry === 'object' && entry !== null && ('path' in entry) && typeof entry.path === 'string' && areVaultPathsMatching(entry.path, vaultPath);
  });
}
