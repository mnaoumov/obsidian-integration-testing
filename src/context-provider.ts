/**
 * @file
 *
 * Framework-neutral context provider for integration test state.
 *
 * Each framework adapter (vitest, jest) registers a resolver via
 * {@link setTransportOptionsResolver} during module initialization.
 * Core modules call {@link getTransportOptions} to retrieve the
 * transport options without depending on any specific test framework.
 */

import type { ObsidianTransportOptions } from './transport-options.ts';

/**
 * A function that resolves the current transport options.
 */
export type TransportOptionsResolver = () => ObsidianTransportOptions | undefined;

let resolver: TransportOptionsResolver | undefined;

/**
 * Returns the transport options resolved by the registered framework adapter.
 *
 * @returns The transport options, or `undefined` if not configured (defaults to CLI transport).
 */
export function getTransportOptions(): ObsidianTransportOptions | undefined {
  return resolver?.();
}

/**
 * Registers a resolver function for transport options. Called by framework
 * adapters at module load time to bridge their native injection mechanisms.
 *
 * @param fn - The resolver function.
 */
export function setTransportOptionsResolver(fn: TransportOptionsResolver): void {
  resolver = fn;
}
