/**
 * @file
 *
 * Fits a screenshot onto a canvas of a different aspect ratio without cropping
 * it or distorting it, filling the leftover margins with a blurred, enlarged
 * copy of the same image (the "pillarbox" treatment used by store listings).
 *
 * The motivating case is a mobile store screenshot. The Android emulator's
 * framebuffer is whatever the AVD's screen is — a Pixel 10 Pro XL is 1344x2992,
 * roughly 9:20 — while the community store asks for 900x1600 (9:16). Cropping
 * to 9:16 throws away a fifth of the frame, and stretching distorts the UI, so
 * the image is scaled to fit the HEIGHT and the two side margins are filled.
 *
 * The geometry is a pure function so it can be unit-tested; the pixel work needs
 * `sharp`, which is an OPTIONAL peer dependency — declared rather than bundled
 * because only screenshot capture needs it, and it ships platform-specific
 * native binaries that every other consumer would pay for.
 */

/**
 * Parameters for {@link computeFitToCanvas}.
 */
export interface ComputeFitToCanvasParams {
  /**
   * Height of the target canvas, in pixels.
   */
  readonly canvasHeightInPixels: number;

  /**
   * Width of the target canvas, in pixels.
   */
  readonly canvasWidthInPixels: number;

  /**
   * Height of the source image, in pixels.
   */
  readonly sourceHeightInPixels: number;

  /**
   * Width of the source image, in pixels.
   */
  readonly sourceWidthInPixels: number;
}

/**
 * Options for {@link fitScreenshotToCanvas}.
 */
export interface FitScreenshotToCanvasOptions {
  /**
   * Gaussian blur strength applied to the margin fill.
   *
   * @default `24`
   */
  readonly blurSigma?: number;

  /**
   * Height of the target canvas, in pixels.
   */
  readonly canvasHeightInPixels: number;

  /**
   * Width of the target canvas, in pixels.
   */
  readonly canvasWidthInPixels: number;
}

/**
 * Where the scaled source image sits on the canvas.
 */
export interface FitToCanvasGeometry {
  /**
   * Width of each side margin, in pixels. Both sides are equal by construction.
   */
  readonly marginInPixels: number;

  /**
   * Left offset of the scaled image on the canvas, in pixels.
   */
  readonly offsetXInPixels: number;

  /**
   * Top offset of the scaled image on the canvas, in pixels.
   */
  readonly offsetYInPixels: number;

  /**
   * Height the source is scaled to, in pixels.
   */
  readonly scaledHeightInPixels: number;

  /**
   * Width the source is scaled to, in pixels.
   */
  readonly scaledWidthInPixels: number;
}

/**
 * A layer passed to `sharp`'s `composite`.
 */
interface SharpCompositeLayer {
  readonly input: Buffer;
  readonly left: number;
  readonly top: number;
}

/**
 * The `sharp` entry point this module uses, described structurally so the module
 * type-checks against the optional peer rather than depending on its types.
 */
type SharpFactory = (input: Uint8Array) => SharpInstance;

/**
 * One `sharp` pipeline.
 */
interface SharpInstance {
  blur(this: void, sigma: number): SharpInstance;
  composite(this: void, layers: SharpCompositeLayer[]): SharpInstance;
  metadata(this: void): Promise<SharpMetadata>;
  png(this: void): SharpInstance;
  resize(this: void, width: number, height: number, options?: SharpResizeOptions): SharpInstance;
  toBuffer(this: void): Promise<Buffer>;
}

/**
 * The subset of `sharp`'s metadata this module reads.
 */
interface SharpMetadata {
  readonly height?: number | undefined;
  readonly width?: number | undefined;
}

/**
 * The subset of `sharp`'s resize options this module sets.
 */
interface SharpResizeOptions {
  readonly fit: 'cover' | 'fill';
}

/**
 * Default Gaussian blur strength for the margin fill: soft enough that no
 * detail reads as content, gentle enough to keep the frame's colors.
 */
const DEFAULT_BLUR_SIGMA = 24;

/**
 * The number of side margins the leftover width is split between.
 */
const MARGIN_SIDES = 2;

/**
 * Computes how a source image is scaled and placed to fill a canvas's height,
 * with equal margins on the left and right.
 *
 * The scaled width is rounded to the nearest integer that leaves an EVEN
 * remainder, so the two margins are exactly equal — an asymmetric pillarbox is
 * visible at a glance and looks like a mistake. Where both neighbors qualify,
 * the one closer to the true scaled width wins, so the aspect error stays below
 * one part in a thousand.
 *
 * Worked example, the mobile store case: a 1344x2992 frame onto a 900x1600
 * canvas scales by `1600/2992` to 718.72 wide. 719 would leave a 181px
 * remainder, which cannot split evenly, so 718 is chosen (margin 91) over 720
 * (margin 90) because 718 is nearer 718.72.
 *
 * @param params - The source and canvas dimensions.
 * @returns The scaled size, the offsets, and the side margin.
 * @throws Error if any dimension is not a positive number.
 */
