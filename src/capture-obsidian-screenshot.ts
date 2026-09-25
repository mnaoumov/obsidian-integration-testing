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
 *
 * It also makes the frame REPRODUCIBLE before taking it, by hiding the vault's
 * name — see `hide-vault-name.ts` for why a `temp-vault-<random>` bleeds
 * through the caption band and rewrites a checked-in PNG on every run — and by
 * hiding the focused element's blinking caret for the length of the capture —
 * see `hide-caret.ts` for why that is a transparent caret and not a blur.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import process from 'node:process';

import type { CaptureScreenshotParams } from './capture-screenshot.ts';
import type { ObsidianTransport } from './transport.ts';

import {
  getTransportOptions,
  getVaultPath
} from './context-provider.ts';
import { hideCaret } from './hide-caret.ts';
import { hideVaultName } from './hide-vault-name.ts';
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
   * Whether to hide the focused element's caret while capturing, so the frame
   * does not depend on which phase of its blink the capture caught.
   *
   * The caret is made transparent, not blurred: the focus, its ring and
   * anything open because of it — a suggester under an input — all stay as the
   * test built them, and the caret is put back once the frame is taken. Turn it
   * off only to photograph the caret itself, and expect such a frame to differ
   * between runs.
   *
   * @default `true`
   */
  readonly shouldHideCaret?: boolean;

  /**
   * Whether to hide the vault's name before capturing, so the frame does not
   * depend on the random suffix of the harness's temporary vault.
   *
   * A default rather than a knob: reproducibility is what a checked-in
   * screenshot is for, and the row it collapses sits under the caption band,
   * so nothing a reader sees moves. Turn it off only to photograph the vault
   * switcher itself.
   *
   * @default `true`
   */
  readonly shouldHideVaultName?: boolean;

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
 * The vault's name is hidden first, so two runs of the same suite against two
 * differently-named temporary vaults produce byte-identical PNGs. Pass
 * {@link CaptureObsidianScreenshotOptions.shouldHideVaultName} as `false` to
 * photograph it. The focused element's caret is hidden for the capture too, and
 * restored after it, so a frame with a focused field does not alternate between
 * two blink phases; {@link CaptureObsidianScreenshotOptions.shouldHideCaret}
 * turns that off.
 *
 * @param options - Optional size, transport and vault overrides.
 * @returns A {@link Promise} that resolves to the raw PNG bytes.
 * @throws Error if the active transport cannot capture screenshots.
 */
export async function captureObsidianScreenshot(options?: CaptureObsidianScreenshotOptions): Promise<Uint8Array> {
  const {
    heightInPixels,
    shouldHideCaret = true,
    shouldHideVaultName = true,
    transport: transportOverride,
    vaultPath,
    widthInPixels
  } = options ?? {};

  const cwd = vaultPath ?? getVaultPath() ?? process.cwd();
  const transport = transportOverride ?? await getOrCreateTransport(getTransportOptions());

  if (!transport.captureScreenshot) {
    throw new Error('captureObsidianScreenshot: the active transport cannot capture screenshots.');
  }

  if (shouldHideVaultName) {
    await hideVaultName({
      transport,
      vaultPath: cwd
    });
  }

  const hiddenCaret = shouldHideCaret
    ? await hideCaret({
      transport,
      vaultPath: cwd
    })
    : undefined;

  try {
    return await transport.captureScreenshot(normalizeOptionalProperties<CaptureScreenshotParams>({
      cwd,
      heightInPixels,
      widthInPixels
    }));
  } finally {
    await hiddenCaret?.restore();
  }
}

/* v8 ignore stop */
