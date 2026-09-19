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
 *
 * A caption that is too long for its frame is MEASURED and rejected rather than
 * drawn. An SVG `<text>` is clipped by its viewport at both ends with no
 * ellipsis and no error, so an overlong caption ships as a sentence fragment
 * that looks deliberate — `nabled in Settings - a listening plugin is told` —
 * and the frame is still exactly the size it should be, so every dimension
 * assertion downstream still passes. The only feedback anyone ever got was
 * looking at the PNG. See {@link measureLabelCaption}.
 */

import type { SharpCompositeLayer } from './sharp-loader.ts';

import { readPngDimensions } from './capture-screenshot.ts';
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
   * How much horizontal room the caption has, in pixels: the image width less
   * the margin held clear at each end, so a caption that fits does not read as
   * though it were about to touch the edge of the frame.
   */
  readonly captionRoomInPixels: number;

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
 * What a caption measures against the frame it is destined for.
 */
export interface LabelCaptionMeasurement {
  /**
   * The room available, in pixels — {@link LabelBandGeometry.captionRoomInPixels}.
   */
  readonly captionRoomInPixels: number;

  /**
   * Whether the caption fits that room.
   */
  readonly doesFit: boolean;

  /**
   * How wide the caption actually renders, in pixels, at the size the band
   * would draw it.
   */
  readonly textWidthInPixels: number;
}

/**
 * Options for {@link labelScreenshot}.
 */
export interface LabelScreenshotOptions {
  /**
   * The caption. Keep it to a handful of words: it is read at listing-thumbnail
   * size, and it is neither wrapped nor shrunk to fit — one that does not fit
   * is REJECTED, with the measured width and the room available. Check a
   * candidate with {@link measureLabelCaption} before committing to it.
   */
  readonly text: string;
}

/**
 * Parameters for {@link measureLabelCaption}.
 */
export interface MeasureLabelCaptionParams {
  /**
   * Height of the image the caption is destined for, in pixels.
   */
  readonly imageHeightInPixels: number;

  /**
   * Width of the image the caption is destined for, in pixels.
   */
  readonly imageWidthInPixels: number;

