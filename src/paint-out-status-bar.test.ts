import {
  describe,
  expect,
  it
} from 'vitest';

import { readPngDimensions } from './capture-screenshot.ts';
import {
  buildStatusBarBandFailureMessage,
  DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS,
  DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS,
  paintOutStatusBar,
  resolveStatusBarBand
} from './paint-out-status-bar.ts';

/**
 * The AVD the recipe was measured on: 900x1600, density 320, so a 24dp status
 * bar is 48 framebuffer pixels tall.
 */
const FRAME_WIDTH_IN_PIXELS = 900;
const FRAME_HEIGHT_IN_PIXELS = 1600;
const STATUS_BAR_HEIGHT_IN_PIXELS = 48;

/**
 * The frame's background, and the bar's own content drawn over it — a clock at
 * the left, an icon group at the right, of the kind whose offset moves between
 * emulator boots.
 */
const BACKGROUND = { b: 32, g: 30, r: 30 };
const CHROME = { b: 250, g: 250, r: 250 };
const APP = { b: 90, g: 160, r: 220 };

/**
 * How tall the bar's own content is, leaving the rows beneath it empty — which
 * is what the sample row is read from.
 */
const CHROME_HEIGHT_IN_PIXELS = 30;

const CHANNELS_WITHOUT_ALPHA = 3;

describe('resolveStatusBarBand', () => {
  it('should read the row under the bar and report it flat', () => {
    const verdict = resolveStatusBarBand(buildRawFrameParams({ shouldDrawAppAcrossTheBand: false }));

    expect(verdict.isClear).toBe(true);
    expect(verdict.distinctColorCount).toBe(1);
    expect(verdict.backgroundColor).toStrictEqual(BACKGROUND);
    expect(verdict.firstDifferentColor).toBeNull();
    expect(verdict.firstDifferentColumnXInPixels).toBeNull();
  });

  it('should read the row the inset names, so the bar\'s own content is never what is sampled', () => {
    const verdict = resolveStatusBarBand(buildRawFrameParams({ shouldDrawAppAcrossTheBand: false }));

    expect(verdict.sampleRowYInPixels).toBe(STATUS_BAR_HEIGHT_IN_PIXELS - DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS);
    // The bar's content is 30px tall, so the default inset lands well clear of it.
    expect(verdict.sampleRowYInPixels).toBeGreaterThan(CHROME_HEIGHT_IN_PIXELS);
  });

  it('should refuse a band the app draws inside, naming the column that gave it away', () => {
    // What a status bar that has grown taller than the measured band looks like:
    // the app's own pixels are now sitting in the row the fill would be read from.
    const verdict = resolveStatusBarBand(buildRawFrameParams({ shouldDrawAppAcrossTheBand: true }));

    expect(verdict.isClear).toBe(false);
    expect(verdict.distinctColorCount).toBe(2);
    expect(verdict.firstDifferentColor).toStrictEqual(APP);
    expect(verdict.firstDifferentColumnXInPixels).toBe(APP_COLUMN_X_IN_PIXELS);
  });

  it('should ignore the rounded corners, which darken both ends of every row constantly', () => {
    const params = buildRawFrameParams({ shouldDrawAppAcrossTheBand: false });
    const sampleRowY = STATUS_BAR_HEIGHT_IN_PIXELS - DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS;
    const pixels = Uint8Array.from(params.pixels);
    paintRow(pixels, {
      color: CHROME,
      fromXInPixels: 0,
      toXInPixels: DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS,
      yInPixels: sampleRowY
    });
    paintRow(pixels, {
      color: CHROME,
      fromXInPixels: FRAME_WIDTH_IN_PIXELS - DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS,
      toXInPixels: FRAME_WIDTH_IN_PIXELS,
      yInPixels: sampleRowY
    });

    expect(resolveStatusBarBand({ ...params, pixels }).isClear).toBe(true);
  });

  it('should refuse a margin that leaves a check which cannot fail', () => {
    const params = buildRawFrameParams({ shouldDrawAppAcrossTheBand: true });

    expect(() => resolveStatusBarBand({ ...params, edgeMarginInPixels: FRAME_WIDTH_IN_PIXELS / 2 }))
      .toThrow('which is a check that cannot fail');
  });

  it('should refuse a sample inset that puts the row above the top of the frame', () => {
    const params = buildRawFrameParams({ shouldDrawAppAcrossTheBand: false });

    expect(() => resolveStatusBarBand({ ...params, sampleInsetInPixels: STATUS_BAR_HEIGHT_IN_PIXELS + 1 }))
      .toThrow('puts the sample row above the top of the frame');
  });

  it('should refuse a non-positive dimension', () => {
    const params = buildRawFrameParams({ shouldDrawAppAcrossTheBand: false });

    expect(() => resolveStatusBarBand({ ...params, heightInPixels: 0 }))
      .toThrow('heightInPixels must be a positive number, got 0.');
    expect(() => resolveStatusBarBand({ ...params, widthInPixels: -1 }))
      .toThrow('widthInPixels must be a positive number, got -1.');
  });

  it('should refuse a buffer too short for the row it was asked to read', () => {
    const params = buildRawFrameParams({ shouldDrawAppAcrossTheBand: false });

    expect(() => resolveStatusBarBand({ ...params, pixels: params.pixels.slice(0, 100) }))
      .toThrow(/the frame holds 100 bytes, too few for row y44/);
  });
});

