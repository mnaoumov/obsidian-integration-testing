import {
  describe,
  expect,
  it
} from 'vitest';

import type { SoftKeyboardViewportSnapshot } from './soft-keyboard-geometry.ts';

import {
  buildSoftKeyboardDiagnosticMessage,
  checkIsInputMethodShown,
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
 * The field's `top` on a centred prompt modal, measured on a device on 2026-09-12 — before and after real
 * `adb` taps alike, since nothing moved.
 */
const MEASURED_CENTERED_MODAL_TOP = 352.4453125;

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

/**
 * Builds a snapshot with the field's top edge at a given offset from the viewport top.
 *
 * The bottom-anchored builder above cannot say "a centred field that never moves" without arithmetic that
 * hides the measured number, and that number is the whole point of the regression it serves.
 *
 * @param topInPixels - How far the field's top sits below the viewport top.
 * @returns The snapshot.
 */
function buildSnapshotAtTop(topInPixels: number): SoftKeyboardViewportSnapshot {
  return buildSnapshot(0, {
    inputRect: {
      height: 40,
      left: 20,
      top: topInPixels,
      width: 400
    }
  });
}

describe('checkIsSoftKeyboardUp', () => {
  it('should report the keyboard up when the field has lifted from where it started', () => {
    expect(checkIsSoftKeyboardUp({ baselineSnapshot: buildSnapshot(0), snapshot: buildSnapshot(350) })).toBe(true);
  });

  /*
   * The state every unfixed mobile frame is in: the field sits at the bottom of a full-height modal, and
   * the band above it where the keyboard belongs is empty.
   */
  it('should report the keyboard down when the field has not moved off the bottom', () => {
    expect(checkIsSoftKeyboardUp({ baselineSnapshot: buildSnapshot(0), snapshot: buildSnapshot(0) })).toBe(false);
  });

  /*
   * The regression this check was rewritten for. A centred modal's field sits clear of the bottom with no
   * keyboard at all, so the absolute-offset test this replaced answered `true` on the very first read --
   * before a single touch had been dispatched -- and `raiseSoftKeyboard` returned success having done
   * nothing. The number is what a device actually reported, before and after real taps.
   */
  it('should report the keyboard down for a centred field that sits clear of the bottom and never moves', () => {
    const baselineSnapshot = buildSnapshotAtTop(MEASURED_CENTERED_MODAL_TOP);

    expect(checkIsSoftKeyboardUp({ baselineSnapshot, snapshot: buildSnapshotAtTop(MEASURED_CENTERED_MODAL_TOP) })).toBe(false);
  });

  it('should report the keyboard up when a centred field does lift', () => {
    const baselineSnapshot = buildSnapshotAtTop(MEASURED_CENTERED_MODAL_TOP);

    expect(checkIsSoftKeyboardUp({ baselineSnapshot, snapshot: buildSnapshotAtTop(MEASURED_CENTERED_MODAL_TOP - 200) })).toBe(true);
  });

  /*
   * A field that sank is not a keyboard either, however far it went -- only an absolute-value comparison
   * would read it as one.
   */
  it('should report the keyboard down when the field moved down instead of up', () => {
    expect(checkIsSoftKeyboardUp({ baselineSnapshot: buildSnapshot(350), snapshot: buildSnapshot(0) })).toBe(false);
  });

  it('should report the keyboard down when there is no field on screen', () => {
    expect(checkIsSoftKeyboardUp({ baselineSnapshot: buildSnapshot(0), snapshot: buildSnapshot(350, { inputRect: null }) })).toBe(false);
  });

  it('should report the keyboard down when the baseline had no field to measure from', () => {
    expect(checkIsSoftKeyboardUp({ baselineSnapshot: buildSnapshot(0, { inputRect: null }), snapshot: buildSnapshot(350) })).toBe(false);
  });

  /*
   * The test the `@default` tag on `minimumKeyboardHeightInPixels` owes. Omitting the member must behave
   * exactly as passing the documented constant does, on both sides of the threshold.
   */
  it('should default the minimum lift to DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS', () => {
    const baselineSnapshot = buildSnapshot(0);
    const justUnder = buildSnapshot(DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS);
    const justOver = buildSnapshot(DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS + 1);

    expect(checkIsSoftKeyboardUp({ baselineSnapshot, snapshot: justUnder })).toBe(false);
    expect(checkIsSoftKeyboardUp({ baselineSnapshot, snapshot: justOver })).toBe(true);
    expect(checkIsSoftKeyboardUp({ baselineSnapshot, minimumKeyboardHeightInPixels: DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS, snapshot: justUnder })).toBe(false);
    expect(checkIsSoftKeyboardUp({ baselineSnapshot, minimumKeyboardHeightInPixels: DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS, snapshot: justOver })).toBe(true);
  });

  it('should honour a stricter minimum lift', () => {
    expect(checkIsSoftKeyboardUp({ baselineSnapshot: buildSnapshot(0), minimumKeyboardHeightInPixels: 400, snapshot: buildSnapshot(350) })).toBe(false);
  });

  /*
   * A rounding pixel is not a keyboard. This is exactly what the minimum exists to reject.
   */
  it('should not read a one-pixel shift as a keyboard', () => {
    expect(checkIsSoftKeyboardUp({ baselineSnapshot: buildSnapshot(0), snapshot: buildSnapshot(1) })).toBe(false);
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

describe('checkIsInputMethodShown', () => {
  it('should read mInputShown=true as a showing keyboard', () => {
    expect(checkIsInputMethodShown('mShowRequested=true | mInputShown=true | mHaveConnection=true')).toBe(true);
  });

  it('should read it at the start and at the end of the state', () => {
    expect(checkIsInputMethodShown('mInputShown=true')).toBe(true);
    expect(checkIsInputMethodShown('mShowRequested=true mInputShown=true')).toBe(true);
  });

  it('should read mInputShown=false as no keyboard', () => {
    expect(checkIsInputMethodShown('mShowRequested=false | mInputShown=false | mHaveConnection=true')).toBe(false);
  });

  /*
   * mIsInputViewShown is the IME's own view, which can linger while the IME is hidden; the question is
   * whether the IME is shown, which is mInputShown alone.
   */
  it('should not read a different field that happens to say shown', () => {
    expect(checkIsInputMethodShown('mInputShown=false mIsInputViewShown=true')).toBe(false);
  });

  it('should match the whole token only', () => {
    expect(checkIsInputMethodShown('mInputShown=true1')).toBe(false);
    expect(checkIsInputMethodShown('xmInputShown=true')).toBe(false);
  });

  it('should read an empty state as no keyboard', () => {
    expect(checkIsInputMethodShown('')).toBe(false);
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
      baselineSnapshot: buildSnapshot(0),
      inputMethodState: 'mInputShown=true',
      screenshotPath: 'F:/dist/screenshots/keyboard-not-raised.png',
      snapshot: buildSnapshot(50)
    });

    expect(message).toContain('F:/dist/screenshots/keyboard-not-raised.png');
    expect(message).toContain('innerHeight=800');
    expect(message).toContain('baselineInputTop=760');
    expect(message).toContain('inputTop=710');
    expect(message).toContain('lift=50');
    expect(message).toContain('device: mInputShown=true');
  });

  /*
   * The lift is the verdict, so a lift of zero is the one number worth a sentence. It used to be a hint
   * that the keyboard might have been up already; raiseSoftKeyboard now puts such a keyboard down before it
   * measures, so the sentence states what is left — and which half is left depends on the device.
   */
  it('should say a zero lift under a showing keyboard means the keyboard did not lift the field', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      baselineSnapshot: buildSnapshotAtTop(MEASURED_CENTERED_MODAL_TOP),
      inputMethodState: 'mInputShown=true | mIsInputViewShown=true',
      screenshotPath: 'a.png',
      snapshot: buildSnapshotAtTop(MEASURED_CENTERED_MODAL_TOP)
    });

    expect(message).toContain('lift=0');
    expect(message).toContain('not a keyboard left up by an earlier call');
    expect(message).toContain('the touch raised one and it did not lift this field');
    expect(message).not.toContain('If the device says');
  });

  it('should say a zero lift with no keyboard showing means the touch raised none', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      baselineSnapshot: buildSnapshotAtTop(MEASURED_CENTERED_MODAL_TOP),
      inputMethodState: 'mInputShown=false',
      screenshotPath: 'a.png',
      snapshot: buildSnapshotAtTop(MEASURED_CENTERED_MODAL_TOP)
    });

    expect(message).toContain('not a keyboard left up by an earlier call');
    expect(message).toContain('the touch raised none');
  });

  it('should not make the zero-lift statement when the field did move', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      baselineSnapshot: buildSnapshot(0),
      inputMethodState: 'mInputShown=true',
      screenshotPath: 'a.png',
      snapshot: buildSnapshot(50)
    });

    expect(message).not.toContain('did not move at all');
  });

  it('should say the field was gone rather than printing a number for it', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      baselineSnapshot: buildSnapshot(0),
      inputMethodState: 'mInputShown=false',
      screenshotPath: 'a.png',
      snapshot: buildSnapshot(0, { inputRect: null })
    });

    expect(message).toContain('inputTop=(no input)');
    expect(message).toContain('lift=(no input)');
  });

  /*
   * A baseline read with no field on screen is the other half of the same case, and it is the one that
   * decides whether the lift reads as absent or as zero — a zero would pull in the already-up sentence,
   * which is a claim about a measurement that was never taken.
   */
  it('should say the baseline field was gone rather than reading it as a lift of zero', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      baselineSnapshot: buildSnapshot(0, { inputRect: null }),
      inputMethodState: 'mInputShown=false',
      screenshotPath: 'a.png',
      snapshot: buildSnapshot(50)
    });

    expect(message).toContain('baselineInputTop=(no input)');
    expect(message).toContain('inputTop=710');
    expect(message).toContain('lift=(no input)');
    expect(message).not.toContain('did not move at all');
  });

  it('should say so when the device reported no input_method state at all', () => {
    const message = buildSoftKeyboardDiagnosticMessage({
      baselineSnapshot: buildSnapshot(0),
      inputMethodState: '',
      screenshotPath: 'a.png',
      snapshot: buildSnapshot(50)
    });

    expect(message).toContain('device: (no input_method state reported)');
  });
});
