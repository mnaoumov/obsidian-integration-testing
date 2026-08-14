/**
 * @file
 *
 * Adds a caption band to an already-captured screenshot.
 *
 * A store listing shows screenshots ONE AT A TIME, in a carousel, with no
 * caption of its own — so an image has to say what it is showing. Without that,
 * a shot of the state a plugin removes reads as a shot of the state the plugin
 * causes, which is the opposite of the message.
 *
 * The band is drawn over the BOTTOM of the frame, for two reasons: the top is
 * where the content being demonstrated usually starts, and the bottom of an
 * Obsidian frame is chrome — status bar, word count, sync indicator — which the
 * band then covers rather than competing with.
 *
 * This is post-processing, deliberately. The capture stays an untouched device
 * frame, and rewording a label needs no re-shoot.
 */

import type { SharpCompositeLayer } from './sharp-loader.ts';

import { importSharp } from './sharp-loader.ts';

/**
 * Parameters for {@link computeLabelBand}.
 */
export interface ComputeLabelBandParams {
  /**
   * Height of the image being labeled, in pixels.
   */
  readonly imageHeightInPixels: number;

  /**
   * Width of the image being labeled, in pixels.
   */
  readonly imageWidthInPixels: number;
}

/**
 * The geometry of the caption band.
 */
export interface LabelBandGeometry {
  /**
   * Font size for the caption, in pixels.
   */
  readonly fontSizeInPixels: number;

  /**
   * Height of the band, in pixels.
   */
  readonly heightInPixels: number;

  /**
   * Distance from the top of the image to the top of the band, in pixels.
   */
  readonly topInPixels: number;
}

/**
 * Options for {@link labelScreenshot}.
 */
export interface LabelScreenshotOptions {
  /**
   * The caption. Keep it to a handful of words: it is read at listing-thumbnail
   * size, and it is clipped rather than wrapped.
   */
  readonly text: string;
}

/**
 * Caption size as a fraction of image WIDTH, not height.
 *
 * Width is what governs legibility here: a 900x1600 phone frame and a 1200x800
 * desktop frame are read at similar on-screen widths in a listing, so sizing by
 * width keeps the caption visually consistent across the two.
 */
const FONT_SIZE_RATIO = 0.034;

/**
 * Band height as a multiple of the font size — enough to sit the text on with
 * clear space above and below.
 */
const BAND_HEIGHT_RATIO = 2.2;

/**
 * Opacity of the band. Near-opaque on purpose: the band exists partly to COVER
 * the chrome along the bottom of the frame, and at 0.82 a status bar legibly
 * bled through behind the caption, which looked like a mistake rather than a
 * design.
 */
const BAND_OPACITY = 0.94;

const MINIMUM_FONT_SIZE_IN_PIXELS = 18;

/**
 * Floor on band height as a fraction of image HEIGHT.
 *
 * Height derived from the caption alone is too shallow on a tall frame: on a
 * 900x1600 phone it came to 68px and sliced through the status row it was meant
 * to cover, clipping the text mid-line. This floor makes the band deep enough to
 * swallow that row whole, and is inert on a wide frame where the caption-derived
 * height is already the larger of the two.
 */
const MINIMUM_HEIGHT_RATIO = 0.06;

/**
 * Divisor that turns a span into its midpoint, for centering the caption.
 */
const CENTER_DIVISOR = 2;

/**
 * Builds the SVG for the caption band.
 *
 * @param text - The caption.
 * @param geometry - The band geometry.
 * @param imageWidthInPixels - Width of the image, so the band spans it.
 * @returns The SVG markup.
 */
