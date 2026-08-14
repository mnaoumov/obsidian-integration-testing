import {
  describe,
  expect,
  it
} from 'vitest';

import {
  isPng,
  readPngDimensions
} from './capture-screenshot.ts';
import { connectToCdp } from './connect-to-cdp.ts';

// Launching an owned Obsidian instance can take up to a minute (download-free
// When the installed asar is reused, but CDP still needs time to come up).
const LAUNCH_TIMEOUT_IN_MILLISECONDS = 120_000;

// The desktop size T461 shoots the plugin store listings at.
const DESKTOP_WIDTH_IN_PIXELS = 1200;
const DESKTOP_HEIGHT_IN_PIXELS = 800;

describe('captureScreenshot integration', () => {
  it('captures a PNG of the owned instance at its natural size', async () => {
    const connection = await connectToCdp({ isObsidianAppVisible: false });
    try {
      const bytes = await connection.captureScreenshot();
      expect(isPng(bytes)).toBe(true);

      // No override was requested, so the size is the window's own — unknown,
      // But necessarily a real image rather than a zero-sized one.
      const { heightInPixels, widthInPixels } = readPngDimensions(bytes);
      expect(widthInPixels).toBeGreaterThan(0);
      expect(heightInPixels).toBeGreaterThan(0);
    } finally {
      await connection.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('captures at exactly the requested size, whatever the window size is', async () => {
    const connection = await connectToCdp({ isObsidianAppVisible: false });
    try {
      const bytes = await connection.captureScreenshot({
        heightInPixels: DESKTOP_HEIGHT_IN_PIXELS,
        widthInPixels: DESKTOP_WIDTH_IN_PIXELS
      });

      expect(readPngDimensions(bytes)).toStrictEqual({
        heightInPixels: DESKTOP_HEIGHT_IN_PIXELS,
        widthInPixels: DESKTOP_WIDTH_IN_PIXELS
      });
    } finally {
      await connection.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('clears the viewport override, so a sized capture does not resize the window for good', async () => {
    const connection = await connectToCdp({ isObsidianAppVisible: false });
    try {
      const before = await connection.invoke('window.innerWidth');
      await connection.captureScreenshot({
        heightInPixels: DESKTOP_HEIGHT_IN_PIXELS,
        widthInPixels: DESKTOP_WIDTH_IN_PIXELS
      });
      const after = await connection.invoke('window.innerWidth');

      // The override is applied and cleared around the capture, so the window
      // The next screenshot (or evaluation) sees is the one it started with.
      expect(after).toBe(before);
    } finally {
      await connection.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('rejects a half-specified size rather than guessing the other dimension', async () => {
    const connection = await connectToCdp({ isObsidianAppVisible: false });
    try {
      await expect(connection.captureScreenshot({ widthInPixels: DESKTOP_WIDTH_IN_PIXELS }))
        .rejects.toThrow('must be given together');
    } finally {
      await connection.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);
});