export function computeFitToCanvas(params: ComputeFitToCanvasParams): FitToCanvasGeometry {
  const {
    canvasHeightInPixels,
    canvasWidthInPixels,
    sourceHeightInPixels,
    sourceWidthInPixels
  } = params;

  const namedDimensions: [string, number][] = [
    ['canvasHeightInPixels', canvasHeightInPixels],
    ['canvasWidthInPixels', canvasWidthInPixels],
    ['sourceHeightInPixels', sourceHeightInPixels],
    ['sourceWidthInPixels', sourceWidthInPixels]
  ];

  for (const [name, value] of namedDimensions) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`computeFitToCanvas: ${name} must be a positive number, got ${String(value)}.`);
    }
  }

  const scaledHeightInPixels = canvasHeightInPixels;
  const exactScaledWidth = sourceWidthInPixels * (canvasHeightInPixels / sourceHeightInPixels);
  const scaledWidthInPixels = roundToMatchingParity(exactScaledWidth, canvasWidthInPixels);

  if (scaledWidthInPixels > canvasWidthInPixels) {
    throw new Error(
      'computeFitToCanvas: the source is wider than the canvas once scaled to its height '
        + `(${String(scaledWidthInPixels)} > ${String(canvasWidthInPixels)}); this fits by height and cannot letterbox.`
    );
  }

  const marginInPixels = (canvasWidthInPixels - scaledWidthInPixels) / MARGIN_SIDES;

  return {
    marginInPixels,
    offsetXInPixels: marginInPixels,
    offsetYInPixels: 0,
    scaledHeightInPixels,
    scaledWidthInPixels
  };
}

/**
 * Scales a screenshot to fill a canvas's height and fills the side margins with
 * a blurred, enlarged copy of the same image.
 *
 * Nothing is cropped and nothing is stretched: the visible screenshot keeps its
 * aspect ratio to within a rounding pixel, and the margins are made of the
 * image itself rather than a flat color, so the result reads as one frame.
 *
 * @param bytes - The source PNG.
 * @param options - The target canvas size and blur strength.
 * @returns A {@link Promise} that resolves to the composed PNG, exactly the canvas size.
 * @throws Error if `sharp` is not installed, or the source dimensions cannot be read.
 */
export async function fitScreenshotToCanvas(bytes: Uint8Array, options: FitScreenshotToCanvasOptions): Promise<Uint8Array> {
  const {
    blurSigma = DEFAULT_BLUR_SIGMA,
    canvasHeightInPixels,
    canvasWidthInPixels
  } = options;

  const sharp = await importSharp();
  const metadata = await sharp(bytes).metadata();
  const sourceWidthInPixels = metadata.width;
  const sourceHeightInPixels = metadata.height;

  /* v8 ignore next 3 -- Defensive: `sharp` rejects a non-image before it can report metadata without dimensions, so this branch is unreachable from a test. */
  if (sourceWidthInPixels === undefined || sourceHeightInPixels === undefined) {
    throw new Error('fitScreenshotToCanvas: could not read the source image dimensions.');
  }

  const geometry = computeFitToCanvas({
    canvasHeightInPixels,
    canvasWidthInPixels,
    sourceHeightInPixels,
    sourceWidthInPixels
  });

  // The background is the same frame blown up to COVER the canvas and blurred,
  // So the margins carry the screenshot's own colors instead of a flat bar.
  const background = await sharp(bytes)
    .resize(canvasWidthInPixels, canvasHeightInPixels, { fit: 'cover' })
    .blur(blurSigma)
    .toBuffer();

  const foreground = await sharp(bytes)
    .resize(geometry.scaledWidthInPixels, geometry.scaledHeightInPixels, { fit: 'fill' })
    .toBuffer();

  const composed = await sharp(background)
    .composite([{
      input: foreground,
      left: geometry.offsetXInPixels,
      top: geometry.offsetYInPixels
    }])
    .png()
    .toBuffer();

  return new Uint8Array(composed);
}

/**
 * Loads `sharp` on demand, so importing this module does not require it.
 *
 * @returns A {@link Promise} that resolves to the `sharp` factory.
 * @throws Error naming the missing optional peer dependency.
 */
async function importSharp(): Promise<SharpFactory> {
  try {
    // eslint-disable-next-line no-restricted-syntax -- `sharp` is an OPTIONAL peer, so it must be loaded lazily: a static import would drag its native binaries into every consumer of this package's index.
    const sharpModule = await import('sharp');
    const factory: unknown = sharpModule.default;
    return factory as SharpFactory;
  } catch (error: unknown) {
    /* v8 ignore start -- Reached only when the optional peer is absent, which it never is in this package's own test run. */
    throw new Error(
      'fitScreenshotToCanvas needs the optional peer dependency "sharp". '
        + 'Install it in the consuming project (npm i -D sharp).',
      { cause: error }
    );
    /* v8 ignore stop */
  }
}

/**
 * Rounds a width to the nearest integer sharing `target`'s parity, so
 * `target - result` is even and splits into two equal margins.
 *
 * @param value - The exact scaled width.
 * @param target - The canvas width whose parity must be matched.
 * @returns The nearest integer of the same parity as `target`.
 */
function roundToMatchingParity(value: number, target: number): number {
  const rounded = Math.round(value);
  if ((target - rounded) % MARGIN_SIDES === 0) {
    return rounded;
  }

  // `rounded` leaves an odd remainder, so step to whichever neighbor is closer
  // To the true value; both have the parity `rounded` lacks.
  return value >= rounded ? rounded + 1 : rounded - 1;
}
