/**
 * @file
 *
 * Module-level singleton for the active {@link ObsidianTransport}.
 */

import type { ObsidianTransport } from './transport.ts';

import { DesktopCliTransport } from './transport-desktop-cli.ts';

let activeTransport: ObsidianTransport | undefined;

/**
 * Returns the active transport.
 *
 * If no transport has been explicitly set via {@link setTransport},
 * a {@link DesktopCliTransport} is created lazily as the default.
 *
 * @returns The active transport.
 */
export function getTransport(): ObsidianTransport {
  activeTransport ??= new DesktopCliTransport();
  return activeTransport;
}

/**
 * Sets the active transport.
 *
 * Call this before any {@link evalInObsidian} calls to use a non-default transport
 * (e.g. CDP or Appium).
 *
 * @param transport - The transport to use.
 */
export function setTransport(transport: ObsidianTransport): void {
  activeTransport = transport;
}
