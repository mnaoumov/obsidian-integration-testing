/**
 * @file
 *
 * Decides whether the Android soft keyboard is up, and where to touch to raise
 * it — from geometry alone.
 *
 * **Nothing in the page reports the keyboard.** `innerHeight`, `visualViewport`
 * and the modal container all stay at their full height with the keyboard shown
 * and `dumpsys input_method` reporting `mInputShown=true` — Obsidian Mobile keeps
 * a full-screen container and lifts its contents inside it. The only signal is
 * that the field *moves*, which is why the detection here is geometric rather
 * than an API call. Two runs failed on that before a framebuffer dump said so,
 * which is also why the diagnostic below exists.
 *
 * **The signal is a DELTA against a baseline read before the touch, not the
 * field's absolute offset from the bottom.** The absolute offset was the original
 * test and it is right only for a **bottom-anchored** field — a suggester, a
 * command palette — where "clear of the bottom" and "lifted" are the same
 * sentence. For a **centred modal** the condition is already true with no
 * keyboard at all, so the test passed vacuously and `raiseSoftKeyboard` returned
 * success having dispatched no touch (measured 2026-09-12 against a centred
 * prompt modal: the field's `top` read `352.4453125` before and after real taps
 * and the check said the keyboard was up both times). A delta is the same public
 * API for both shapes, and it costs a field that cannot move its verdict — see
 * {@link checkIsSoftKeyboardUp} for the one case that trades away.
 *
 * Pure and unit-tested; the touching and the capture live in `soft-keyboard`.
 */

/**
 * Parameters for {@link buildSoftKeyboardDiagnosticMessage}.
 */
export interface BuildSoftKeyboardDiagnosticMessageParams {
  /**
   * The geometry read before the first touch, which is what the verdict is measured against.
   */
  readonly baselineSnapshot: SoftKeyboardViewportSnapshot;

  /**
   * The lines of `dumpsys input_method` worth reading, as {@link parseInputMethodState} returned them.
   */
  readonly inputMethodState: string;

  /**
   * Where the device framebuffer was written, so the reader can look at what the device was showing.
   */
  readonly screenshotPath: string;

  /**
   * The geometry read after the last touch.
   */
  readonly snapshot: SoftKeyboardViewportSnapshot;
}

/**
 * Parameters for {@link checkIsSoftKeyboardUp}.
 */
export interface CheckIsSoftKeyboardUpParams {
  /**
   * The geometry read **before** the first touch, with the keyboard still down.
   *
   * Required, and deliberately not optional: an absent baseline could only mean falling back to the
   * absolute-offset test, which is the vacuous pass this parameter exists to make unrepresentable.
   */
  readonly baselineSnapshot: SoftKeyboardViewportSnapshot;

  /**
   * The least a raised keyboard lifts the field by, so a stray rounding pixel is not read as one.
   *
   * @default {@link DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS}
   */
  readonly minimumKeyboardHeightInPixels?: number;

  /**
   * The geometry to judge, read after the touch.
   */
  readonly snapshot: SoftKeyboardViewportSnapshot;
}

/**
 * A rectangle as the renderer reports it, in CSS pixels.
 */
export interface ElementRect {
  /**
   * The rectangle's height.
   */
  readonly height: number;

  /**
   * The distance from the viewport's left edge.
   */
  readonly left: number;

  /**
   * The distance from the viewport's top edge.
   */
  readonly top: number;

  /**
   * The rectangle's width.
   */
  readonly width: number;
}

/**
 * Parameters for {@link resolveSoftKeyboardTapPoints}.
 */
export interface ResolveSoftKeyboardTapPointsParams {
  /**
   * The geometry the tap is aimed from.
   */
  readonly snapshot: SoftKeyboardViewportSnapshot;
}

/**
 * A point on the device's screen, in device pixels.
 */
export interface SoftKeyboardTapPoint {
  /**
   * The distance from the screen's left edge.
   */
  readonly xInPixels: number;

  /**
   * The distance from the screen's top edge.
   */
  readonly yInPixels: number;
}

/**
 * What the renderer knows about its own geometry.
 */
export interface SoftKeyboardViewportSnapshot {
  /**
   * The ratio between CSS pixels and the device pixels `adb shell input tap` speaks in.
   */
  readonly devicePixelRatio: number;

  /**
   * The viewport's height in CSS pixels.
   *
   * Kept for the diagnostic as much as the decision: it does **not** shrink when the keyboard comes up.
   */
  readonly innerHeight: number;

  /**
   * The field's rect, which is what says whether the keyboard is up, or `null` when it is not on screen.
   */
  readonly inputRect: ElementRect | null;

  /**
   * The window's offset from the top of the screen, as the page understands it.
   */
  readonly screenY: number;
}

/**
 * The least a raised keyboard lifts the field by, so a stray rounding pixel is not read as one.
 *
 * Exported because it is the number both {@link checkIsSoftKeyboardUp} and `raiseSoftKeyboard` default to,
 * and a suite tightening it wants to say so relative to this rather than in the abstract.
 */
export const DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS = 100;

/**
 * The `dumpsys input_method` fields that say whether the IME is actually showing.
 */
const INPUT_METHOD_STATE_REG_EXP = /mInputShown|mIsInputViewShown|mHaveConnection|mShowRequested/;

/**
 * How many equal parts the field is split into to find its centre.
 */
