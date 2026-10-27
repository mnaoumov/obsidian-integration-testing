/**
 * @file
 *
 * Framework-neutral context provider for integration test state.
 *
 * Each framework adapter (vitest, jest) registers resolvers via
 * {@link setTransportOptionsResolver}, {@link setVaultPathResolver} and
 * {@link setSetupErrorResolver} during module initialization. Core modules call the
 * corresponding getters to retrieve state without depending on any specific test framework.
 */

import type { IntegrationSetupFailedErrorConstructorParams } from './integration-setup-failed-error.ts';
import type { ObsidianTransportOptions } from './transport-options.ts';

/**
 * A function that resolves the failure of this project's global setup, if it failed.
 */
export type SetupErrorResolver = () => IntegrationSetupFailedErrorConstructorParams | undefined;

/**
 * A function that resolves the current transport options.
 */
export type TransportOptionsResolver = () => ObsidianTransportOptions | undefined;

/**
 * A function that resolves the current vault path.
 */
export type VaultPathResolver = () => string | undefined;

let setupErrorResolver: SetupErrorResolver | undefined;
let transportOptionsResolver: TransportOptionsResolver | undefined;
let vaultPathResolver: undefined | VaultPathResolver;

/**
 * Returns the failure of this project's global setup, as published by the registered
 * framework adapter. A test worker must fail with this rather than build a transport
 * of its own: with no options published, the default is the owned **desktop** CDP
 * instance, whatever platform the project asked for.
 *
 * @returns The setup failure, or `undefined` if the setup succeeded (or never ran).
 */
export function getSetupError(): IntegrationSetupFailedErrorConstructorParams | undefined {
  return setupErrorResolver?.();
}

/**
 * Returns the transport options resolved by the registered framework adapter.
 *
 * @returns The transport options, or `undefined` if not configured.
 */
export function getTransportOptions(): ObsidianTransportOptions | undefined {
  return transportOptionsResolver?.();
}

/**
 * Returns the vault path resolved by the registered framework adapter.
 *
 * @returns The vault path, or `undefined` if not configured (falls back to `process.cwd()`).
 */
export function getVaultPath(): string | undefined {
  return vaultPathResolver?.();
}

/**
 * Registers a resolver function for this project's setup failure. Called by framework
 * adapters at module load time to bridge their native injection mechanisms — most
 * importantly in the **per-worker** setup file, which is where the failure has to be
 * seen (see `vitest/setup.ts`).
 *
 * @param callback - The resolver function.
 */
export function setSetupErrorResolver(callback: SetupErrorResolver): void {
  setupErrorResolver = callback;
}

/**
 * Registers a resolver function for transport options. Called by framework
 * adapters at module load time to bridge their native injection mechanisms.
 *
 * @param callback - The resolver function.
 */
export function setTransportOptionsResolver(callback: TransportOptionsResolver): void {
  transportOptionsResolver = callback;
}

/**
 * Registers a resolver function for the vault path. Called by framework
 * adapters at module load time to bridge their native injection mechanisms.
 *
 * @param callback - The resolver function.
 */
export function setVaultPathResolver(callback: VaultPathResolver): void {
  vaultPathResolver = callback;
}
