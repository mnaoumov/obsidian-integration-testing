/**
 * @file
 *
 * The vaults this worker has registered and not yet disposed, newest last.
 *
 * A failed test's screenshot has to frame the window the test was driving. A suite that registers its own
 * `TemporaryVault` drives that vault's window, not the shared one the global setup opened, so the failure hook
 * asks here first and falls back to the shared vault only when the worker registered none.
 */

import type { ObsidianTransport } from '../transport/transport.ts';

/**
 * A vault this worker registered, and the transport it was registered through.
 */
export interface RegisteredVault {
  /**
   * The vault's host path.
   */
  readonly path: string;

  /**
   * The transport the vault was registered through.
   */
  readonly transport: ObsidianTransport;
}

const registeredVaults: RegisteredVault[] = [];

/**
 * Forgets a vault, for its disposal.
 *
 * @param path - The vault's host path.
 */
export function forgetRegisteredVault(path: string): void {
  const index = registeredVaults.findIndex((vault) => vault.path === path);
  if (index !== -1) {
    registeredVaults.splice(index, 1);
  }
}

/**
 * Returns the vault this worker registered most recently and has not disposed.
 *
 * @returns The vault, or `null` when there is none.
 */
export function getMostRecentRegisteredVault(): null | RegisteredVault {
  return registeredVaults.at(-1) ?? null;
}

/**
 * Records a vault as registered, moving it to the end when it was already recorded.
 *
 * @param vault - The vault and its transport.
 */
export function recordRegisteredVault(vault: RegisteredVault): void {
  forgetRegisteredVault(vault.path);
  registeredVaults.push(vault);
}