export function buildLabelSvg(text: string, geometry: LabelBandGeometry, imageWidthInPixels: number): string {
  const { fontSizeInPixels, heightInPixels } = geometry;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(imageWidthInPixels)}" height="${String(heightInPixels)}">`
    + `<rect x="0" y="0" width="${String(imageWidthInPixels)}" height="${String(heightInPixels)}" `
    + `fill="#000000" fill-opacity="${String(BAND_OPACITY)}"/>`
    + `<text x="${String(imageWidthInPixels / CENTER_DIVISOR)}" y="${String(heightInPixels / CENTER_DIVISOR)}" `
    + `font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${String(fontSizeInPixels)}" `
    + 'font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="central">'
    + `${escapeSvgText(text)}</text></svg>`;
}

/**
 * Computes the caption band's size and position for a given image.
 *
 * @param params - The image dimensions.
 * @returns The band geometry.
 * @throws Error if either dimension is not a positive number.
 */
export function computeLabelBand(params: ComputeLabelBandParams): LabelBandGeometry {
  const { imageHeightInPixels, imageWidthInPixels } = params;

  if (!Number.isFinite(imageWidthInPixels) || imageWidthInPixels <= 0) {
    throw new Error(`computeLabelBand: imageWidthInPixels must be a positive number, got ${String(imageWidthInPixels)}.`);
  }

  if (!Number.isFinite(imageHeightInPixels) || imageHeightInPixels <= 0) {
    throw new Error(`computeLabelBand: imageHeightInPixels must be a positive number, got ${String(imageHeightInPixels)}.`);
  }

  const fontSizeInPixels = Math.max(MINIMUM_FONT_SIZE_IN_PIXELS, Math.round(imageWidthInPixels * FONT_SIZE_RATIO));
  const captionHeightInPixels = Math.round(fontSizeInPixels * BAND_HEIGHT_RATIO);
  const flooredHeightInPixels = Math.max(captionHeightInPixels, Math.round(imageHeightInPixels * MINIMUM_HEIGHT_RATIO));
  const heightInPixels = Math.min(imageHeightInPixels, flooredHeightInPixels);

  return {
    fontSizeInPixels,
    heightInPixels,
    topInPixels: imageHeightInPixels - heightInPixels
  };
}

/**
 * Escapes text for inclusion in SVG character data.
 *
 * A caption is authored per screenshot and can legitimately contain `&` or the
 * angle brackets Obsidian uses in link syntax; unescaped, those make the SVG
 * impossible to parse and `sharp` fails on a caption rather than on an image.
 *
 * @param text - The raw caption.
 * @returns The caption, safe to embed in SVG.
 */
export function escapeSvgText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;');
}

/**
 * Draws a caption band across the bottom of a screenshot.
 *
 * The image keeps its dimensions exactly: the band is composited OVER the
 * frame, never appended to it, because the store expects a specific size.
 *
 * @param bytes - The captured PNG.
 * @param options - The caption.
 * @returns A {@link Promise} that resolves to the labeled PNG, the same size as the input.
 * @throws Error if `sharp` is not installed, or the image dimensions cannot be read.
 */
export async function labelScreenshot(bytes: Uint8Array, options: LabelScreenshotOptions): Promise<Uint8Array> {
  const sharp = await importSharp('labelScreenshot');
  const metadata = await sharp(bytes).metadata();
  const imageWidthInPixels = metadata.width;
  const imageHeightInPixels = metadata.height;

  /* v8 ignore next 3 -- Defensive: `sharp` rejects a non-image before it can report metadata without dimensions, so this branch is unreachable from a test. */
  if (imageWidthInPixels === undefined || imageHeightInPixels === undefined) {
    throw new Error('labelScreenshot: could not read the source image dimensions.');
  }

  const geometry = computeLabelBand({ imageHeightInPixels, imageWidthInPixels });
  const svg = buildLabelSvg(options.text, geometry, imageWidthInPixels);
  const layer: SharpCompositeLayer = {
    input: Buffer.from(svg),
    left: 0,
    top: geometry.topInPixels
  };

  const labeled = await sharp(bytes)
    .composite([layer])
    .png()
    .toBuffer();

  return new Uint8Array(labeled);
}