describe('buildStatusBarBandFailureMessage', () => {
  it('should name the band, the row, the scan and both colors', () => {
    const verdict = resolveStatusBarBand(buildRawFrameParams({ shouldDrawAppAcrossTheBand: true }));
    const message = buildStatusBarBandFailureMessage({
      edgeMarginInPixels: DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS,
      heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS,
      verdict,
      widthInPixels: FRAME_WIDTH_IN_PIXELS
    });

    expect(message).toContain('band=48px sampleRow=y44 scanned x100..800 of 900px distinctColors=2');
    expect(message).toContain('sampled rgb(30,30,32), but x=300 is rgb(220,160,90)');
    // The way out is to measure, and saying so is the point of the message: the
    // obvious move on a failure is to enlarge the band until it passes, which is
    // exactly how a capture starts painting over the product.
    expect(message).toContain('Measure the band on a fresh frame');
  });

  it('should say there was no differing column when handed a clear verdict', () => {
    // Not a case the throw path reaches, and worth having anyway: the message is
    // exported so a caller can print a verdict it read for itself, and printing
    // `undefined` at a reader is how a diagnostic stops being one.
    const verdict = resolveStatusBarBand(buildRawFrameParams({ shouldDrawAppAcrossTheBand: false }));
    const message = buildStatusBarBandFailureMessage({
      edgeMarginInPixels: DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS,
      heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS,
      verdict,
      widthInPixels: FRAME_WIDTH_IN_PIXELS
    });

    expect(message).toContain('but x=null is (none)');
  });
});

describe('paintOutStatusBar', () => {
  it('should fill the band with the color behind it, leaving the frame the same size', async () => {
    const frame = await buildFramePng({ shouldDrawAppAcrossTheBand: false });
    const painted = await paintOutStatusBar(frame, { heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS });

    expect(readPngDimensions(painted)).toStrictEqual({
      heightInPixels: FRAME_HEIGHT_IN_PIXELS,
      widthInPixels: FRAME_WIDTH_IN_PIXELS
    });

    const { data, info } = await readRaw(painted);

    // Every row of the band is now the background, including the rows the clock
    // and the icon group were drawn on — which is the whole point: those are the
    // pixels two runs disagree on.
    for (let y = 0; y < STATUS_BAR_HEIGHT_IN_PIXELS; y++) {
      expect({ y, ...colorAt(data, info, 0, y) }).toStrictEqual({ y, ...BACKGROUND });
      expect({ y, ...colorAt(data, info, FRAME_WIDTH_IN_PIXELS - 1, y) }).toStrictEqual({ y, ...BACKGROUND });
    }
  });

  it('should leave everything below the band untouched', async () => {
    const frame = await buildFramePng({ shouldDrawAppAcrossTheBand: false });
    const painted = await paintOutStatusBar(frame, { heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS });
    const { data, info } = await readRaw(painted);

    expect(colorAt(data, info, 0, STATUS_BAR_HEIGHT_IN_PIXELS)).toStrictEqual(APP);
    expect(colorAt(data, info, FRAME_WIDTH_IN_PIXELS - 1, FRAME_HEIGHT_IN_PIXELS - 1)).toStrictEqual(APP);
  });

  it('should be idempotent, so a frame painted twice is the same frame', async () => {
    // The check reads a row that the first pass fills with the color it sampled,
    // so a second pass has to keep finding a clear band rather than refusing one.
    const frame = await buildFramePng({ shouldDrawAppAcrossTheBand: false });
    const once = await paintOutStatusBar(frame, { heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS });
    const twice = await paintOutStatusBar(once, { heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS });

    expect(Buffer.from(twice)).toStrictEqual(Buffer.from(once));
  });

  it('should read the sample row the caller names, so a band whose content runs deeper still passes', async () => {
    // A bar whose own content reaches further down than the default inset allows
    // for: the row four pixels up is drawn on, and the caller says where the
    // empty rows really are rather than re-measuring the band.
    const frame = await buildFramePng({ shouldDrawAppAcrossTheBand: false, shouldFillTheDefaultSampleRow: true });

    await expect(paintOutStatusBar(frame, { heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS }))
      .rejects.toThrow('holds more than one color');

    const painted = await paintOutStatusBar(frame, {
      heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS,
      sampleInsetInPixels: 1
    });

    expect(readPngDimensions(painted)).toStrictEqual({
      heightInPixels: FRAME_HEIGHT_IN_PIXELS,
      widthInPixels: FRAME_WIDTH_IN_PIXELS
    });
  });

  it('should refuse a band the app draws inside rather than painting over the product', async () => {
    const frame = await buildFramePng({ shouldDrawAppAcrossTheBand: true });

    await expect(paintOutStatusBar(frame, { heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS }))
      .rejects.toThrow('paintOutStatusBar: the row under the status bar holds more than one color');
  });

  it('should refuse a band as tall as the frame, which is a measurement of some other device', async () => {
    const frame = await buildFramePng({ shouldDrawAppAcrossTheBand: false });

    await expect(paintOutStatusBar(frame, { heightInPixels: FRAME_HEIGHT_IN_PIXELS }))
      .rejects.toThrow('would cover a frame that is only 1600px tall');
  });

  it('should honour an edge margin wide enough to clear what the app draws', async () => {
    // The same frame the check refuses at the default margin: a margin that
    // reaches past the app's own pixels makes it a band of device chrome again.
    const frame = await buildFramePng({ shouldDrawAppAcrossTheBand: true });
    const painted = await paintOutStatusBar(frame, {
      edgeMarginInPixels: APP_COLUMN_X_IN_PIXELS + APP_COLUMN_WIDTH_IN_PIXELS,
      heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS
    });

    expect(readPngDimensions(painted)).toStrictEqual({
      heightInPixels: FRAME_HEIGHT_IN_PIXELS,
      widthInPixels: FRAME_WIDTH_IN_PIXELS
    });
  });
});

