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
 * the field's own offset from the bottom, which is why the detection here is
 * geometric rather than an API call. Two runs failed on that before a framebuffer
 * dump said so, which is also why the diagnostic below exists.
 *
 * Pure and unit-tested; the touching and the capture live in `soft-keyboard`.
 */

/**
 * Parameters for {@link buildSoftKeyboardDiagnosticMessage}.
 */
export interface BuildSoftKeyboardDiagnosticMessageParams {
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
   * The least a raised keyboard lifts the field by, so a stray rounding pixel is not read as one.
   *
   * @default {@link DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS}
   */
  readonly minimumKeyboardHeightInPixels?: number;

  /**
   * The geometry to judge.
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
 * the device thought, side by side, because the two disagreeing is the whole diagnosis.
 *
 * @param params - The evidence gathered after the last touch.
 * @returns The message, ready to throw.
 */
export function buildSoftKeyboardDiagnosticMessage(params: BuildSoftKeyboardDiagnosticMessageParams): string {
  const { inputRect } = params.snapshot;
  const inputBottom = inputRect ? inputRect.top + inputRect.height : null;

  return [
    `raiseSoftKeyboard: the keyboard did not come up. Device framebuffer written to ${params.screenshotPath}.`,
    `page: innerHeight=${String(params.snapshot.innerHeight)} inputBottom=${inputBottom === null ? '(no input)' : String(inputBottom)}`,
    `device: ${params.inputMethodState || '(no input_method state reported)'}`
  ].join('\n');
}

/**
 * Decides whether the IME is up, from the page's own geometry.
 *
 * @param params - The geometry to judge, and how far the field must have lifted.
 * @returns Whether the field has stopped short of the bottom to make room for a keyboard.
 */
export function checkIsSoftKeyboardUp(params: CheckIsSoftKeyboardUpParams): boolean {
  const { inputRect } = params.snapshot;
  if (!inputRect) {
    return false;
  }

  const minimumKeyboardHeightInPixels = params.minimumKeyboardHeightInPixels ?? DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS;
  return params.snapshot.innerHeight - (inputRect.top + inputRect.height) > minimumKeyboardHeightInPixels;
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
