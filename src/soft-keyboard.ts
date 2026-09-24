/**
 * @file
 *
 * Raises the Android soft keyboard for a screenshot, and proves it came up.
 *
 * Two things have to be true, and the second is the one that is easy to miss:
 *
 * 1. The device must be allowed to draw a keyboard at all. The screenshot AVDs
 *    are built `hw.keyboard=yes`, so Android suppresses the on-screen one —
 *    `withSoftKeyboardEnabled` in `device-settings` is what lifts that.
 * 2. The IME must be *asked* for by a gesture. A field that takes focus
 *    programmatically does not get one: an Android WebView raises the IME on a
 *    real touch, and a run with the setting flipped and no touch comes back with
 *    exactly the empty band it had before. `adb shell input tap` is that gesture.
 *
 * 3. The proof that it arrived is that the field **moved**, measured against a
 *    baseline read here before the first touch. An absolute offset from the
 *    viewport bottom is the same test only for a bottom-anchored field; for a
 *    centred modal it is already true with no keyboard, which used to break the
 *    loop below before it had dispatched a single touch and return success
 *    having done nothing. Reading the baseline first also makes that shape
 *    unrepresentable rather than merely corrected: the delta of the baseline
 *    against itself is zero, so the first iteration always taps.
 *
 * 4. **That touch draws a selection handle when it lands inside TEXT**, and a
 *    device capture photographs it. Chromium shows the insertion handle on a tap
 *    into text and none on a tap into an EMPTY editable, and a value written by
 *    script raises none at all — so the field is emptied for the touch and its
 *    text written back afterwards. `obsidian-link-picker` shipped a teal handle
 *    in a store listing image twice before anyone worked out where it came from,
 *    and nothing in this module's own documentation of the touch hinted at it.
 *    See `shouldEmptyFieldForTouch`.
 *
 * The geometry that decides whether it worked is unit-tested in
 * `soft-keyboard-geometry`; everything here drives a real device, so the whole
 * module is integration-time code.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian on a real device) covered by integration tests, not unit tests. */

import {
  mkdirSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import type {
  ElementRect,
  SoftKeyboardTapPoint,
  SoftKeyboardViewportSnapshot
} from './soft-keyboard-geometry.ts';

import { runAdbText } from './adb.ts';
import { captureDeviceScreenshot } from './device-screenshot.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import {
  buildSoftKeyboardDiagnosticMessage,
  checkIsSoftKeyboardUp,
  parseInputMethodState,
  resolveSoftKeyboardTapPoints
} from './soft-keyboard-geometry.ts';

/**
 * Parameters for {@link raiseSoftKeyboard}.
 */
export interface RaiseSoftKeyboardParams {
  /**
   * The device to touch.
   */
  readonly deviceId: string;

  /**
   * Where a failed attempt writes the device framebuffer.
   *
   * When omitted, it is `dist/screenshots` under the working directory — resolved at load, so there is no
   * literal default to state here.
   */
  readonly diagnosticsDirectory?: string;

  /**
   * The CSS selector of the field to touch, e.g. `.prompt-input`.
   */
  readonly inputSelector: string;

  /**
   * The least a raised keyboard lifts the field by.
   *
   * When omitted, `DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS` from `soft-keyboard-geometry` applies.
   */
  readonly minimumKeyboardHeightInPixels?: number;

  /**
   * Whether to empty the field before the touch, and write its text back afterwards.
   *
   * **On by default, because the touch that raises the keyboard also draws a selection handle when it
   * lands inside TEXT.** Chromium shows the insertion handle on a tap into text and draws none on a tap
   * into an EMPTY editable, and a device capture photographs it — which is how `obsidian-link-picker`
   * shipped a teal handle in a store listing image twice before anyone understood where it came from. A
   * value written by script raises no handle, so emptying the field, touching it, and writing the text
   * back leaves the frame showing the same query with nothing hanging off it.
   *
   * Only an `<input>` or a `<textarea>` is emptied. A `contenteditable` holding text is REFUSED rather
   * than written to: its content usually belongs to an editor that owns its own DOM, and blanking that
   * by hand destroys it. Empty such a field yourself, or turn this off.
   *
   * Turning it off restores the pre-2026-09-23 behaviour exactly: the field is touched as it stands.
   *
   * @default true
   */
  readonly shouldEmptyFieldForTouch?: boolean;

  /**
   * The vault to read the geometry from. When omitted, the current test context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * Parameters for {@link tapDevice}.
 */
export interface TapDeviceParams {
  /**
   * The device to touch.
   */
  readonly deviceId: string;

  /**
   * Where to touch it.
   */
  readonly point: SoftKeyboardTapPoint;
}

/**
 * Where a failed attempt leaves its evidence — under `dist/`, which a plugin repo using this harness gitignores, like the capture scratch files.
 */
const DEFAULT_DIAGNOSTICS_DIRECTORY = join(process.cwd(), 'dist', 'screenshots');

/**
 * How long the IME takes to finish animating in, after which the layout has settled.
 */
const KEYBOARD_SETTLE_DELAY_IN_MILLISECONDS = 1500;

/**
 * What a field holds, and whether it is one this can put back.
 */
interface FieldContent {
  /**
   * Whether the field's value can be written — true for an `<input>` or a `<textarea>`, false for
   * anything else, whose content usually belongs to an editor that owns its own DOM.
   */
  readonly canWrite: boolean;

