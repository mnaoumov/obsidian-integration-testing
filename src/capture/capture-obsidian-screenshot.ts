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
 * see `hide-caret.ts` for why that is a transparent caret and not a blur —
 * and by drawing the window focused whether or not the OS gave it focus — see
 * `pin-window-focus.ts` for the title bar that otherwise darkens one run in
 * five.
 *
 * And it refuses a frame whose theme has changed since `applyObsidianTheme` set
 * it — see `apply-obsidian-theme.ts` for the config reload that silently turns a
 * dark capture run light.
 *
 * It also holds the page still for the capture — see `freeze-animations.ts` —
 * takes a named `preset` size, a `deviceScaleFactor`, and refuses a frame in
 * which an element matching one of `forbiddenSelectors` is visible — see
 * `forbidden-elements.ts`. A sized frame's PNG size is read back and checked.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import process from 'node:process';

import type { ObsidianTransport } from '../transport/transport.ts';
import type {
  ResolveScreenshotGeometryOptions,
  ScreenshotGeometry,
  ScreenshotPresetName
} from './capture-quality-options.ts';
import type { CaptureScreenshotParams } from './capture-screenshot.ts';

import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';
import {
  getTransportOptions,
  getVaultPath
} from '../transport/context-provider.ts';
import { getOrCreateTransport } from '../transport/transport-factory.ts';
import { assertObsidianThemeUnchanged } from './apply-obsidian-theme.ts';
import { resolveScreenshotGeometry } from './capture-quality-options.ts';
import { readPngDimensions } from './capture-screenshot.ts';
import { assertNoForbiddenElements } from './forbidden-elements.ts';
import { freezeAnimations } from './freeze-animations.ts';
import { hideCaret } from './hide-caret.ts';
import { hideVaultName } from './hide-vault-name.ts';
import { pinWindowFocus } from './pin-window-focus.ts';

/**
 * Options for {@link captureObsidianScreenshot}.
 */
export interface CaptureObsidianScreenshotOptions {
  /**
   * Device pixels per CSS pixel. Desktop only; see
   * `CaptureScreenshotParams.deviceScaleFactor`.
   *
   * @default `1` with a size, `2` without one, the mobile layout's own factor
   *   for an unsized capture under the mobile layout.
   */
  readonly deviceScaleFactor?: number;

  /**
   * CSS selectors no visible element may match when the frame is taken. A
   * frame that would show one is refused, naming the selector.
   *
   * Screenshots are committed and published, so this is where a notice naming a
   * real path, a token field or a personal note is kept out of them.
   */
  readonly forbiddenSelectors?: readonly string[];

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
   * A named destination size and density (`readme`, `listing-desktop`,
   * `listing-phone`, `social`; see `SCREENSHOT_PRESETS`), instead of
   * {@link widthInPixels}, {@link heightInPixels} and
   * {@link deviceScaleFactor}, which it cannot be combined with. Desktop only.
   */
  readonly preset?: ScreenshotPresetName;

  /**
   * Whether to hold the page still for the capture: transitions off, finite
   * animations jumped to their end, endless ones paused until the frame is
   * taken. See `freeze-animations.ts`.
   *
   * @default `true`
   */
  readonly shouldFreezeAnimations?: boolean;

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
   * Whether to draw the window as focused while capturing, so the frame does
   * not depend on whether the operating system gave the window foreground
   * focus that run.
   *
   * Obsidian darkens the title bar of an unfocused window, and a freshly
   * launched one is routinely refused the foreground. The `is-focused` class is
   * added for the capture and handed back to Obsidian afterwards; the window's
   * real focus is never touched. Turn it off only to photograph the unfocused
   * chrome itself, and expect such a frame to differ between runs.
   *
   * @default `true`
   */
  readonly shouldPinWindowFocus?: boolean;