  /**
   * The caption to measure.
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
 * swallow that row whole (120px on a 900x1600 phone), and is inert on a wide frame where the caption-derived
 * height is already the larger of the two.
 */
const MINIMUM_HEIGHT_RATIO = 0.075;

/**
 * Margin held clear at EACH end of the caption, as a fraction of image width.
 *
 * A caption that ends a pixel inside the frame is legally un-clipped and still
 * looks wrong, so the room a caption is measured against is the frame less this
 * at both ends — 48px each side on a 1200px frame.
 */
const SIDE_MARGIN_RATIO = 0.04;

/**
 * Divisor that turns a span into its midpoint, for centering the caption.
 */
const CENTER_DIVISOR = 2;

/**
 * The caption's typeface and weight, in one place because the band and the
 * measurement canvas MUST draw with the same ones: a measurement taken in a
 * different face is not a measurement of the thing that ships.
 */
const FONT_FAMILY = 'Segoe UI, Helvetica, Arial, sans-serif';

const FONT_WEIGHT = '600';

const CAPTION_FILL = '#ffffff';

/**
 * Upper bound on one glyph's advance width, as a multiple of the font size.
 *
 * It sizes the off-screen canvas the caption is measured on, and it only ever
 * needs to be an over-estimate: a canvas too narrow would clip the text being
 * measured, under-report its width, and reintroduce the exact silent clipping
 * the measurement exists to catch. No Latin glyph in a proportional sans
 * advances a full em — an em dash, the widest, is 1.0 — so 1.1 is headroom at
 * negligible cost (measured prose runs about 0.45 em per character, so the
 * canvas comes out roughly 2.5x the text).
 */
const MAXIMUM_GLYPH_ADVANCE_RATIO = 1.1;

/**
 * Height of the measurement canvas as a multiple of the font size, so ascenders
 * and descenders have room and the trim reads the glyphs rather than the edge.
 */
const MEASUREMENT_CANVAS_HEIGHT_RATIO = 3;

/**
 * How far a pixel may differ from the transparent surround before `trim` counts
 * it as text. Deliberately far lower than `sharp`'s default of 10: the outermost
 * pixels of an antialiased glyph are very faint, and the default discards them,
 * under-measuring a caption by a pixel or two at each end.
 */
const TRIM_THRESHOLD = 1;

/**
 * Parameters for {@link buildCaptionTextElement}.
 */
interface CaptionTextElementParams {
  readonly fontSizeInPixels: number;
  readonly text: string;
  readonly textAnchor: 'middle' | 'start';
  readonly xInPixels: number;
  readonly yInPixels: number;
}

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
  const captionElement = buildCaptionTextElement({
    fontSizeInPixels,
    text,
    textAnchor: 'middle',
    xInPixels: imageWidthInPixels / CENTER_DIVISOR,
    yInPixels: heightInPixels / CENTER_DIVISOR
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(imageWidthInPixels)}" height="${String(heightInPixels)}">`
    + `<rect x="0" y="0" width="${String(imageWidthInPixels)}" height="${String(heightInPixels)}" `
    + `fill="#000000" fill-opacity="${String(BAND_OPACITY)}"/>`
    + `${captionElement}</svg>`;
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
  const sideMarginInPixels = Math.round(imageWidthInPixels * SIDE_MARGIN_RATIO);

  return {
    captionRoomInPixels: imageWidthInPixels - (sideMarginInPixels * CENTER_DIVISOR),
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
 * @throws Error if `sharp` is not installed, the image dimensions cannot be read, or the caption is too wide for the frame.
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
  const textWidthInPixels = await measureCaptionWidth(options.text, geometry.fontSizeInPixels);

  if (textWidthInPixels > geometry.captionRoomInPixels) {
    const overflowInPixels = textWidthInPixels - geometry.captionRoomInPixels;
    throw new Error(
      `labelScreenshot: the caption is ${String(overflowInPixels)}px too wide for the frame. `
        + `It renders ${String(textWidthInPixels)}px at font-size ${String(geometry.fontSizeInPixels)}, and a `
        + `${String(imageWidthInPixels)}px frame has room for ${String(geometry.captionRoomInPixels)}px. `
        + 'Shorten it: a caption that does not fit is clipped at BOTH ends, with no ellipsis to show it happened. '
        + `Caption: ${JSON.stringify(options.text)}`
    );
  }

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

/**
 * Measures a caption against the frame it is destined for, without drawing
 * anything.
 *
 * This is what {@link labelScreenshot} rejects an overlong caption with, exposed
 * so a caption can be chosen with the number in hand instead of by capturing a
 * frame and looking at it.
 *
 * @param params - The caption and the dimensions of the image it is for.
 * @returns A {@link Promise} that resolves to the measurement.
 * @throws Error if `sharp` is not installed, or either dimension is not a positive number.
 */
export async function measureLabelCaption(params: MeasureLabelCaptionParams): Promise<LabelCaptionMeasurement> {
  const { imageHeightInPixels, imageWidthInPixels, text } = params;
  const geometry = computeLabelBand({ imageHeightInPixels, imageWidthInPixels });
  const textWidthInPixels = await measureCaptionWidth(text, geometry.fontSizeInPixels);

  return {
    captionRoomInPixels: geometry.captionRoomInPixels,
    doesFit: textWidthInPixels <= geometry.captionRoomInPixels,
    textWidthInPixels
  };
}

/**
 * Builds the caption's SVG `<text>` element.
 *
 * Both the band and the measurement canvas go through here, so the thing that
 * is measured is drawn with the same face, weight and size as the thing that
 * ships. Two hand-written copies would be free to drift, and a measurement that
 * has drifted from the drawing is worse than no measurement at all.
 *
 * @param params - The caption, its size, and where to anchor it.
 * @returns The `<text>` markup.
 */
function buildCaptionTextElement(params: CaptionTextElementParams): string {
  const { fontSizeInPixels, text, textAnchor, xInPixels, yInPixels } = params;

  return `<text x="${String(xInPixels)}" y="${String(yInPixels)}" `
    + `font-family="${FONT_FAMILY}" font-size="${String(fontSizeInPixels)}" `
    + `font-weight="${FONT_WEIGHT}" fill="${CAPTION_FILL}" text-anchor="${textAnchor}" dominant-baseline="central">`
    + `${escapeSvgText(text)}</text>`;
}

/**
 * Measures how wide a caption renders at a given size.
 *
 * The text is drawn alone on a transparent canvas deliberately wider than it can
 * possibly need, then `trim`med back to its own ink — the same measurement that
 * was previously done by hand, once, per caption, by whoever thought to doubt
 * one. The renderer doing the measuring is the renderer that draws the band, so
 * the two cannot disagree about a font the host does or does not have.
 *
 * @param text - The caption.
 * @param fontSizeInPixels - The size the band would draw it at.
 * @returns A {@link Promise} that resolves to the rendered width in pixels.
 */
async function measureCaptionWidth(text: string, fontSizeInPixels: number): Promise<number> {
  // A caption with no ink leaves the canvas uniformly transparent, and `trim`
  // returns such an image untouched — i.e. reports the whole canvas as text.
  if (text.trim() === '') {
    return 0;
  }

  const sharp = await importSharp('measureLabelCaption');
  const paddingInPixels = fontSizeInPixels * CENTER_DIVISOR;
  const canvasWidthInPixels = Math.ceil(fontSizeInPixels * MAXIMUM_GLYPH_ADVANCE_RATIO * text.length) + paddingInPixels;
  const canvasHeightInPixels = Math.ceil(fontSizeInPixels * MEASUREMENT_CANVAS_HEIGHT_RATIO);
  const captionElement = buildCaptionTextElement({
    fontSizeInPixels,
    text,
    textAnchor: 'start',
    xInPixels: fontSizeInPixels,
    yInPixels: canvasHeightInPixels / CENTER_DIVISOR
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(canvasWidthInPixels)}" height="${String(canvasHeightInPixels)}">`
    + `${captionElement}</svg>`;

  const trimmed = await sharp(new Uint8Array(Buffer.from(svg)))
    .trim({ threshold: TRIM_THRESHOLD })
    .png()
    .toBuffer();

  return readPngDimensions(new Uint8Array(trimmed)).widthInPixels;
}
