/**
 * @file
 *
 * Paints the device's status bar out of a captured frame, so a device capture
 * can be committed.
 *
 * A framebuffer carries the status bar, and a status bar carries a wall clock, a
 * battery that charges while the emulator runs and a radio that comes and goes.
 * So re-running a capture suite on an unchanged tree rewrites its PNGs with
 * content nobody can commit, and the churn is invisible until someone diffs two
 * runs. `device-screenshot`'s header has always said a device capture is not
 * byte-reproducible; this is what makes one.
 *
 * **Pinning the bar was tried first, and is NOT sufficient — that finding is the
 * reason this helper exists rather than a `withSystemUiDemoMode` one.** SystemUI
 * demo mode (`sysui_demo_allowed`, plus one `com.android.systemui.demo`
 * broadcast per area: clock at a fixed `hhmm`, battery full and unplugged,
 * radios hidden, notification icons off) held the clock at `12:00` and two runs
 * still disagreed on **1823 full-contrast pixels**, because the bar's leading
 * group is laid out at a different offset between emulator boots —
 * intermittently, roughly one boot in four. The Tuner's `icon_blacklist` does
 * not help either: demo mode draws its own icon layer and ignores it. Measured
 * on a real AVD across five paired capture runs for `obsidian-link-picker`'s
 * store frames, which is where this recipe was worked out before it moved here.
 *
 * Removing the band rather than pinning it also retires every device setting
 * that pinning needed, and nothing in a status bar is evidence about a plugin. A
 * listing frame without one is what a listing frame normally looks like.
 *
 * **The band's height is the caller's to measure, and there is deliberately no
 * default.** A wrong height does not fail loudly by itself — it paints over the
 * product. What stands between the two is {@link resolveStatusBarBand}: the row
 * just under the bar's own content must be one flat color all the way across,
 * which is what an empty band looks like and is also where the fill color is
 * sampled from. A taller bar, or an Obsidian that draws higher, fails the
 * capture instead.
 *
 * Compositing over a captured frame is not a new liberty: `labelScreenshot`
 * already draws the caption band across the bottom of the same image.
 */

import type { SharpCompositeLayer } from './sharp-loader.ts';

import { importSharp } from './sharp-loader.ts';

/**
 * Parameters for {@link buildStatusBarBandFailureMessage}.
 */
export interface BuildStatusBarBandFailureMessageParams {
  /**
   * How far in from each edge the row was scanned, in pixels.
   */
  readonly edgeMarginInPixels: number;

  /**
   * The height of the band that was about to be painted, in pixels.
   */
  readonly heightInPixels: number;

  /**
   * The verdict being reported.
   */
  readonly verdict: StatusBarBandVerdict;

  /**
   * The frame's width, in pixels.
   */
  readonly widthInPixels: number;
}

/**
 * Options for {@link paintOutStatusBar}.
 */
export interface PaintOutStatusBarOptions {
  /**
   * How far in from each edge the clear-of-chrome check reads.
   *
   * @default {@link DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS}
   */
  readonly edgeMarginInPixels?: number;

  /**
   * How tall the device's status bar is, in framebuffer pixels.
   *
   * **Measured, never assumed, and deliberately without a default.** 24dp at a
   * density of 320 is 48px, and that is one AVD's number rather than a constant
   * of Android. Measure it on a frame: the bar's own content occupies the top
   * rows, a few empty rows follow, and the app's top chrome starts at exactly
   * this offset.
   */
  readonly heightInPixels: number;

  /**
   * How far above the band's bottom edge the fill color is sampled, in pixels.
   *
   * @default {@link DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS}
   */
  readonly sampleInsetInPixels?: number;
}

/**
 * Parameters for {@link resolveStatusBarBand}.
 */
export interface ResolveStatusBarBandParams {
  /**
   * How many bytes each pixel occupies in {@link ResolveStatusBarBandParams.pixels} — 3 for RGB, 4 for RGBA.
   */
  readonly channelCount: number;

  /**
   * How far in from each edge to start reading, in pixels.
   *
   * A device's rounded corners darken a handful of pixels at both ends of every
   * row in the band, constantly and harmlessly; the check is about what the APP
   * draws, so it ignores them.
   *
   * @default {@link DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS}
   */
  readonly edgeMarginInPixels?: number;