  /**
   * Whether to refuse the frame when the body is no longer in the theme
   * `applyObsidianTheme` last applied.
   *
   * A theme lost after it was applied fails nothing on its own: the frame is
   * simply shot in the other theme and written over the committed one. Refusing
   * turns that into a named error. Nothing is checked when no theme was applied
   * through `applyObsidianTheme`. Turn it off only for a frame that changes the
   * theme on purpose.
   *
   * @default `true`
   */
  readonly shouldVerifyTheme?: boolean;

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

interface CaptureStillFrameParams {
  readonly cwd: string;
  readonly forbiddenSelectors: readonly string[];
  readonly geometry: ScreenshotGeometry;
  readonly shouldFreezeAnimations: boolean;
  readonly transport: ObsidianTransport;
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
 * turns that off. The window is drawn focused whether or not the OS gave it
 * focus; {@link CaptureObsidianScreenshotOptions.shouldPinWindowFocus} turns
 * that off. A frame whose body has left the theme `applyObsidianTheme`
 * applied is refused; {@link CaptureObsidianScreenshotOptions.shouldVerifyTheme}
 * turns that off.
 *
 * @param options - Optional size, transport and vault overrides.
 * @returns A {@link Promise} that resolves to the raw PNG bytes.
 * @throws Error if the active transport cannot capture screenshots, or if the
 *   theme has changed since `applyObsidianTheme` applied it.
 */
export async function captureObsidianScreenshot(options?: CaptureObsidianScreenshotOptions): Promise<Uint8Array> {
  const {
    deviceScaleFactor,
    forbiddenSelectors = [],
    heightInPixels,
    preset,
    shouldFreezeAnimations = true,
    shouldHideCaret = true,
    shouldHideVaultName = true,
    shouldPinWindowFocus = true,
    shouldVerifyTheme = true,
    transport: transportOverride,
    vaultPath,
    widthInPixels
  } = options ?? {};

  const geometry = resolveScreenshotGeometry(
    normalizeOptionalProperties<ResolveScreenshotGeometryOptions>({
      deviceScaleFactor,
      heightInPixels,
      preset,
      widthInPixels
    }),
    'captureObsidianScreenshot'
  );
  const cwd = vaultPath ?? getVaultPath() ?? process.cwd();
  const transport = transportOverride ?? await getOrCreateTransport(getTransportOptions());

  if (!transport.captureScreenshot) {
    throw new Error('captureObsidianScreenshot: the active transport cannot capture screenshots.');
  }

  if (shouldVerifyTheme) {
    await assertObsidianThemeUnchanged({
      action: 'capture a screenshot',
      transport,
      vaultPath: cwd
    });
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

  const pinnedWindowFocus = shouldPinWindowFocus
    ? await pinWindowFocus({
      transport,
      vaultPath: cwd
    })
    : undefined;

  try {
    return await captureStillFrame({
      cwd,
      forbiddenSelectors,
      geometry,
      shouldFreezeAnimations,
      transport
    });
  } finally {
    await pinnedWindowFocus?.restore();
    await hiddenCaret?.restore();
  }
}

/**
 * Refuses a sized desktop frame that came back at another size.
 *
 * @param bytes - The captured PNG.
 * @param geometry - The size the capture asked for.
 * @throws Error if a sized desktop capture returned a PNG of another size.
 */
function assertCapturedSize(bytes: Uint8Array, geometry: ScreenshotGeometry): void {
  if (geometry.widthInPixels === undefined || geometry.heightInPixels === undefined) {
    return;
  }
  const actual = readPngDimensions(bytes);
  if (actual.widthInPixels !== geometry.widthInPixels || actual.heightInPixels !== geometry.heightInPixels) {
    throw new Error(
      `captureObsidianScreenshot: asked for ${String(geometry.widthInPixels)} x ${String(geometry.heightInPixels)} pixels, `
        + `got ${String(actual.widthInPixels)} x ${String(actual.heightInPixels)}.`
    );
  }
}

/**
 * Freezes the page, checks the forbidden selectors, captures, checks the size,
 * and releases the page.
 *
 * @param params - The capture's resolved options.
 * @returns A {@link Promise} that resolves to the PNG bytes.
 */
async function captureStillFrame(params: CaptureStillFrameParams): Promise<Uint8Array> {
  const { cwd, forbiddenSelectors, geometry, shouldFreezeAnimations, transport } = params;
  const frozenAnimations = shouldFreezeAnimations
    ? await freezeAnimations({
      transport,
      vaultPath: cwd
    })
    : undefined;
  try {
    await assertNoForbiddenElements({
      action: 'captureObsidianScreenshot',
      forbiddenSelectors,
      transport,
      vaultPath: cwd
    });

    if (!transport.captureScreenshot) {
      throw new Error('captureObsidianScreenshot: the active transport cannot capture screenshots.');
    }

    const bytes = await transport.captureScreenshot(normalizeOptionalProperties<CaptureScreenshotParams>({
      cwd,
      deviceScaleFactor: geometry.deviceScaleFactor,
      heightInPixels: geometry.heightInPixels,
      widthInPixels: geometry.widthInPixels
    }));
    // Only the desktop transport honours a size, and only it has a viewport to override.
    if (transport.setViewportOverride) {
      assertCapturedSize(bytes, geometry);
    }
    return bytes;
  } finally {
    await frozenAnimations?.restore();
  }
}

/* v8 ignore stop */
