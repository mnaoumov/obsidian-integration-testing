import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { SharpRawResult } from './sharp-loader.ts';

import { captureObsidianScreenshot } from './capture-obsidian-screenshot.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { pinWindowFocus } from './pin-window-focus.ts';
import { importSharp } from './sharp-loader.ts';
import { TemporaryVault } from './temporary-vault.ts';

// The desktop size the plugin store listings are shot at, so the frame these
// cases measure is the one a capture suite actually ships.
const WIDTH_IN_PIXELS = 1200;
const HEIGHT_IN_PIXELS = 800;

// How many captures the settle wait takes at most before the cases start
// regardless; a window still changing after that fails them, visibly.
const SETTLE_ATTEMPT_LIMIT = 10;

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const CAPTURE_TIMEOUT_IN_MILLISECONDS = 120_000;

const temporaryVault = new TemporaryVault();

beforeAll(async () => {
  await temporaryVault.register();
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

interface CaptureOptions {
  readonly shouldPinWindowFocus: boolean;
}

interface ElectronWindowHolder {
  electronWindow?: FocusReportingWindow;
}

interface FocusReportingWindow {
  isFocused: () => boolean;
}

interface FocusState {
  readonly hasFocusedClass: boolean;
  readonly isWindowFocused: boolean;
}

describe('pinWindowFocus integration', () => {
  it('draws a window the OS left unfocused exactly like a focused one, where it differs without the pin', async () => {
    const focused = await captureSettled();

    // What a launch refused the foreground looks like: Obsidian has taken the
    // class away, and nothing will put it back until the window gains focus.
    await setFocusedClass(false);
    try {
      // The control: the class really changes the frame, or the assertion
      // below could pass for chrome that never depended on it.
      const unpinned = await captureRaw({ shouldPinWindowFocus: false });
      expect(countChangedPixels(focused, unpinned)).toBeGreaterThan(0);

      const pinned = await captureRaw({ shouldPinWindowFocus: true });
      expect(countChangedPixels(focused, pinned)).toBe(0);
    } finally {
      await setFocusedClass(true);
    }
  }, CAPTURE_TIMEOUT_IN_MILLISECONDS);

  it('hands the class back to Obsidian, set to whether the window is focused now', async () => {
    await setFocusedClass(false);

    const pinned = await pinWindowFocus({ vaultPath: temporaryVault.path });
    expect(pinned.isPinned).toBe(true);
    const pinnedState = await readFocusState();
    expect(pinnedState.hasFocusedClass).toBe(true);

    await pinned.restore();
    const state = await readFocusState();
    expect(state.hasFocusedClass).toBe(state.isWindowFocused);

    await setFocusedClass(true);
  });

  it('leaves a window that already carries the class alone', async () => {
    await setFocusedClass(true);

    const pinned = await pinWindowFocus({ vaultPath: temporaryVault.path });
    expect(pinned.isPinned).toBe(false);
    await pinned.restore();

    // Even on a window the OS reports unfocused: a no-op restore must not
    // recompute the class the pin never touched.
    const state = await readFocusState();
    expect(state.hasFocusedClass).toBe(true);
  });
});

/**
 * Captures one frame at the store-listing size and decodes it to raw pixels.
 *
 * @param options - Whether to pin the window focus.
 * @returns A {@link Promise} that resolves to the pixels and their geometry.
 */
async function captureRaw(options: CaptureOptions): Promise<SharpRawResult> {
  const sharp = await importSharp('pin-window-focus.integration.test');
  const png = await captureObsidianScreenshot({
    heightInPixels: HEIGHT_IN_PIXELS,
    shouldPinWindowFocus: options.shouldPinWindowFocus,
    vaultPath: temporaryVault.path,
    widthInPixels: WIDTH_IN_PIXELS
  });
  return await sharp(png).raw().toBuffer({ resolveWithObject: true });
}

/**
 * Captures pinned frames until two consecutive ones agree, so a window still
 * drawing its first frames cannot read as a focus difference.
 *
 * @returns A {@link Promise} that resolves to the settled frame.
 */
async function captureSettled(): Promise<SharpRawResult> {
  let previous = await captureRaw({ shouldPinWindowFocus: true });
  for (let attempt = 0; attempt < SETTLE_ATTEMPT_LIMIT; attempt++) {
    const current = await captureRaw({ shouldPinWindowFocus: true });
    if (countChangedPixels(previous, current) === 0) {
      return current;
    }
    previous = current;
  }
  return previous;
}

/**
 * Counts the pixels that differ at all between two frames of the same size.
 *
 * @param first - One frame.
 * @param second - The other.
 * @returns The number of changed pixels.
 */
function countChangedPixels(first: SharpRawResult, second: SharpRawResult): number {
  const { channels } = first.info;
  let changedPixelCount = 0;
  for (let offset = 0; offset < first.data.length; offset += channels) {
    for (let channel = 0; channel < channels; channel++) {
      if (first.data[offset + channel] !== second.data[offset + channel]) {
        changedPixelCount++;
        break;
      }
    }
  }
  return changedPixelCount;
}

/**
 * Reads whether the body carries `is-focused`, and whether the window really
 * has focus.
 *
 * @returns A {@link Promise} that resolves to the {@link FocusState}.
 */
async function readFocusState(): Promise<FocusState> {
  return await evalInObsidian({
    callback(): FocusState {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: `electronWindow` is Obsidian's own Window property, kept local rather than declared globally.
      const { electronWindow } = globalThis as unknown as ElectronWindowHolder;
      return {
        hasFocusedClass: document.body.hasClass('is-focused'),
        isWindowFocused: electronWindow?.isFocused() ?? document.hasFocus()
      };
    },
    vaultPath: temporaryVault.path
  });
}

/**
 * Adds or removes `is-focused` on the body, as Obsidian does on a focus change.
 *
 * @param isFocused - Whether the class should be present.
 */
async function setFocusedClass(isFocused: boolean): Promise<void> {
  await evalInObsidian({
    callback({ isFocused: value }): void {
      document.body.toggleClass('is-focused', value);
    },
    input: { isFocused },
    vaultPath: temporaryVault.path
  });
}
