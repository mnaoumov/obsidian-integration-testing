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
 * The CSS viewport the mobile layout pins a desktop window to, as far as a
 * capture needs it.
 */
export interface CaptureMobileViewport {
  /**
   * The viewport height, in CSS pixels.
   */
  readonly heightInPixels: number;

  /**
   * The viewport width, in CSS pixels.
   */
  readonly widthInPixels: number;
}

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
   * Device pixels per CSS pixel for the capture.
   *
   * Desktop only. With a size, the PNG is still exactly
   * {@link widthInPixels} x {@link heightInPixels}, and the page is laid out at
   * that size divided by this factor, which must give whole CSS pixels. Without
   * one, the window keeps its own CSS size and the PNG is that size times this
   * factor.
   *
   * @default `1` with a size, so a sized frame keeps the layout it always had;
   *   `2` without one, so an unsized frame is sharp. Under the mobile layout an
   *   unsized capture keeps the layout's own factor instead.
   */
  readonly deviceScaleFactor?: number;

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
 * Parameters for {@link resolveCaptureMetricsOverride}.
 */
export interface ResolveCaptureMetricsOverrideParams {
  /**
   * The requested capture size and density.
   */
  readonly captureParams: Except<CaptureScreenshotParams, 'cwd'>;

  /**
   * The viewport the mobile layout pins, or `null` when the window is not in it.
   */
  readonly mobileViewport: CaptureMobileViewport | null;
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
 * Device scale factor of a capture given an exact size.
 *
 * `1`, so a sized frame is laid out at its PNG size, as it always was: every
 * committed store-listing frame was shot that way.
 */
export const SIZED_CAPTURE_DEVICE_SCALE_FACTOR = 1;

/**
 * Device scale factor of a capture given no size.
 *
 * `2`, so a frame of the window as it is comes out sharp rather than at one
 * device pixel per CSS pixel.
 */
export const UNSIZED_CAPTURE_DEVICE_SCALE_FACTOR = 2;

/**
 * Builds the `Emulation.setDeviceMetricsOverride` payload that pins a desktop
 * capture to an exact pixel size, a pixel density, or both.
 *
 * Takes only the size half of {@link CaptureScreenshotParams} — routing the
 * capture to a window is the transport's job, not the payload's. An unsized
 * payload sends width and height `0`, which CDP reads as "keep the window's
 * own size".
 *
 * @param params - The requested capture size and density.
 * @returns The CDP payload, or `null` when the window is captured as it is (no size, and a density of `1`).
 * @throws Error if exactly one of the two dimensions is given, if the density is not a positive number, or if the size
 *   divided by the density is not whole CSS pixels.
 */
export function buildDeviceMetricsOverride(params: Except<CaptureScreenshotParams, 'cwd'>): null | Record<string, unknown> {
  const { heightInPixels, widthInPixels } = params;
  if (heightInPixels === undefined && widthInPixels === undefined) {
    const deviceScaleFactor = params.deviceScaleFactor ?? UNSIZED_CAPTURE_DEVICE_SCALE_FACTOR;
    assertDeviceScaleFactor(deviceScaleFactor);
    return deviceScaleFactor === 1
      ? null
      : {
        deviceScaleFactor,
        height: 0,
        mobile: false,
        width: 0
      };
  }

  if (heightInPixels === undefined || widthInPixels === undefined) {
    throw new Error('captureScreenshot: widthInPixels and heightInPixels must be given together.');
  }

  const deviceScaleFactor = params.deviceScaleFactor ?? SIZED_CAPTURE_DEVICE_SCALE_FACTOR;
  assertDeviceScaleFactor(deviceScaleFactor);
  const width = widthInPixels / deviceScaleFactor;
  const height = heightInPixels / deviceScaleFactor;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new TypeError(
      `captureScreenshot: ${String(widthInPixels)} x ${String(heightInPixels)} pixels at deviceScaleFactor ${String(deviceScaleFactor)} `
        + `is ${String(width)} x ${String(height)} CSS pixels; pick a size the factor divides into whole CSS pixels.`
    );
  }

  return {
    deviceScaleFactor,
    height,
    mobile: false,
    width
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
 * Builds the device-metrics override a desktop capture needs, given the viewport
 * the window is pinned to by the mobile layout, if any.
 *
 * Under the mobile layout an unsized capture is the layout's own viewport, at
 * its own factor, unless the capture asks for another factor; then the layout's
 * CSS size is kept and only the factor changes. A width and height of `0` would
 * drop the layout's viewport for the length of the capture.
 *
 * @param params - The requested capture and the mobile layout's viewport.
 * @returns The CDP payload, or `null` when the window is captured as it is.
 * @throws Error under the same conditions as {@link buildDeviceMetricsOverride}.
 */
export function resolveCaptureMetricsOverride(params: ResolveCaptureMetricsOverrideParams): null | Record<string, unknown> {
  const { captureParams, mobileViewport } = params;
  const isUnsized = captureParams.heightInPixels === undefined && captureParams.widthInPixels === undefined;
  if (!isUnsized || mobileViewport === null) {
    return buildDeviceMetricsOverride(captureParams);
  }

  if (captureParams.deviceScaleFactor === undefined) {
    return null;
  }

  assertDeviceScaleFactor(captureParams.deviceScaleFactor);
  return {
    deviceScaleFactor: captureParams.deviceScaleFactor,
    height: mobileViewport.heightInPixels,
    mobile: false,
    width: mobileViewport.widthInPixels
  };
}

/**
 * Refuses a device scale factor that is not a positive finite number.
 *
 * @param deviceScaleFactor - The factor to check.
 * @throws Error if the factor is not a positive finite number.
 */
function assertDeviceScaleFactor(deviceScaleFactor: number): void {
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
    throw new Error(`captureScreenshot: deviceScaleFactor must be a positive number, got ${String(deviceScaleFactor)}.`);
  }
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
  return bytes.length < offset + length ? '' : Buffer.from(bytes.subarray(offset, offset + length)).toString('ascii');
}
