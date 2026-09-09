import {
  describe,
  expect,
  it
} from 'vitest';

import type { SoftKeyboardViewportSnapshot } from './soft-keyboard-geometry.ts';

import {
  buildSoftKeyboardDiagnosticMessage,
  checkIsSoftKeyboardUp,
  DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS,
  parseInputMethodState,
  resolveSoftKeyboardTapPoints
} from './soft-keyboard-geometry.ts';

/**
 * The 900x1600 screenshot AVD as the page sees it: 800 CSS pixels tall at a ratio of 2.
 */
const VIEWPORT_HEIGHT = 800;

/**
 * Builds a snapshot with the field's bottom edge at a given offset from the viewport bottom.
 *
 * @param liftInPixels - How far the field's bottom sits above the viewport bottom.
 * @param overrides - Anything else to vary.
 * @returns The snapshot.
 */
function buildSnapshot(liftInPixels: number, overrides?: Partial<SoftKeyboardViewportSnapshot>): SoftKeyboardViewportSnapshot {
  const HEIGHT = 40;

  return {
    devicePixelRatio: 2,
    innerHeight: VIEWPORT_HEIGHT,
    inputRect: {
      height: HEIGHT,
      left: 20,
      top: VIEWPORT_HEIGHT - liftInPixels - HEIGHT,
      width: 400
    },
    screenY: 0,
    ...overrides
  };
}

describe('checkIsSoftKeyboardUp', () => {
  it('should report the keyboard up when the field has lifted clear of the bottom', () => {
    expect(checkIsSoftKeyboardUp({ snapshot: buildSnapshot(350) })).toBe(true);
  });

  /*
   * The state every unfixed mobile frame is in: the field sits at the bottom of a full-height modal, and
   * the band above it where the keyboard belongs is empty.
   */
  it('should report the keyboard down when the field sits at the bottom', () => {
    expect(checkIsSoftKeyboardUp({ snapshot: buildSnapshot(0) })).toBe(false);
  });

  it('should report the keyboard down when there is no field on screen', () => {
    expect(checkIsSoftKeyboardUp({ snapshot: buildSnapshot(350, { inputRect: null }) })).toBe(false);
  });

  /*
   * The test the `@default` tag on `minimumKeyboardHeightInPixels` owes. Omitting the member must behave
   * exactly as passing the documented constant does, on both sides of the threshold.
   */
  it('should default the minimum lift to DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS', () => {
    const justUnder = buildSnapshot(DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS);
    const justOver = buildSnapshot(DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS + 1);

    expect(checkIsSoftKeyboardUp({ snapshot: justUnder })).toBe(false);
    expect(checkIsSoftKeyboardUp({ snapshot: justOver })).toBe(true);
    expect(checkIsSoftKeyboardUp({ minimumKeyboardHeightInPixels: DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS, snapshot: justUnder })).toBe(false);
    expect(checkIsSoftKeyboardUp({ minimumKeyboardHeightInPixels: DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS, snapshot: justOver })).toBe(true);
  });

  it('should honour a stricter minimum lift', () => {
    expect(checkIsSoftKeyboardUp({ minimumKeyboardHeightInPixels: 400, snapshot: buildSnapshot(350) })).toBe(false);
  });

  /*
   * A rounding pixel is not a keyboard. This is exactly what the minimum exists to reject.
   */
  it('should not read a one-pixel gap as a keyboard', () => {
    expect(checkIsSoftKeyboardUp({ snapshot: buildSnapshot(1) })).toBe(false);
  });
});

describe('resolveSoftKeyboardTapPoints', () => {
  it('should aim at the centre of the field, in device pixels', () => {
    expect(resolveSoftKeyboardTapPoints({ snapshot: buildSnapshot(0) })).toEqual([{ xInPixels: 440, yInPixels: 1560 }]);
  });

  /*
   * The WebView may or may not start at the top of the screen and the page cannot tell which, so both
   * candidates are tried. Both land inside the field, which is taller than the offset, so a wrong guess
   * costs a touch rather than a mis-tap on whatever sits below.
   */
  it('should offer the screenY-shifted point first when the window is offset', () => {
    expect(resolveSoftKeyboardTapPoints({ snapshot: buildSnapshot(0, { screenY: 50 }) })).toEqual([
      { xInPixels: 440, yInPixels: 1660 },
      { xInPixels: 440, yInPixels: 1560 }
    ]);
  });

  it('should offer a single point when the window is flush with the top, since both candidates coincide', () => {
    expect(resolveSoftKeyboardTapPoints({ snapshot: buildSnapshot(0) })).toHaveLength(1);
  });

  it('should return no points when there is no field to touch', () => {
    expect(resolveSoftKeyboardTapPoints({ snapshot: buildSnapshot(0, { inputRect: null }) })).toEqual([]);
  });

  it('should scale by the device pixel ratio', () => {
    const [point] = resolveSoftKeyboardTapPoints({ snapshot: buildSnapshot(0, { devicePixelRatio: 1 }) });

    expect(point).toEqual({ xInPixels: 220, yInPixels: 780 });
  });
});

describe('parseInputMethodState', () => {
  it('should keep only the fields that say whether the IME is showing', () => {
    const dumpsysOutput = [
      'Input method client state:',
      '  mShowRequested=true mShowExplicitlyRequested=false',
      '  mBindingController=stuff',
      '  mInputShown=true',
      '  mHaveConnection=true',
      ''
    ].join('\n');

    expect(parseInputMethodState(dumpsysOutput)).toBe('mShowRequested=true mShowExplicitlyRequested=false | mInputShown=true | mHaveConnection=true');
  });

  it('should return an empty string when the dump reports none of them', () => {
    expect(parseInputMethodState('Input method client state:\n  mBindingController=stuff\n')).toBe('');
  });

  it('should return an empty string for empty output', () => {
    expect(parseInputMethodState('')).toBe('');
  });
});

describe('buildSoftKeyboardDiagnosticMessage', () => {
  /*
   * The failure this reports cost two runs before the framebuffer dump said what was happening, so the
   * message has to carry the page's view and the device's view side by side — them disagreeing IS the
   * diagnosis.
   */
  it('should name the framebuffer, the page geometry and the device state', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      inputMethodState: 'mInputShown=true',
      screenshotPath: 'F:/dist/screenshots/keyboard-not-raised.png',
      snapshot: buildSnapshot(0)
    });

    expect(message).toContain('F:/dist/screenshots/keyboard-not-raised.png');
    expect(message).toContain('innerHeight=800');
    expect(message).toContain('inputBottom=800');
    expect(message).toContain('device: mInputShown=true');
  });

  it('should say the field was gone rather than printing a number for it', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      inputMethodState: 'mInputShown=false',
      screenshotPath: 'a.png',
      snapshot: buildSnapshot(0, { inputRect: null })
    });

    expect(message).toContain('inputBottom=(no input)');
  });

  it('should say so when the device reported no input_method state at all', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      inputMethodState: '',
      screenshotPath: 'a.png',
      snapshot: buildSnapshot(0)
    });

    expect(message).toContain('device: (no input_method state reported)');
  });
});