/**
 * Where the app's own pixels are drawn when a case wants a band that is not clear.
 */
const APP_COLUMN_X_IN_PIXELS = 300;

const APP_COLUMN_WIDTH_IN_PIXELS = 120;

/**
 * Parameters for {@link buildRawFrame}.
 */
interface BuildFrameParams {
  /**
   * Whether the app draws across the sample row — what a status bar taller than the measured band, or an
   * Obsidian that draws higher, looks like from here.
   */
  readonly shouldDrawAppAcrossTheBand: boolean;

  /**
   * Whether the bar's own content reaches down into the row the DEFAULT inset reads — a bar whose empty
   * rows are fewer than four, which is what the inset exists to be moved for.
   */
  readonly shouldFillTheDefaultSampleRow?: boolean;
}

/**
 * A color, as the module under test reports and takes one.
 */
interface FrameColor {
  readonly b: number;
  readonly g: number;
  readonly r: number;
}

/**
 * The geometry raw pixels are read with.
 */
interface FrameGeometry {
  readonly channels: number;
  readonly width: number;
}

/**
 * Parameters for {@link paintRow}.
 */
interface PaintRowParams {
  readonly color: FrameColor;
  readonly fromXInPixels: number;
  readonly toXInPixels: number;
  readonly yInPixels: number;
}

/**
 * A decoded frame: its pixels, and what they have to be read with.
 */
interface RawFrame {
  readonly data: Uint8Array;
  readonly info: FrameGeometry;
}

/**
 * The parameters a raw-pixel read is made with, ready to spread and override.
 */
interface RawFrameParams {
  readonly channelCount: number;
  readonly heightInPixels: number;
  readonly pixels: Uint8Array;
  readonly widthInPixels: number;
}

/**
 * Encodes {@link buildRawFrame}'s output as the PNG a device capture returns.
 *
 * @param params - Whether the app should reach into the band.
 * @returns A {@link Promise} that resolves to the PNG bytes.
 */
async function buildFramePng(params: BuildFrameParams): Promise<Uint8Array> {
  const sharpModule = await importSharpForTest();
  const buffer = await sharpModule.default(buildRawFrame(params), {
    raw: {
      channels: CHANNELS_WITHOUT_ALPHA,
      height: FRAME_HEIGHT_IN_PIXELS,
      width: FRAME_WIDTH_IN_PIXELS
    }
  })
    .png()
    .toBuffer();

  return new Uint8Array(buffer);
}

/**
 * Builds a stand-in for a device frame: a background, a status bar drawn over its top rows, and an app
 * below it.
 *
 * Raw rather than encoded, because the checks read raw pixels and an encoder in
 * the middle would make every assertion a statement about PNG as well.
 *
 * @param params - Whether the app should reach into the band.
 * @returns The frame's raw RGB bytes.
 */