  /**
   * The height of the band, in pixels — the same number {@link paintOutStatusBar} would paint.
   */
  readonly heightInPixels: number;

  /**
   * The frame's raw pixels, row-major, as `sharp`'s `raw()` reports them.
   */
  readonly pixels: Uint8Array;

  /**
   * How far above the band's bottom edge the row is read from, in pixels.
   *
   * The bar's own content stops short of the band's bottom edge, so the rows
   * immediately under it are empty; this picks one of them.
   *
   * @default {@link DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS}
   */
  readonly sampleInsetInPixels?: number;

  /**
   * The frame's width, in pixels.
   */
  readonly widthInPixels: number;
}

/**
 * A color read out of a frame, channel by channel.
 *
 * This package's own type rather than `sharp`'s, because it is part of the
 * public surface and `sharp` is an OPTIONAL peer: a consumer that never installs
 * it still names this. Structurally what `sharp`'s `background` takes, which is
 * how the fill block is created from one with no conversion in between.
 */
export interface StatusBarBandColor {
  /**
   * The blue channel, 0-255.
   */
  readonly b: number;

  /**
   * The green channel, 0-255.
   */
  readonly g: number;

  /**
   * The red channel, 0-255.
   */
  readonly r: number;
}

/**
 * What the row under the status bar's content turned out to hold.
 *
 * Verdict-as-data, like the compatibility and teardown checks: the reading and
 * the throwing are separate, so a caller can ask what a frame looks like without
 * having to catch an error to find out.
 */
export interface StatusBarBandVerdict {
  /**
   * The color the band would be filled with — read from the first scanned column of the sample row.
   */
  readonly backgroundColor: StatusBarBandColor;

  /**
   * How many distinct colors the scanned row holds. One is what an empty band looks like.
   */
  readonly distinctColorCount: number;

  /**
   * The color at {@link StatusBarBandVerdict.firstDifferentColumnXInPixels}, or `null` when the row is flat.
   */
  readonly firstDifferentColor: null | StatusBarBandColor;

  /**
   * The first scanned column that differs from {@link StatusBarBandVerdict.backgroundColor}, or `null` when the row is flat.
   */
  readonly firstDifferentColumnXInPixels: null | number;

  /**
   * Whether the row is one flat color, and so whether the band holds nothing but device chrome.
   */
  readonly isClear: boolean;

  /**
   * Which row was read, as a distance from the top of the frame in pixels.
   */
  readonly sampleRowYInPixels: number;
}

/**
 * How far in from each edge the clear-of-chrome check reads, in pixels.
 *
 * Exported because a caller tightening or loosening it wants to say so relative
 * to this rather than in the abstract.
 */
export const DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS = 100;

/**
 * How far above the band's bottom edge the sample row sits, in pixels.
 *
 * Four rows up: far enough to clear the bar's own content, close enough to still
 * be inside the band on every device this has been measured on.
 */
export const DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS = 4;

/**
 * Byte offset of the blue channel within one pixel of a raw frame.
 */
const BLUE_CHANNEL_OFFSET = 2;

/**
 * How many channels the fill block is created with — RGB, with no alpha, because it is opaque by construction.
 */
const FILL_CHANNEL_COUNT = 3;

/**
 * Byte offset of the green channel within one pixel of a raw frame.
 */
const GREEN_CHANNEL_OFFSET = 1;

/**
 * The fewest columns a meaningful scan can cover.
 *
 * One column is trivially flat, so a margin that leaves fewer than two is a
 * check that cannot fail — the exact shape this helper exists to avoid.
 */
const MINIMUM_SCANNED_COLUMN_COUNT = 2;

/**
 * Byte offset of the red channel within one pixel of a raw frame.
 */
const RED_CHANNEL_OFFSET = 0;

/**
 * Builds the message a band that is not clear is refused with.
 *
 * Separate from the throwing so it can be asserted on directly: what makes this
 * failure actionable is the measurement, not the wording around it.
 *
 * @param params - The verdict and the geometry it was read with.
 * @returns The message, ready to throw.
 */
