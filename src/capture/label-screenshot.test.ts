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
  labelScreenshot,
  measureLabelCaption
} from './label-screenshot.ts';

const DESKTOP = { imageHeightInPixels: 800, imageWidthInPixels: 1200 };
const MOBILE = { imageHeightInPixels: 1600, imageWidthInPixels: 900 };

/**
 * The caption that shipped clipped at both ends on a 1200px store shot, reading
 * `nabled in Settings - a listening plugin is told which plugin, and w`.
 */
const OVERLONG_CAPTION = 'More Events is enabled in Settings - a listening plugin is told which plugin, and when';

describe('computeLabelBand', () => {
  it('should sit the band flush against the bottom of the image', () => {
    const geometry = computeLabelBand(DESKTOP);
    expect(geometry.topInPixels + geometry.heightInPixels).toBe(DESKTOP.imageHeightInPixels);
  });

  it('should size the caption from the WIDTH, so both formats read alike', () => {
    // A 1200-wide desktop frame and a 900-wide phone frame are viewed at similar
    // on-screen widths in a listing; sizing by height would make the phone
    // caption twice the desktop one.
    const desktop = computeLabelBand(DESKTOP);
    const mobile = computeLabelBand(MOBILE);
    expect(desktop.fontSizeInPixels).toBe(41);
    expect(mobile.fontSizeInPixels).toBe(31);
  });

  it('should deepen the band on a tall frame, so it covers the status row it sits over', () => {
    // Caption-derived height on a 900x1600 phone is 68px, which sliced through
    // the status row; the floor takes it to 120px.
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

  it('should hold a margin clear at each end of the caption', () => {
    // 4% of 1200 is 48px a side; of 900, 36px.
    expect(computeLabelBand(DESKTOP).captionRoomInPixels).toBe(1104);
    expect(computeLabelBand(MOBILE).captionRoomInPixels).toBe(828);
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

  it('should draw the band fully opaque, written out rather than left to the SVG default', () => {
    const geometry = computeLabelBand(DESKTOP);
    const svg = buildLabelSvg('Full path', geometry, DESKTOP.imageWidthInPixels);
    // The band COVERS the bottom chrome, so the attribute is the decision
    // written down. `fill-opacity` defaults to 1 anyway; omitting it would leave
    // the band opaque by accident of the format, with nothing to assert on.
    expect(svg).toContain('fill-opacity="1"');
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

  it('should COVER the bottom band, leaving nothing of the frame under it, and leave the rest alone', async () => {
    const source = await buildSolidPng(1200, 800);
    const labeled = await labelScreenshot(source, { text: 'Full path' });

    const sharpModule = await importSharpForTest();
    const { data, info } = await sharpModule.default(labeled).raw().toBuffer({ resolveWithObject: true });

    function redAt(x: number, y: number): number {
      return data[(y * info.width + x) * info.channels] ?? 0;
    }

    const geometry = computeLabelBand(DESKTOP);
    const STRONG_RED = 200;
    // A row inside the band and above the glyphs, so the caption's own ink is
    // not mistaken for the source showing through.
    const CLEAR_BAND_ROW_OFFSET = 5;

    // Above the band the source red survives untouched.
    expect(redAt(600, geometry.topInPixels - 20)).toBeGreaterThan(STRONG_RED);

    // Inside it, EVERY column is the band's own black rather than a dimmed
    // version of the frame: the band covers, so what the bottom chrome held is
    // gone rather than attenuated. At 0.94 each of these read about 6 % of the
    // source instead — invisible to a reader and a pixel diff apiece.
    const bandRowY = geometry.topInPixels + CLEAR_BAND_ROW_OFFSET;
    const survivingColumns = Array.from({ length: info.width }, (_unused, x) => x)
      .filter((x) => redAt(x, bandRowY) !== 0);
    expect(survivingColumns).toStrictEqual([]);
  });

  it('should survive a caption containing SVG-hostile characters', async () => {
    const source = await buildSolidPng(900, 1600);
    const labeled = await labelScreenshot(source, { text: 'Links like [a](<b.md>) & such' });

    expect(readPngDimensions(labeled)).toStrictEqual({ heightInPixels: 1600, widthInPixels: 900 });
  });

  it('should refuse a caption too wide for the frame, rather than clipping it at both ends', async () => {
    const source = await buildSolidPng(1200, 800);

    await expect(labelScreenshot(source, { text: OVERLONG_CAPTION }))
      .rejects.toThrow(/labelScreenshot: the caption is \d+px too wide for the frame\./);
  });

  it('should name the measurement, the room and the caption when it refuses one', async () => {
    const source = await buildSolidPng(1200, 800);
    const { captionRoomInPixels, textWidthInPixels } = await measureLabelCaption({ ...DESKTOP, text: OVERLONG_CAPTION });

    // A substring match, so the numbers are compared as the message prints
    // them: what makes the failure actionable is the measurement, not the
    // wording around it.
    await expect(labelScreenshot(source, { text: OVERLONG_CAPTION })).rejects.toThrow(
      `It renders ${String(textWidthInPixels)}px at font-size 41, `
        + `and a 1200px frame has room for ${String(captionRoomInPixels)}px.`
    );
    await expect(labelScreenshot(source, { text: OVERLONG_CAPTION })).rejects.toThrow(JSON.stringify(OVERLONG_CAPTION));
  });
});

describe('measureLabelCaption', () => {
  it('should measure a caption at the size the band would draw it', async () => {
    const measurement = await measureLabelCaption({ ...DESKTOP, text: 'Full path' });

    expect(measurement.captionRoomInPixels).toBe(1104);
    expect(measurement.doesFit).toBe(true);
    // A nine-character caption at font-size 41 is a couple of hundred pixels
    // wide; the point of the assertion is that something was measured, not the
    // exact pixel, which is a font the host may or may not have.
    expect(measurement.textWidthInPixels).toBeGreaterThan(50);
    expect(measurement.textWidthInPixels).toBeLessThan(measurement.captionRoomInPixels);
  });

  it('should report the caption that shipped clipped as not fitting', async () => {
    const measurement = await measureLabelCaption({ ...DESKTOP, text: OVERLONG_CAPTION });

    expect(measurement.doesFit).toBe(false);
    expect(measurement.textWidthInPixels).toBeGreaterThan(measurement.captionRoomInPixels);
  });

  it('should scale with the frame, so a bigger frame cannot rescue an overlong caption', async () => {
    const desktop = await measureLabelCaption({ ...DESKTOP, text: OVERLONG_CAPTION });
    const doubled = await measureLabelCaption({ imageHeightInPixels: 1600, imageWidthInPixels: 2400, text: OVERLONG_CAPTION });

    // The font size comes from the width, so twice the frame is twice the text
    // AND twice the room: a caption that does not fit never fits, which is why
    // the answer is to shorten it rather than to re-shoot wider.
    const DOUBLED_LOWER = 1.9;
    const DOUBLED_UPPER = 2.1;
    expect(doubled.textWidthInPixels).toBeGreaterThan(desktop.textWidthInPixels * DOUBLED_LOWER);
    expect(doubled.textWidthInPixels).toBeLessThan(desktop.textWidthInPixels * DOUBLED_UPPER);
    expect(doubled.doesFit).toBe(false);
  });

  it('should measure a caption with no ink as zero, since trim reports an untouched canvas', async () => {
    // An all-transparent canvas comes back from `trim` unchanged, which would
    // otherwise read as a caption exactly as wide as the measuring canvas.
    const measurement = await measureLabelCaption({ ...DESKTOP, text: ' '.repeat(3) });

    expect(measurement.textWidthInPixels).toBe(0);
    expect(measurement.doesFit).toBe(true);
  });

  it('should reject non-positive dimensions, like the geometry it derives', async () => {
    await expect(measureLabelCaption({ imageHeightInPixels: 800, imageWidthInPixels: 0, text: 'Full path' }))
      .rejects.toThrow('imageWidthInPixels must be a positive number');
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