function buildRawFrame(params: BuildFrameParams): Uint8Array {
  const pixels = new Uint8Array(FRAME_WIDTH_IN_PIXELS * FRAME_HEIGHT_IN_PIXELS * CHANNELS_WITHOUT_ALPHA);

  for (let y = 0; y < FRAME_HEIGHT_IN_PIXELS; y++) {
    const isInsideBand = y < STATUS_BAR_HEIGHT_IN_PIXELS;
    paintRow(pixels, {
      color: isInsideBand ? BACKGROUND : APP,
      fromXInPixels: 0,
      toXInPixels: FRAME_WIDTH_IN_PIXELS,
      yInPixels: y
    });
  }

  // The bar's own content: a clock at the left and an icon group at the right,
  // both stopping short of the band's bottom rows.
  for (let y = 8; y < CHROME_HEIGHT_IN_PIXELS; y++) {
    paintRow(pixels, { color: CHROME, fromXInPixels: 20, toXInPixels: 120, yInPixels: y });
    paintRow(pixels, {
      color: CHROME,
      fromXInPixels: FRAME_WIDTH_IN_PIXELS - 160,
      toXInPixels: FRAME_WIDTH_IN_PIXELS - 20,
      yInPixels: y
    });
  }

  if (params.shouldFillTheDefaultSampleRow) {
    paintRow(pixels, {
      color: CHROME,
      fromXInPixels: 20,
      toXInPixels: 120,
      yInPixels: STATUS_BAR_HEIGHT_IN_PIXELS - DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS
    });
  }

  if (params.shouldDrawAppAcrossTheBand) {
    for (let y = 0; y < STATUS_BAR_HEIGHT_IN_PIXELS; y++) {
      paintRow(pixels, {
        color: APP,
        fromXInPixels: APP_COLUMN_X_IN_PIXELS,
        toXInPixels: APP_COLUMN_X_IN_PIXELS + APP_COLUMN_WIDTH_IN_PIXELS,
        yInPixels: y
      });
    }
  }

  return pixels;
}

/**
 * Builds the parameters a raw-pixel check is made with, for the frame a case wants.
 *
 * @param params - Whether the app should reach into the band.
 * @returns The parameters, ready to spread and override.
 */
function buildRawFrameParams(params: BuildFrameParams): RawFrameParams {
  return {
    channelCount: CHANNELS_WITHOUT_ALPHA,
    heightInPixels: STATUS_BAR_HEIGHT_IN_PIXELS,
    pixels: buildRawFrame(params),
    widthInPixels: FRAME_WIDTH_IN_PIXELS
  };
}

/**
 * Reads one pixel out of a raw frame.
 *
 * @param data - The raw bytes.
 * @param info - The geometry they are to be read with.
 * @param xInPixels - The column.
 * @param yInPixels - The row.
 * @returns The color at that pixel.
 */
function colorAt(data: Uint8Array, info: FrameGeometry, xInPixels: number, yInPixels: number): FrameColor {
  const offset = (yInPixels * info.width + xInPixels) * info.channels;

  return {
    b: data[offset + 2] ?? 0,
    g: data[offset + 1] ?? 0,
    r: data[offset] ?? 0
  };
}

/**
 * Loads `sharp` for the test's own image fixtures and pixel reads.
 *
 * @returns A {@link Promise} that resolves to the `sharp` module.
 */
async function importSharpForTest(): Promise<typeof import('sharp')> {
  // eslint-disable-next-line no-restricted-syntax -- Mirrors the lazy load in the module under test, where `sharp` is an optional peer.
  return import('sharp');
}

/**
 * Paints a horizontal run of one color into a raw frame.
 *
 * @param pixels - The frame to paint into.
 * @param params - The color, the row, and the columns it spans.
 */
function paintRow(pixels: Uint8Array, params: PaintRowParams): void {
  const {
    color,
    fromXInPixels,
    toXInPixels,
    yInPixels
  } = params;

  for (let x = fromXInPixels; x < toXInPixels; x++) {
    const offset = (yInPixels * FRAME_WIDTH_IN_PIXELS + x) * CHANNELS_WITHOUT_ALPHA;
    pixels[offset] = color.r;
    pixels[offset + 1] = color.g;
    pixels[offset + 2] = color.b;
  }
}

/**
 * Decodes a PNG back to raw pixels, so an assertion can be made about what was painted.
 *
 * @param bytes - The PNG.
 * @returns A {@link Promise} that resolves to the pixels and their geometry.
 */
async function readRaw(bytes: Uint8Array): Promise<RawFrame> {
  const sharpModule = await importSharpForTest();
  const { data, info } = await sharpModule.default(bytes).raw().toBuffer({ resolveWithObject: true });

  return { data: new Uint8Array(data), info: { channels: info.channels, width: info.width } };
}