export function buildStatusBarBandFailureMessage(params: BuildStatusBarBandFailureMessageParams): string {
  const {
    edgeMarginInPixels,
    heightInPixels,
    verdict,
    widthInPixels
  } = params;

  const lines = [
    'paintOutStatusBar: the row under the status bar holds more than one color, so a band of '
    + `${String(heightInPixels)}px would paint over the app rather than over the device.`,
    `band=${String(heightInPixels)}px sampleRow=y${String(verdict.sampleRowYInPixels)} `
    + `scanned x${String(edgeMarginInPixels)}..${String(widthInPixels - edgeMarginInPixels)} `
    + `of ${String(widthInPixels)}px distinctColors=${String(verdict.distinctColorCount)}`,
    `sampled ${formatColor(verdict.backgroundColor)}, but x=${String(verdict.firstDifferentColumnXInPixels)} `
    + `is ${formatColor(verdict.firstDifferentColor)}`,
    'A taller status bar, or an Obsidian that draws higher, both look like this. Measure the band on a fresh '
    + 'frame and pass the height you measured: enlarging it until the check passes is how a capture paints '
    + 'over the product.'
  ];

  return lines.join('\n');
}

/**
 * Fills the status-bar band with the background behind it, so the frame carries no device chrome.
 *
 * The image keeps its dimensions exactly: the band is composited OVER the frame,
 * never cropped off it, because a store listing expects a specific size and a
 * cropped frame is a different picture.
 *
 * @param bytes - The device framebuffer, as `captureDeviceScreenshot` returned it.
 * @param options - How tall the band is, and how the check reads it.
 * @returns A {@link Promise} that resolves to the same frame with the band painted out, as PNG bytes.
 * @throws Error if `sharp` is not installed, the band is as tall as the frame or taller, or the row under
 *   the bar's content is not one flat color — see {@link buildStatusBarBandFailureMessage}.
 */
export async function paintOutStatusBar(bytes: Uint8Array, options: PaintOutStatusBarOptions): Promise<Uint8Array> {
  const { heightInPixels } = options;
  const edgeMarginInPixels = options.edgeMarginInPixels ?? DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS;
  const sharp = await importSharp('paintOutStatusBar');
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (heightInPixels >= info.height) {
    throw new Error(
      `paintOutStatusBar: a band of ${String(heightInPixels)}px would cover a frame that is only `
        + `${String(info.height)}px tall. That is a measurement of some other device, not of this frame.`
    );
  }

  const verdict = resolveStatusBarBand({
    channelCount: info.channels,
    edgeMarginInPixels,
    heightInPixels,
    pixels: data,
    ...(options.sampleInsetInPixels !== undefined && { sampleInsetInPixels: options.sampleInsetInPixels }),
    widthInPixels: info.width
  });

  if (!verdict.isClear) {
    throw new Error(buildStatusBarBandFailureMessage({
      edgeMarginInPixels,
      heightInPixels,
      verdict,
      widthInPixels: info.width
    }));
  }

  const layer: SharpCompositeLayer = {
    input: {
      create: {
        background: verdict.backgroundColor,
        channels: FILL_CHANNEL_COUNT,
        height: heightInPixels,
        width: info.width
      }
    },
    left: 0,
    top: 0
  };

  const painted = await sharp(bytes)
    .composite([layer])
    .png()
    .toBuffer();

  return new Uint8Array(painted);
}

/**
 * Reads the row under the status bar's content and says whether the band is clear of the app.
 *
 * The band's height is a number a caller measured once, and a measured number
 * can go stale — a taller status bar, or an Obsidian that draws higher, would
 * have the capture quietly paint over the product. So the row just below the
 * bar's own content is required to be one flat color all the way across: that
 * is what an empty band looks like, and it is what the fill color is read from.
 *
 * @param params - The frame's raw pixels and the band's geometry.
 * @returns What the scanned row holds.
 * @throws Error if the geometry is degenerate — a non-positive dimension, a sample row above the top of
 *   the frame, a margin that leaves nothing to scan, or a buffer too short to hold the row.
 */