  /**
   * The text the field currently holds.
   */
  readonly text: string;
}

/**
 * Raises the on-screen keyboard with a real touch on a field, and confirms it came up.
 *
 * Call it inside `withSoftKeyboardEnabled` — the device setting alone does not raise the keyboard, and this
 * touch alone cannot while the setting suppresses it.
 *
 * **Call it with the keyboard DOWN.** The first read is the baseline every later read is compared against,
 * so a keyboard that is already up leaves the field nothing to lift by and this throws. That is the
 * deliberate trade for working on a centred modal as well as a bottom-anchored one — see
 * {@link checkIsSoftKeyboardUp}.
 *
 * **The field is EMPTIED for the touch and written back afterwards**, because a touch that lands inside
 * text draws Chromium's selection handle and the framebuffer photographs it — see
 * {@link RaiseSoftKeyboardParams.shouldEmptyFieldForTouch}, which turns that off.
 *
 * **The geometry returned is read with the field still empty**, and the text is written back after it.
 * That is the state the proven capture suites assert against, and it is deliberate rather than
 * incidental: the baseline is read AFTER the field is emptied, so the lift is measured between two reads
 * of the same field content. A field whose own text changes the layout around it — a suggester whose row
 * count answers the query — moves when it is cleared, and a delta measured across that move is not a
 * keyboard. Read the geometry again yourself if the restored text moves anything you are about to assert
 * on.
 *
 * @param params - The device, the field to touch, and how far it must lift.
 * @returns A {@link Promise} that resolves to the geometry read once the keyboard is up.
 * @throws Error if the field never matched, if it holds text this cannot empty and put back, or if it
 *   never lifted — the last after writing the device framebuffer and the device's own `input_method`
 *   state to the diagnostics directory.
 */
export async function raiseSoftKeyboard(params: RaiseSoftKeyboardParams): Promise<SoftKeyboardViewportSnapshot> {
  const textToRestore = await emptyFieldForTouch(params);

  try {
    return await tapUntilKeyboardIsUp(params);
  } finally {
    // Restored even when the raise failed: a caller that is about to read its own diagnostic should not
    // also have to discover that its query is gone.
    if (textToRestore !== null) {
      await writeFieldText(params, textToRestore);
    }
  }
}

/**
 * Touches the device at a point, the way a thumb would.
 *
 * @param params - The device and where to touch it.
 * @returns A {@link Promise} that resolves once the touch has been dispatched.
 */
export async function tapDevice(params: TapDeviceParams): Promise<void> {
  await runAdbText({
    commandArguments: ['shell', 'input', 'tap', String(params.point.xInPixels), String(params.point.yInPixels)],
    deviceId: params.deviceId
  });
}

/**
 * Writes the device framebuffer and reads the device's `input_method` state, then composes the failure.
 *
 * @param params - The device and the diagnostics directory.
 * @param baselineSnapshot - The geometry read before the first touch, which the verdict is measured against.
 * @param snapshot - The geometry read after the last touch.
 * @returns A {@link Promise} that resolves to the message to throw.
 */
async function buildFailureMessage(
  params: RaiseSoftKeyboardParams,
  baselineSnapshot: SoftKeyboardViewportSnapshot,
  snapshot: SoftKeyboardViewportSnapshot
): Promise<string> {
  const diagnosticsDirectory = params.diagnosticsDirectory ?? DEFAULT_DIAGNOSTICS_DIRECTORY;
  mkdirSync(diagnosticsDirectory, { recursive: true });

  const screenshotPath = join(diagnosticsDirectory, 'keyboard-not-raised.png');
  writeFileSync(screenshotPath, await captureDeviceScreenshot({ deviceId: params.deviceId }));

  const dumpsysOutput = await runAdbText({
    commandArguments: ['shell', 'dumpsys', 'input_method'],
    deviceId: params.deviceId
  });

  return buildSoftKeyboardDiagnosticMessage({
    baselineSnapshot,
    inputMethodState: parseInputMethodState(dumpsysOutput),
    screenshotPath,
    snapshot
  });
}

/**
 * Empties the field the touch is about to land on, and reports what to write back.
 *
 * @param params - The field to empty, and whether to empty it at all.
 * @returns A {@link Promise} that resolves to the text to restore, or `null` when nothing was emptied.
 * @throws Error if the field holds text that cannot be written back — a `contenteditable`, whose content
 *   belongs to an editor that owns its own DOM.
 */
async function emptyFieldForTouch(params: RaiseSoftKeyboardParams): Promise<null | string> {
  if (params.shouldEmptyFieldForTouch === false) {
    return null;
  }

  const content = await readFieldContent(params);

  // Nothing matched. The geometry read does the reporting, with the message it always had.
  if (!content || content.text === '') {
    return null;
  }

  if (!content.canWrite) {
    throw new Error(
      `raiseSoftKeyboard: "${params.inputSelector}" holds text but is not an <input> or a <textarea>, so it `
        + 'cannot be emptied for the touch and written back. The touch would land inside text and draw a '
        + 'selection handle, which a device capture photographs. Empty the field yourself before calling, or '
        + 'pass shouldEmptyFieldForTouch: false to touch it as it stands.'
    );
  }

  await writeFieldText(params, '');

  return content.text;
}

/**
 * Reads what the field holds, and whether it is one whose value can be written back.
 *
 * @param params - The field to read.
 * @returns A {@link Promise} that resolves to the content, or `null` when nothing matched the selector.
 */
async function readFieldContent(params: RaiseSoftKeyboardParams): Promise<FieldContent | null> {
  return await evalInObsidian({
    callback({ inputSelector }): FieldContent | null {
      const element = document.querySelector(inputSelector);

      if (!element) {
        return null;
      }

      const canWrite = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

      return { canWrite, text: canWrite ? element.value : element.textContent };
    },
    input: { inputSelector: params.inputSelector },
    ...(params.vaultPath !== undefined && { vaultPath: params.vaultPath })
  });
}

/**
 * Reads what the renderer knows about its own geometry.
 *
 * @param params - The field to measure and the vault to read it from.
 * @returns A {@link Promise} that resolves to the viewport and the field's rect, in CSS pixels.
 */
async function readSoftKeyboardViewport(params: RaiseSoftKeyboardParams): Promise<SoftKeyboardViewportSnapshot> {
  return await evalInObsidian({
    callback({ inputSelector }): SoftKeyboardViewportSnapshot {
      const inputEl = document.querySelector(inputSelector);

      // eslint-disable-next-line unicorn/consistent-function-scoping -- This closure is serialized and evaluated in the renderer, so a helper hoisted to module scope would not exist there.
      function toRect(rect: DOMRect): ElementRect {
        return {
          height: rect.height,
          left: rect.left,
          top: rect.top,
          width: rect.width
        };
      }

      return {
        devicePixelRatio: window.devicePixelRatio,
        innerHeight: window.innerHeight,
        inputRect: inputEl ? toRect(inputEl.getBoundingClientRect()) : null,
        screenY: window.screenY
      };
    },
    input: { inputSelector: params.inputSelector },
    ...(params.vaultPath !== undefined && { vaultPath: params.vaultPath })
  });
}

/**
 * Touches the field until the keyboard is up, and says so when it never came.
 *
 * The baseline is read here rather than by the caller, so it is read with the field in the state the
 * taps are dispatched against — see {@link raiseSoftKeyboard} for why the two have to match.
 *
 * @param params - The device, the field to touch, and how far it must lift.
 * @returns A {@link Promise} that resolves to the geometry read once the keyboard is up.
 * @throws Error if the field never matched, or if it never lifted.
 */
async function tapUntilKeyboardIsUp(params: RaiseSoftKeyboardParams): Promise<SoftKeyboardViewportSnapshot> {
  const baselineSnapshot = await readSoftKeyboardViewport(params);
  let snapshot = baselineSnapshot;

  if (!snapshot.inputRect) {
    throw new Error(`raiseSoftKeyboard: nothing matches "${params.inputSelector}", so there is no field to touch.`);
  }

  for (const point of resolveSoftKeyboardTapPoints({ snapshot })) {
    if (checkIsUp(snapshot)) {
      break;
    }

    await tapDevice({ deviceId: params.deviceId, point });
    await sleep(KEYBOARD_SETTLE_DELAY_IN_MILLISECONDS);
    snapshot = await readSoftKeyboardViewport(params);
  }

  if (!checkIsUp(snapshot)) {
    throw new Error(await buildFailureMessage(params, baselineSnapshot, snapshot));
  }

  return snapshot;

  function checkIsUp(current: SoftKeyboardViewportSnapshot): boolean {
    return checkIsSoftKeyboardUp({
      baselineSnapshot,
      ...(params.minimumKeyboardHeightInPixels !== undefined && { minimumKeyboardHeightInPixels: params.minimumKeyboardHeightInPixels }),
      snapshot: current
    });
  }
}

/**
 * Writes a field's value and tells the page it changed.
 *
 * The `input` event is what a scripted write owes the page: without it a suggester keeps the rows it had
 * for the text that is no longer there. It bubbles, because that is how a framework listening on a
 * container hears it.
 *
 * @param params - The field to write.
 * @param text - What to write into it.
 * @returns A {@link Promise} that resolves once the write has been made.
 * @throws TypeError if the field is not one whose value can be written.
 */
async function writeFieldText(params: RaiseSoftKeyboardParams, text: string): Promise<void> {
  await evalInObsidian({
    callback({ inputSelector, text: value }): void {
      const element = document.querySelector(inputSelector);

      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        throw new TypeError(`raiseSoftKeyboard: "${inputSelector}" is not a field whose value can be written.`);
      }

      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    },
    input: { inputSelector: params.inputSelector, text },
    ...(params.vaultPath !== undefined && { vaultPath: params.vaultPath })
  });
}

/* v8 ignore stop */
