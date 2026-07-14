/**
 * @file
 *
 * Framework-neutral context provider for integration test state.
 *
 * Each framework adapter (vitest, jest) registers resolvers via
 * {@link setTransportOptionsResolver} and {@link setVaultPathResolver}
 * during module initialization. Core modules call the corresponding
 * getters to retrieve state without depending on any specific test framework.
 */

import type { ObsidianTransportOptions } from './transport-options.ts';

/**
 * A function that resolves the current transport options.
 */
export type TransportOptionsResolver = () => ObsidianTransportOptions | undefined;

/**
 * A function that resolves the current vault path.
 */
export type VaultPathResolver = () => string | undefined;

let transportOptionsResolver: TransportOptionsResolver | undefined;
let vaultPathResolver: undefined | VaultPathResolver;

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
 * Registers a resolver function for transport options. Called by framework
 * adapters at module load time to bridge their native injection mechanisms.
 *
 * @param fn - The resolver function.
 */
export function setTransportOptionsResolver(fn: TransportOptionsResolver): void {
  transportOptionsResolver = fn;
}

/**
 * Registers a resolver function for the vault path. Called by framework
 * adapters at module load time to bridge their native injection mechanisms.
 *
 * @param fn - The resolver function.
 */
export function setVaultPathResolver(fn: VaultPathResolver): void {
  vaultPathResolver = fn;
}
