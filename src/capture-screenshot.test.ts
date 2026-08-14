import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildDeviceMetricsOverride,
  decodeBase64Png,
  isPng,
  readPngDimensions
} from './capture-screenshot.ts';

/**
 * Builds the first 24 bytes of a PNG — signature, IHDR chunk length, `IHDR`
 * type, then the big-endian width and height — which is everything
 * {@link readPngDimensions} reads.
 *
 * @param widthInPixels - The width to encode.
 * @param heightInPixels - The height to encode.
 * @returns The PNG header bytes.
 */
function buildPngHeader(widthInPixels: number, heightInPixels: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  bytes.set([0x00, 0x00, 0x00, 0x0D], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, widthInPixels);
  view.setUint32(20, heightInPixels);
  return bytes;
}

describe('buildDeviceMetricsOverride', () => {
  it('should return undefined when no size is requested', () => {
    expect(buildDeviceMetricsOverride({})).toBeUndefined();
  });

  it('should pin the viewport to the requested size', () => {
    expect(buildDeviceMetricsOverride({ heightInPixels: 800, widthInPixels: 1200 })).toStrictEqual({
      deviceScaleFactor: 1,
      height: 800,
      mobile: false,
      width: 1200
    });
  });

  it('should use a device scale factor of 1 so the PNG is exactly the requested size', () => {
    const override = buildDeviceMetricsOverride({ heightInPixels: 1600, widthInPixels: 900 });
    expect(override?.['deviceScaleFactor']).toBe(1);
  });

  it('should throw when only the width is given', () => {
    expect(() => buildDeviceMetricsOverride({ widthInPixels: 1200 })).toThrow('must be given together');
  });

  it('should throw when only the height is given', () => {
    expect(() => buildDeviceMetricsOverride({ heightInPixels: 800 })).toThrow('must be given together');
  });
});

describe('decodeBase64Png', () => {
  it('should decode base64 into the original bytes', () => {
    expect([...decodeBase64Png(Buffer.from([0, 1, 2, 3]).toString('base64'))]).toStrictEqual([0, 1, 2, 3]);
  });

  it('should decode a base64 PNG header into something isPng accepts', () => {
    const base64 = Buffer.from(buildPngHeader(1, 1)).toString('base64');
    expect(isPng(decodeBase64Png(base64))).toBe(true);
  });
});

describe('isPng', () => {
  it('should accept bytes starting with the PNG signature', () => {
    expect(isPng(buildPngHeader(10, 20))).toBe(true);
  });

  it('should reject bytes that are not a PNG', () => {
    expect(isPng(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(false);
  });

  it('should reject bytes shorter than the signature', () => {
    expect(isPng(new Uint8Array([0x89, 0x50]))).toBe(false);
  });

  it('should reject a PNG signature with no IHDR chunk behind it', () => {
    // The dimensions are read out of IHDR, so a signature alone is not enough
    // To call these bytes readable.
    expect(isPng(buildPngHeader(1, 1).subarray(0, 12))).toBe(false);
  });

  it('should reject an empty buffer', () => {
    expect(isPng(new Uint8Array())).toBe(false);
  });
});

describe('readPngDimensions', () => {
  it('should read the desktop screenshot size', () => {
    expect(readPngDimensions(buildPngHeader(1200, 800))).toStrictEqual({ heightInPixels: 800, widthInPixels: 1200 });
  });

  it('should read the mobile screenshot size', () => {
    expect(readPngDimensions(buildPngHeader(900, 1600))).toStrictEqual({ heightInPixels: 1600, widthInPixels: 900 });
  });

  it('should read dimensions from a view onto a larger buffer', () => {
    // A decoded PNG is often a view into a pooled buffer with a non-zero byteOffset.
    const backing = new Uint8Array(64);
    backing.set(buildPngHeader(640, 480), 16);
    expect(readPngDimensions(backing.subarray(16))).toStrictEqual({ heightInPixels: 480, widthInPixels: 640 });
  });

  it('should throw when the bytes are not a PNG', () => {
    expect(() => readPngDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]))).toThrow('not a PNG');
  });

  it('should throw when the PNG is truncated before the IHDR dimensions', () => {
    expect(() => readPngDimensions(buildPngHeader(1, 1).subarray(0, 20))).toThrow('at least 24 bytes');
  });
});
