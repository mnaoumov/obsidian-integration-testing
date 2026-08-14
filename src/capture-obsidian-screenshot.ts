/**
 * @file
 *
 * Captures a screenshot of the Obsidian instance the current test context is
 * already driving.
 *
 * The transport-level `captureScreenshot` needs a transport in hand, which a
 * test running under the harness's global setup never has — the instance is
 * owned by that setup and reached through the context provider. This is the
 * context-resolving entry point, the screenshot counterpart of
 * `evalInObsidian` / `pollInObsidian`: with no arguments at all it captures
 * whatever instance the active project is driving, desktop or mobile.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import process from 'node:process';

import type { CaptureScreenshotParams } from './capture-screenshot.ts';
import type { ObsidianTransport } from './transport.ts';

import {
  getTransportOptions,
  getVaultPath
} from './context-provider.ts';
import { normalizeOptionalProperties } from './normalize-optional-properties.ts';
import { getOrCreateTransport } from './transport-factory.ts';

/**
 * Options for {@link captureObsidianScreenshot}.
 */
export interface CaptureObsidianScreenshotOptions {
  /**
   * The exact height in pixels the captured image should have.
   *
   * Desktop only, and only meaningful together with {@link widthInPixels}.
   * Ignored on mobile, where the image is always the device's native
   * framebuffer — size those by choosing an AVD with the wanted screen
   * geometry.
   */
  readonly heightInPixels?: number;

  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault path to capture. When omitted, the current test context's vault
   * is used.
   */
  readonly vaultPath?: string;

  /**
   * The exact width in pixels the captured image should have.
   *
   * See {@link heightInPixels} — the two are set together or not at all.
   */
  readonly widthInPixels?: number;
}

/**
 * Captures a PNG screenshot of the running Obsidian instance, resolving the
 * transport and vault from the current test context.
 *
 * @param options - Optional size, transport and vault overrides.
 * @returns A {@link Promise} that resolves to the raw PNG bytes.
 * @throws Error if the active transport cannot capture screenshots.
 */
export async function captureObsidianScreenshot(options?: CaptureObsidianScreenshotOptions): Promise<Uint8Array> {
  const {
    heightInPixels,
    transport: transportOverride,
    vaultPath,
    widthInPixels
  } = options ?? {};

  const cwd = vaultPath ?? getVaultPath() ?? process.cwd();
  const transport = transportOverride ?? await getOrCreateTransport(getTransportOptions());

  if (!transport.captureScreenshot) {
    throw new Error('captureObsidianScreenshot: the active transport cannot capture screenshots.');
  }

  return transport.captureScreenshot(normalizeOptionalProperties<CaptureScreenshotParams>({
    cwd,
    heightInPixels,
    widthInPixels
  }));
}

/* v8 ignore stop */