export function resolveStatusBarBand(params: ResolveStatusBarBandParams): StatusBarBandVerdict {
  const {
    channelCount,
    heightInPixels,
    pixels,
    widthInPixels
  } = params;
  const edgeMarginInPixels = params.edgeMarginInPixels ?? DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS;
  const sampleInsetInPixels = params.sampleInsetInPixels ?? DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS;

  assertPositive('widthInPixels', widthInPixels);
  assertPositive('heightInPixels', heightInPixels);
  assertPositive('channelCount', channelCount);

  const sampleRowYInPixels = heightInPixels - sampleInsetInPixels;

  if (sampleRowYInPixels < 0) {
    throw new Error(
      `resolveStatusBarBand: a sample inset of ${String(sampleInsetInPixels)}px puts the sample row above the top `
        + `of the frame for a band of ${String(heightInPixels)}px.`
    );
  }

  const lastScannedColumnXInPixels = widthInPixels - edgeMarginInPixels;

  if (lastScannedColumnXInPixels - edgeMarginInPixels < MINIMUM_SCANNED_COLUMN_COUNT) {
    throw new Error(
      `resolveStatusBarBand: an edge margin of ${String(edgeMarginInPixels)}px leaves fewer than `
        + `${String(MINIMUM_SCANNED_COLUMN_COUNT)} columns of a ${String(widthInPixels)}px frame to scan, `
        + 'which is a check that cannot fail.'
    );
  }

  const rowStartOffset = sampleRowYInPixels * widthInPixels * channelCount;
  const requiredLength = rowStartOffset + widthInPixels * channelCount;

  if (pixels.length < requiredLength) {
    throw new Error(
      `resolveStatusBarBand: the frame holds ${String(pixels.length)} bytes, too few for row `
        + `y${String(sampleRowYInPixels)} of a ${String(widthInPixels)}px-wide frame at `
        + `${String(channelCount)} channels, which needs ${String(requiredLength)}.`
    );
  }

  const backgroundColor = readColor(pixels, rowStartOffset + edgeMarginInPixels * channelCount);
  const backgroundKey = formatColor(backgroundColor);
  const colorKeys = new Set<string>();
  let firstDifferentColor: null | StatusBarBandColor = null;
  let firstDifferentColumnXInPixels: null | number = null;

  for (let x = edgeMarginInPixels; x < lastScannedColumnXInPixels; x++) {
    const color = readColor(pixels, rowStartOffset + x * channelCount);
    const colorKey = formatColor(color);
    colorKeys.add(colorKey);

    if (firstDifferentColumnXInPixels !== null || colorKey === backgroundKey) {
      continue;
    }

    firstDifferentColor = color;
    firstDifferentColumnXInPixels = x;
  }

  return {
    backgroundColor,
    distinctColorCount: colorKeys.size,
    firstDifferentColor,
    firstDifferentColumnXInPixels,
    isClear: colorKeys.size === 1,
    sampleRowYInPixels
  };
}

/**
 * Refuses a dimension that cannot describe a frame.
 *
 * @param name - The parameter being checked, so the message names it.
 * @param value - What was passed.
 * @throws Error if the value is not a positive finite number.
 */
function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`resolveStatusBarBand: ${name} must be a positive number, got ${String(value)}.`);
  }
}

/**
 * Renders a color as text, for comparison and for the diagnostic.
 *
 * The same rendering does both jobs on purpose: what a reader is shown is the
 * value the comparison was made on, rather than a re-formatting of it.
 *
 * @param color - The color, or `null` when there was none to report.
 * @returns The color as `rgb(r,g,b)`, or `(none)`.
 */
function formatColor(color: null | StatusBarBandColor): string {
  return color === null ? '(none)' : `rgb(${String(color.r)},${String(color.g)},${String(color.b)})`;
}

/**
 * Reads one pixel's color out of a raw frame, ignoring any alpha channel.
 *
 * @param pixels - The frame's raw bytes.
 * @param offset - The byte offset of the pixel.
 * @returns The color at that offset.
 */
function readColor(pixels: Uint8Array, offset: number): StatusBarBandColor {
  /* v8 ignore start -- The fallbacks are unreachable: every read is inside a row `resolveStatusBarBand` has already proved the buffer long enough to hold. They are here because an index read is typed `number | undefined`, not because a pixel can be missing. */
  return {
    b: pixels[offset + BLUE_CHANNEL_OFFSET] ?? 0,
    g: pixels[offset + GREEN_CHANNEL_OFFSET] ?? 0,
    r: pixels[offset + RED_CHANNEL_OFFSET] ?? 0
  };
  /* v8 ignore stop */
}
