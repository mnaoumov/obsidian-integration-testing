import {
  describe,
  expect,
  it
} from 'vitest';

import { readPngDimensions } from './capture-screenshot.ts';
import {
  buildLabelSvg,
  computeLabelBand,
  escapeSvgText,
  labelScreenshot
} from './label-screenshot.ts';

const DESKTOP = { imageHeightInPixels: 800, imageWidthInPixels: 1200 };
const MOBILE = { imageHeightInPixels: 1600, imageWidthInPixels: 900 };

describe('computeLabelBand', () => {
  it('should sit the band flush against the bottom of the image', () => {
    const geometry = computeLabelBand(DESKTOP);
    expect(geometry.topInPixels + geometry.heightInPixels).toBe(DESKTOP.imageHeightInPixels);
  });

  it('should size the caption from the WIDTH, so both formats read alike', () => {
    // A 1200-wide desktop frame and a 900-wide phone frame are viewed at similar
    // On-screen widths in a listing; sizing by height would make the phone
    // Caption twice the desktop one.
    const desktop = computeLabelBand(DESKTOP);
    const mobile = computeLabelBand(MOBILE);
    expect(desktop.fontSizeInPixels).toBe(41);
    expect(mobile.fontSizeInPixels).toBe(31);
  });

  it('should deepen the band on a tall frame, so it covers the status row it sits over', () => {
    // Caption-derived height on a 900x1600 phone is 68px, which sliced through
    // The status row; the floor takes it to 120px.
    const mobile = computeLabelBand(MOBILE);
    expect(mobile.heightInPixels).toBe(120);
    // On a wide frame the caption-derived height already wins, so the floor is inert.
    const desktop = computeLabelBand(DESKTOP);
    expect(desktop.heightInPixels).toBe(90);
  });

  it('should never let the band swallow the whole image', () => {
    const geometry = computeLabelBand({ imageHeightInPixels: 40, imageWidthInPixels: 1200 });
    expect(geometry.heightInPixels).toBeLessThanOrEqual(40);
    expect(geometry.topInPixels).toBeGreaterThanOrEqual(0);
  });

  it('should keep a floor under the caption size on a narrow image', () => {
    const geometry = computeLabelBand({ imageHeightInPixels: 300, imageWidthInPixels: 200 });
    expect(geometry.fontSizeInPixels).toBe(18);
  });

  it('should reject non-positive dimensions', () => {
    expect(() => computeLabelBand({ imageHeightInPixels: 800, imageWidthInPixels: 0 }))
      .toThrow('imageWidthInPixels must be a positive number');
    expect(() => computeLabelBand({ imageHeightInPixels: -1, imageWidthInPixels: 900 }))
      .toThrow('imageHeightInPixels must be a positive number');
  });
});

describe('escapeSvgText', () => {
  it('should escape the characters that would break the SVG', () => {
    expect(escapeSvgText('a & b < c > d "e" \'f\''))
      .toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  });

  it('should escape Obsidian link syntax, which a caption can legitimately contain', () => {
    expect(escapeSvgText('[Shared topic](<./Shared topic.md>)'))
      .toBe('[Shared topic](&lt;./Shared topic.md&gt;)');
  });

  it('should leave ordinary text alone', () => {
    expect(escapeSvgText('Every backlink shows its full path')).toBe('Every backlink shows its full path');
  });
});

describe('buildLabelSvg', () => {
  it('should span the full image width', () => {
    const geometry = computeLabelBand(DESKTOP);
    const svg = buildLabelSvg('Full path', geometry, DESKTOP.imageWidthInPixels);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain(`height="${String(geometry.heightInPixels)}"`);
  });

  it('should center the caption', () => {
    const geometry = computeLabelBand(DESKTOP);
    const svg = buildLabelSvg('Full path', geometry, DESKTOP.imageWidthInPixels);
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('x="600"');
  });

  it('should embed the caption escaped', () => {
    const geometry = computeLabelBand(DESKTOP);
    const svg = buildLabelSvg('a & b', geometry, DESKTOP.imageWidthInPixels);
    expect(svg).toContain('a &amp; b');
    expect(svg).not.toContain('a & b');
  });
});

describe('labelScreenshot', () => {
  it('should keep the image exactly its original size', async () => {
    const source = await buildSolidPng(1200, 800);
    const labeled = await labelScreenshot(source, { text: 'Every backlink shows its full path' });

    expect(readPngDimensions(labeled)).toStrictEqual({ heightInPixels: 800, widthInPixels: 1200 });
  });

  it('should darken the bottom band and leave the rest of the frame alone', async () => {
    const source = await buildSolidPng(1200, 800);
    const labeled = await labelScreenshot(source, { text: 'Full path' });

    const sharpModule = await importSharpForTest();
    const { data, info } = await sharpModule.default(labeled).raw().toBuffer({ resolveWithObject: true });

    function redAt(x: number, y: number): number {
      return data[(y * info.width + x) * info.channels] ?? 0;
    }

    const geometry = computeLabelBand(DESKTOP);
    const STRONG_RED = 200;
    const DARKENED = 120;

    // Above the band the source red survives untouched.
    expect(redAt(600, geometry.topInPixels - 20)).toBeGreaterThan(STRONG_RED);
    // Inside the band it is dimmed by the overlay.
    expect(redAt(20, geometry.topInPixels + 20)).toBeLessThan(DARKENED);
  });

  it('should survive a caption containing SVG-hostile characters', async () => {
    const source = await buildSolidPng(900, 1600);
    const labeled = await labelScreenshot(source, { text: 'Links like [a](<b.md>) & such' });

    expect(readPngDimensions(labeled)).toStrictEqual({ heightInPixels: 1600, widthInPixels: 900 });
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