const CENTER_DIVISOR = 2;

/**
 * Builds the message a failed raise reports.
 *
 * A bare "the keyboard did not come up" is unreadable — what the reader needs is what the page saw and what
 * the device thought, side by side, because the two disagreeing is the whole diagnosis. The page's half is
 * the lift and the two tops it came from, since the lift is the verdict; a lift of zero gets a sentence of
 * its own, being the one reading that an already-up keyboard also produces.
 *
 * @param params - The evidence gathered before the first touch and after the last one.
 * @returns The message, ready to throw.
 */
export function buildSoftKeyboardDiagnosticMessage(params: BuildSoftKeyboardDiagnosticMessageParams): string {
  const baselineTop = params.baselineSnapshot.inputRect?.top ?? null;
  const currentTop = params.snapshot.inputRect?.top ?? null;
  const lift = baselineTop === null || currentTop === null ? null : baselineTop - currentTop;

  const lines = [
    `raiseSoftKeyboard: the keyboard did not come up. Device framebuffer written to ${params.screenshotPath}.`,
    `page: innerHeight=${String(params.snapshot.innerHeight)} baselineInputTop=${formatMeasurement(baselineTop)} inputTop=${formatMeasurement(currentTop)} lift=${formatMeasurement(lift)}`,
    `device: ${params.inputMethodState || '(no input_method state reported)'}`
  ];

  if (lift === 0) {
    lines.push('The field did not move at all. If the device says the keyboard is showing, it was already up before the first touch — this check cannot tell that from a field that never lifts.');
  }

  return lines.join('\n');
}

/**
 * Decides whether the IME is up, from how far the field moved.
 *
 * The verdict is a **delta**: the field must have risen from where it sat before the touch, by at least
 * `minimumKeyboardHeightInPixels`. Obsidian Mobile lifts whatever is on screen to make room for the IME,
 * so a field that has not moved has had no keyboard arrive under it — whether it is a bottom-anchored
 * suggester or a centred modal.
 *
 * **The one case this gets wrong, deliberately:** a keyboard that was *already* up before the baseline was
 * read. The field has nowhere left to lift to, so the answer is `false`. No amount of geometry separates
 * that from a centred modal with no keyboard — both read as "clear of the bottom and not moving" — and of
 * the two possible wrong answers, a loud `false` is the one worth keeping: it fails a capture rather than
 * silently returning a screenshot of a keyboard that is not there. Read the baseline with the keyboard
 * down, which is what `raiseSoftKeyboard` does.
 *
 * @param params - The geometry before and after the touch, and how far the field must have lifted.
 * @returns Whether the field lifted far enough to have made room for a keyboard.
 */
export function checkIsSoftKeyboardUp(params: CheckIsSoftKeyboardUpParams): boolean {
  const baselineRect = params.baselineSnapshot.inputRect;
  const { inputRect } = params.snapshot;
  if (!baselineRect || !inputRect) {
    return false;
  }

  const minimumKeyboardHeightInPixels = params.minimumKeyboardHeightInPixels ?? DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS;
  return baselineRect.top - inputRect.top > minimumKeyboardHeightInPixels;
}

/**
 * Reduces `dumpsys input_method` to the handful of fields that say whether the IME is showing.
 *
 * @param dumpsysOutput - Raw stdout of `adb shell dumpsys input_method`.
 * @returns The interesting fields, trimmed and joined, or an empty string when none were reported.
 */
export function parseInputMethodState(dumpsysOutput: string): string {
  return dumpsysOutput
    .split('\n')
    .filter((line) => INPUT_METHOD_STATE_REG_EXP.test(line))
    .map((line) => line.trim())
    .join(' | ');
}

/**
 * Works out where to touch, in the device pixels `adb shell input tap` speaks.
 *
 * Two candidates, not one: the WebView may or may not start at the top of the screen, and the page cannot
 * tell which. Both land inside the field — it is taller than the offset — so a wrong guess costs one touch
 * rather than a mis-tap on whatever sits below.
 *
 * @param params - The geometry the tap is aimed from.
 * @returns The points to try, in order, or an empty array when the field is not on screen.
 */
export function resolveSoftKeyboardTapPoints(params: ResolveSoftKeyboardTapPointsParams): SoftKeyboardTapPoint[] {
  const { devicePixelRatio, inputRect, screenY } = params.snapshot;
  if (!inputRect) {
    return [];
  }

  const xInPixels = Math.round((inputRect.left + inputRect.width / CENTER_DIVISOR) * devicePixelRatio);
  const centerYInPixels = Math.round((inputRect.top + inputRect.height / CENTER_DIVISOR) * devicePixelRatio);
  const topOffsetInPixels = Math.round(screenY * devicePixelRatio);

  if (topOffsetInPixels === 0) {
    return [{ xInPixels, yInPixels: centerYInPixels }];
  }

  return [
    { xInPixels, yInPixels: centerYInPixels + topOffsetInPixels },
    { xInPixels, yInPixels: centerYInPixels }
  ];
}

/**
 * Formats a measurement for the diagnostic, saying so rather than printing a number when there was none.
 *
 * @param value - The measurement, or `null` when the field was not on screen to measure.
 * @returns The number as text, or `(no input)`.
 */
function formatMeasurement(value: null | number): string {
  return value === null ? '(no input)' : String(value);
}
