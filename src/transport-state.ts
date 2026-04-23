/**
 * @file
 *
 * Module-level transport state for the active {@link ObsidianTransport}.
 */

import process from 'node:process';

import type { ObsidianTransport } from './transport.ts';

import { DesktopCdpTransport } from './transport-desktop-cdp.ts';
import { DesktopCliTransport } from './transport-desktop-cli.ts';

const TRANSPORT_ENV_VAR = 'OBSIDIAN_DESKTOP_TRANSPORT';

let activeTransport: ObsidianTransport | undefined;

/**
 * Returns the active transport.
 *
 * If a transport has been explicitly set via {@link setTransport}, returns that.
 * Otherwise, creates a new transport based on the `OBSIDIAN_DESKTOP_TRANSPORT`
 * environment variable: `"cdp"` for {@link DesktopCdpTransport}, `"cli"` (or unset)
 * for {@link DesktopCliTransport}.
 *
 * A new transport instance is created on each call when no explicit transport is set,
 * so the env var can be changed between calls.
 *
 * @returns The active transport.
 */
export function getTransport(): ObsidianTransport {
  return activeTransport ?? createDefaultTransport();
}

/**
 * Sets the active transport.
 *
 * For desktop transports, prefer the `OBSIDIAN_DESKTOP_TRANSPORT` environment variable
 * (`"cli"` or `"cdp"`) over calling this function. Use `setTransport()` for
 * custom or mobile transports (e.g. {@link AppiumTransport}).
 *
 * @param transport - The transport to use.
 */
export function setTransport(transport: ObsidianTransport): void {
  activeTransport = transport;
}

/**
 * Creates the default desktop transport based on the `OBSIDIAN_DESKTOP_TRANSPORT`
 * environment variable.
 *
 * - `"cdp"` — {@link DesktopCdpTransport}
 * - `"cli"` (or unset) — {@link DesktopCliTransport}
 *
 * @returns The default transport.
 */
function createDefaultTransport(): ObsidianTransport {
  const envValue = process.env[TRANSPORT_ENV_VAR]?.toLowerCase();

  if (envValue === 'cdp') {
    return new DesktopCdpTransport();
  }

  if (envValue !== undefined && envValue !== 'cli') {
    throw new Error(`Unknown ${TRANSPORT_ENV_VAR} value: "${envValue}". Expected "cli" or "cdp".`);
  }

  return new DesktopCliTransport();
}
