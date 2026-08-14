import {
  describe,
  expect,
  it
} from 'vitest';

import { readPngDimensions } from './capture-screenshot.ts';
import {
  computeFitToCanvas,
  fitScreenshotToCanvas
} from './fit-screenshot.ts';

/**
 * The mobile store case: a Pixel 10 Pro XL framebuffer onto the community
 * store's recommended mobile size.
 */
const PIXEL_10_PRO_XL = { sourceHeightInPixels: 2992, sourceWidthInPixels: 1344 };
const STORE_MOBILE_CANVAS = { canvasHeightInPixels: 1600, canvasWidthInPixels: 900 };

/**
 * The number of side margins the leftover width is split between.
 */
const MARGIN_SIDES = 2;

describe('computeFitToCanvas', () => {
  it('should fill the canvas height exactly', () => {
    const geometry = computeFitToCanvas({ ...PIXEL_10_PRO_XL, ...STORE_MOBILE_CANVAS });
    expect(geometry.scaledHeightInPixels).toBe(1600);
    expect(geometry.offsetYInPixels).toBe(0);
  });

  it('should scale 1344x2992 to 718 wide, the nearest width that splits evenly', () => {
    // 1344 * (1600 / 2992) = 718.716..., and 719 would leave a 181px remainder
    // That cannot halve. 718 is nearer the true width than 720.
    const geometry = computeFitToCanvas({ ...PIXEL_10_PRO_XL, ...STORE_MOBILE_CANVAS });
    expect(geometry.scaledWidthInPixels).toBe(718);
  });

  it('should leave equal 91px margins on both sides', () => {
    const geometry = computeFitToCanvas({ ...PIXEL_10_PRO_XL, ...STORE_MOBILE_CANVAS });
    expect(geometry.marginInPixels).toBe(91);
    expect(geometry.offsetXInPixels).toBe(91);
    expect(geometry.offsetXInPixels * MARGIN_SIDES + geometry.scaledWidthInPixels).toBe(900);
  });

  it('should keep the aspect error under one part in a thousand', () => {
    const geometry = computeFitToCanvas({ ...PIXEL_10_PRO_XL, ...STORE_MOBILE_CANVAS });
    const sourceAspect = PIXEL_10_PRO_XL.sourceWidthInPixels / PIXEL_10_PRO_XL.sourceHeightInPixels;
    const scaledAspect = geometry.scaledWidthInPixels / geometry.scaledHeightInPixels;
    expect(Math.abs(scaledAspect - sourceAspect) / sourceAspect).toBeLessThan(0.001);
  });

  it('should always produce an even remainder, so the margins can be equal', () => {
    // Sweep a range of source widths: every one must split evenly, which is the
    // Property an asymmetric pillarbox would violate.
    for (let sourceWidthInPixels = 600; sourceWidthInPixels <= 1400; sourceWidthInPixels++) {
      const geometry = computeFitToCanvas({
        ...STORE_MOBILE_CANVAS,
        sourceHeightInPixels: 2992,
        sourceWidthInPixels
      });
      expect((900 - geometry.scaledWidthInPixels) % 2).toBe(0);
      expect(Number.isSafeInteger(geometry.marginInPixels)).toBe(true);
    }
  });

  it('should pick the nearer neighbor when rounding lands on the wrong parity', () => {
    // 1000 * (1600 / 2000) = 800 exactly; 900 - 800 = 100 is even, so 800 stands.
    const exact = computeFitToCanvas({
      ...STORE_MOBILE_CANVAS,
      sourceHeightInPixels: 2000,
      sourceWidthInPixels: 1000
    });
    expect(exact.scaledWidthInPixels).toBe(800);
    expect(exact.marginInPixels).toBe(50);
  });

  it('should need no adjustment when the source already matches the canvas ratio', () => {
    const geometry = computeFitToCanvas({
      ...STORE_MOBILE_CANVAS,
      sourceHeightInPixels: 3200,
      sourceWidthInPixels: 1800
    });
    expect(geometry.scaledWidthInPixels).toBe(900);
    expect(geometry.marginInPixels).toBe(0);
  });

  it('should refuse a source that is wider than the canvas once scaled to its height', () => {
    expect(() =>
      computeFitToCanvas({
        ...STORE_MOBILE_CANVAS,
        sourceHeightInPixels: 1000,
        sourceWidthInPixels: 2000
      })
    ).toThrow('cannot letterbox');
  });

  it('should reject non-positive dimensions', () => {
    expect(() =>
      computeFitToCanvas({
        ...STORE_MOBILE_CANVAS,
        sourceHeightInPixels: 0,
        sourceWidthInPixels: 1344
      })
    ).toThrow('must be a positive number');
  });
});

describe('fitScreenshotToCanvas', () => {
  it('should turn a 1344x2992 frame into exactly 900x1600', async () => {
    const source = await buildSolidPng(1344, 2992);
    const fitted = await fitScreenshotToCanvas(source, STORE_MOBILE_CANVAS);

    expect(readPngDimensions(fitted)).toStrictEqual({
      heightInPixels: 1600,
      widthInPixels: 900
    });
  });

  it('should fill the margins from the image rather than leaving them empty', async () => {
    // A red source: the blurred cover fill must make the margin columns red
    // Too, which is what distinguishes this from a transparent pillarbox.
    const source = await buildSolidPng(1344, 2992);
    const fitted = await fitScreenshotToCanvas(source, STORE_MOBILE_CANVAS);

    const sharpModule = await importSharpForTest();
    const { data, info } = await sharpModule.default(fitted)
      .raw()
      .toBuffer({ resolveWithObject: true });

    function readPixel(x: number, y: number): number[] {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
    }

    const MARGIN_SAMPLE_X = 5;
    const MIRROR_SAMPLE_X = 894;
    const SAMPLE_Y = 800;
    const STRONG_CHANNEL = 200;
    const WEAK_CHANNEL = 60;

    // Far-left margin, dead center vertically.
    const [leftRed, leftGreen, leftBlue] = readPixel(MARGIN_SAMPLE_X, SAMPLE_Y);
    expect(leftRed).toBeGreaterThan(STRONG_CHANNEL);
    expect(leftGreen).toBeLessThan(WEAK_CHANNEL);
    expect(leftBlue).toBeLessThan(WEAK_CHANNEL);

    // And the mirror column on the right.
    const [rightRed] = readPixel(MIRROR_SAMPLE_X, SAMPLE_Y);
    expect(rightRed).toBeGreaterThan(STRONG_CHANNEL);
  });
});

/**
 * Builds a solid red PNG of the given size, as a stand-in for a device frame.
 *
 * @param widthInPixels - The width to create.
 * @param heightInPixels - The height to create.
 * @returns The PNG bytes.
 */
async function buildSolidPng(widthInPixels: number, heightInPixels: number): Promise<Uint8Array> {
  const sharpModule = await importSharpForTest();
  const buffer = await sharpModule.default({
    create: {
      background: { b: 20, g: 20, r: 220 },
      channels: 3,
      height: heightInPixels,
      width: widthInPixels
    }
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
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
