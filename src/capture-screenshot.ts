/**
 * @file
 *
 * Pure helpers for screenshot capture: building the CDP device-metrics override
 * payload, decoding a base64-encoded PNG, and reading a PNG's pixel dimensions
 * out of its IHDR header.
 *
 * Kept separate from the transports (which are integration-only and excluded
 * from unit tests) so the payload shape and the PNG parsing stay unit-testable —
 * the transports themselves only talk to CDP / Appium.
 */

import type { Except } from 'type-fest';

/**
 * Parameters for capturing a screenshot of a running Obsidian instance.
 */
export interface CaptureScreenshotParams {
  /**
   * The working directory (vault path) identifying which Obsidian window to
   * capture.
   *
   * Mirrors the `cwd` of an evaluation: a desktop instance can hold several
   * vault windows, and the capture has to be routed to the right one.
   */
  readonly cwd: string;

  /**
   * The exact height in pixels the captured image should have.
   *
   * Desktop only, and only meaningful together with {@link widthInPixels}: the
   * viewport is pinned to these metrics for the duration of the capture, so the
   * resulting PNG is exactly this size whatever size the window happens to be.
   * Omit both to capture the window at its natural size.
   *
   * Ignored by the Appium transport, which can only return the device's native
   * framebuffer — size a mobile capture by choosing an AVD with the wanted
   * screen geometry instead.
   */
  readonly heightInPixels?: number;

  /**
   * The exact width in pixels the captured image should have.
   *
   * See {@link heightInPixels} — the two are set together or not at all.
   */
  readonly widthInPixels?: number;
}

/**
 * The pixel dimensions read out of a PNG's IHDR header.
 */
export interface PngDimensions {
  /**
   * The image height in pixels.
   */
  readonly heightInPixels: number;

  /**
   * The image width in pixels.
   */
  readonly widthInPixels: number;
}

/**
 * The ASCII marker inside a PNG's 8-byte signature.
 *
 * Matched as text rather than as the raw signature bytes so this file stays
 * pure ASCII — two of those eight bytes are unprintable, and a literal `0x1A`
 * in a source file is read as end-of-file by some Windows tooling.
 */
const PNG_MARKER = 'PNG';

/**
 * Byte offset of {@link PNG_MARKER}, immediately after the signature's leading
 * unprintable byte.
 */
const PNG_MARKER_OFFSET = 1;

/**
 * The IHDR chunk's type marker.
 *
 * Required alongside {@link PNG_MARKER} because the dimensions are read out of
 * exactly that chunk, so its presence is what actually has to hold here.
 */
const PNG_IHDR_MARKER = 'IHDR';

/**
 * Byte offset of {@link PNG_IHDR_MARKER}: the 8-byte signature plus the chunk's
 * 4-byte length field.
 */
const PNG_IHDR_MARKER_OFFSET = 12;

/**
 * Byte offset of the big-endian `width` field, immediately after the IHDR type.
 */
const PNG_WIDTH_OFFSET = 16;

/**
 * Byte offset of the big-endian `height` field, immediately after `width`.
 */
const PNG_HEIGHT_OFFSET = 20;

/**
 * The shortest prefix from which {@link readPngDimensions} can read: everything
 * up to and including the IHDR `height` field.
 */
const PNG_HEADER_MIN_LENGTH = 24;

/**
 * Device scale factor for a capture.
 *
 * Always `1`, so the emitted PNG is exactly the requested CSS pixel size rather
 * than a multiple of it.
 */
const CAPTURE_DEVICE_SCALE_FACTOR = 1;

/**
 * Builds the `Emulation.setDeviceMetricsOverride` payload that pins a desktop
 * capture to an exact pixel size.
 *
 * Takes only the size half of {@link CaptureScreenshotParams} — routing the
 * capture to a window is the transport's job, not the payload's.
 *
 * @param params - The requested capture size.
 * @returns The CDP payload, or `undefined` when no size was requested (capture the window as it is).
 * @throws Error if exactly one of the two dimensions is given — a half-specified size cannot be honoured.
 */
export function buildDeviceMetricsOverride(params: Except<CaptureScreenshotParams, 'cwd'>): Record<string, unknown> | undefined {
  const { heightInPixels, widthInPixels } = params;
  if (heightInPixels === undefined && widthInPixels === undefined) {
    return undefined;
  }

  if (heightInPixels === undefined || widthInPixels === undefined) {
    throw new Error('captureScreenshot: widthInPixels and heightInPixels must be given together.');
  }

  return {
    deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
    height: heightInPixels,
    mobile: false,
    width: widthInPixels
  };
}

/**
 * Decodes the base64 payload both CDP (`Page.captureScreenshot`) and Appium
 * (`takeScreenshot`) return into raw PNG bytes.
 *
 * @param base64 - The base64-encoded image data.
 * @returns The decoded bytes.
 */
export function decodeBase64Png(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Decides whether the given bytes are a PNG carrying an IHDR chunk.
 *
 * Used to fail a capture loudly when a transport hands back something that is
 * not an image, rather than writing a corrupt file to disk.
 *
 * @param bytes - The bytes to check.
 * @returns `true` when the bytes are a PNG.
 */
export function isPng(bytes: Uint8Array): boolean {
  return readAscii(bytes, PNG_MARKER_OFFSET, PNG_MARKER.length) === PNG_MARKER
    && readAscii(bytes, PNG_IHDR_MARKER_OFFSET, PNG_IHDR_MARKER.length) === PNG_IHDR_MARKER;
}

/**
 * Reads a PNG's pixel dimensions from its IHDR header.
 *
 * The whole point is verification: a capture that silently comes back at the
 * wrong size is the failure mode that produces an off-spec screenshot set, so
 * the size is read back from the bytes rather than assumed from the request.
 *
 * @param bytes - The PNG bytes.
 * @returns The image's width and height in pixels.
 * @throws Error if the bytes are not a PNG, or are too short to carry an IHDR header.
 */
export function readPngDimensions(bytes: Uint8Array): PngDimensions {
  if (!isPng(bytes)) {
    throw new Error('readPngDimensions: the given bytes are not a PNG.');
  }

  if (bytes.length < PNG_HEADER_MIN_LENGTH) {
    throw new Error(`readPngDimensions: a PNG header needs at least ${String(PNG_HEADER_MIN_LENGTH)} bytes, got ${String(bytes.length)}.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    heightInPixels: view.getUint32(PNG_HEIGHT_OFFSET),
    widthInPixels: view.getUint32(PNG_WIDTH_OFFSET)
  };
}

/**
 * Reads a fixed-length ASCII marker out of a byte buffer.
 *
 * @param bytes - The bytes to read from.
 * @param offset - Byte offset the marker starts at.
 * @param length - Marker length in bytes.
 * @returns The decoded marker, or an empty string when the buffer is too short to hold it.
 */
function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) {
    return '';
  }

  return Buffer.from(bytes.subarray(offset, offset + length)).toString('ascii');
}
