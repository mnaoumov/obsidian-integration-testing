/**
 * @file
 *
 * Photographs the DEVICE, not the web page.
 *
 * `captureObsidianScreenshot` goes through Appium in the WebView context, so on
 * Android it captures the page: no status bar, and — the reason this exists —
 * no soft keyboard, because the IME is a system window and not part of the
 * page. A frame that is meant to show what a phone looks like therefore cannot
 * be taken that way.
 *
 * `adb exec-out screencap -p` reads the framebuffer instead, which is the same
 * route the trusted-input passes already use. The trade is deliberate and worth
 * writing down at every call site: a device capture carries the status-bar clock
 * and battery, so it is **not byte-reproducible** the way a page capture is.
 * Reach for this only for the shots that need the keyboard; leave the rest on
 * `captureObsidianScreenshot`.
 */

import { runAdbBinary } from './adb.ts';
import { isPng } from './capture-screenshot.ts';

/**
 * Parameters for {@link captureDeviceScreenshot}.
 */
export interface CaptureDeviceScreenshotParams {
  /**
   * The device to photograph.
   */
  readonly deviceId: string;
}

/* v8 ignore start -- Integration-time code (shells out to a real device) covered by integration tests, not unit tests. */

/**
 * Captures the device's framebuffer as a PNG.
 *
 * @param params - The device to photograph.
 * @returns A {@link Promise} that resolves to the raw PNG bytes.
 * @throws Error if what came back is not a PNG — which is what a truncated or text-decoded capture looks
 *   like, and is far cheaper to catch here than in an image diff.
 */
export async function captureDeviceScreenshot(params: CaptureDeviceScreenshotParams): Promise<Uint8Array> {
  const bytes = await runAdbBinary({
    commandArguments: ['exec-out', 'screencap', '-p'],
    deviceId: params.deviceId
  });

  if (!isPng(bytes)) {
    throw new Error(
      `captureDeviceScreenshot: ${params.deviceId} returned ${String(bytes.length)} bytes that are not a PNG. `
        + 'A device that is still booting, or an adb transport that decoded the stream as text, both look like this.'
    );
  }

  return bytes;
}

/* v8 ignore stop */
