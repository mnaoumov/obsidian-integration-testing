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
 *    **A keyboard ALREADY up is put down first**, because a delta cannot see
 *    one: the field has already lifted, so it reads as a field that never moved.
 *    That was every frame after the first of a suite that takes several — the
 *    keyboard left up by one frame, or brought back by Obsidian focusing the
 *    next modal's field, made the next baseline already-lifted (measured
 *    2026-09-20: frames 2-5 each failed `lift=0` beside `mInputShown=true`,
 *    each framebuffer showing a correctly lifted field under a fully drawn
 *    keyboard). The alternative was to accept `lift=0` whenever the device says
 *    a keyboard is showing, and it was refused: that is a frame the helper did
 *    not prove, which is the vacuous pass the delta was introduced to end,
 *    re-opened by a different door. So the device is asked, a showing IME is
 *    retracted with `KEYCODE_BACK`, and the lift is proved as before. It has to
 *    happen HERE, not after the previous capture: lowering it there was tried,
 *    and the IME came back on its own before the next baseline was read.
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
 *    **And the text written back has to be HELD, not just written.** The IME's input connection started from
 *    the emptied field, and about one time in five it wrote that empty state back over the harness's write,
 *    so the capture straight after showed the placeholder. The field is re-read until it holds, and written
 *    again when it does not.
 *
 * 5. **Gboard's suggestion strip is a second race, and parking the caret at offset 0 ends it.** With the
 *    keyboard up, Gboard draws either its toolbar (apps, stickers, GIF, clipboard, settings, theme, mic) or word
 *    predictions for the text before the caret. The touch landed on the emptied field, which gets the toolbar,
 *    and the write-back puts the caret at the end of the text, which gets predictions — once Gboard hears about
 *    it, which is a matter of timing. The predictions themselves come from the keyboard's learned dictionary
 *    and differ between runs. So a capture showed one of two strips, and two different sets of predictions
 *    when it showed the second. Suggestions cannot be switched off from the page: Obsidian's `.prompt-input`
 *    already carries `spellcheck="false"`, and the IME already receives `TYPE_TEXT_FLAG_NO_SUGGESTIONS`
 *    (`inputType=0x2080a1`). Gboard still predicts (measured 2026-09-25). With the caret at offset 0 there is
 *    no text before it, which is the empty-field state, so whichever way the race goes, the strip is the
 *    toolbar. See `shouldPinKeyboardToolbar`.
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

import type { HoldFieldTextResult } from './field-text-hold.ts';
import type {
  ElementRect,
  SoftKeyboardTapPoint,
  SoftKeyboardViewportSnapshot
} from './soft-keyboard-geometry.ts';

import { runAdbText } from './adb.ts';
import { captureDeviceScreenshot } from './device-screenshot.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { holdFieldText } from './field-text-hold.ts';
import { log } from './log.ts';
import {
  buildSoftKeyboardDiagnosticMessage,
  checkIsInputMethodShown,
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
   * Whether to park the caret at offset 0 once the keyboard is up, so Gboard's suggestion strip shows its
   * toolbar rather than word predictions.
   *
   * **On by default, because the strip is otherwise a race between two states, and one of them varies.**
   * Gboard shows its toolbar while nothing sits before the caret, and predictions for the word before it
   * otherwise. The touch lands on the emptied field (toolbar). The write-back leaves the caret after the text
   * (predictions), but only once Gboard has processed that update. And the predictions come from the
   * keyboard's learned dictionary, so they differ from one run to the next. With the caret at offset 0 both
   * outcomes of the race are the toolbar: measured 2026-09-25, six raises with the caret parked all gave
   * byte-identical strip rows showing the toolbar, while the same field with the caret at the end showed
   * `multiple` / `multiples` / `multiplex`.
   *
   * Turning suggestions off does not do this. Obsidian's prompt input already has `spellcheck="false"`,
   * and the IME already receives `TYPE_TEXT_FLAG_NO_SUGGESTIONS`, yet Gboard still predicts.
   *
   * Only an `<input>` or a `<textarea>` is parked; any other field is left as it is. The caret is visible at
   * offset 0 unless the capture hides it, which a device capture has to ask for with `hideCaret`.
   *
   * Turning it off leaves the caret where the write-back or the touch put it.
   *
   * @default true
   */
  readonly shouldPinKeyboardToolbar?: boolean;

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
 * How long the IME takes to finish animating out after `KEYCODE_BACK`, measured in the capture suite this
 * was moved out of.
 */
const KEYBOARD_RETRACT_DELAY_IN_MILLISECONDS = 900;

/**
 * How many times `KEYCODE_BACK` is pressed before a keyboard that will not go down is reported.
 *
 * Two, because the first press can land while the IME is still animating UP from the focus that raised
 * it, and an IME mid-animation swallows the key without retracting.
 */
const KEYBOARD_RETRACT_ATTEMPT_COUNT = 2;

/**
 * How long a keyboard reported showing is watched before `KEYCODE_BACK` is pressed at it.
 *
 * One retract animation: an IME already on its way down — the modal that raised it has just closed — is
 * still reported showing by a read taken at the start of its retract, and is gone by the end of it. Pressing
 * at the first read then lands the key on the app instead, which closes the modal the frame is about to
 * photograph. Two reads that agree across this window say the keyboard is staying up.
 */
const KEYBOARD_SHOWN_CONFIRMATION_DELAY_IN_MILLISECONDS = KEYBOARD_RETRACT_DELAY_IN_MILLISECONDS;

/**
 * How many times the caret is parked at offset 0 before a caret that will not stay there is reported.
 */
const CARET_PARK_ATTEMPT_COUNT = 3;

/**
 * How long a parked caret is left before it is read back — long enough for the IME to answer the selection
 * change, which is what would move it again.
 */
const CARET_PARK_CONFIRMATION_DELAY_IN_MILLISECONDS = 300;

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
 * Where a field's caret is, as the selection offsets an `<input>` or a `<textarea>` reports.
 */
interface FieldSelection {
  /**
   * Where the selection ends.
   */
  readonly selectionEnd: null | number;

  /**
   * Where the selection starts.
   */
  readonly selectionStart: null | number;
}

/**
 * Raises the on-screen keyboard with a real touch on a field, and confirms it came up.
 *
 * Call it inside `withSoftKeyboardEnabled` — the device setting alone does not raise the keyboard, and this
 * touch alone cannot while the setting suppresses it.
 *
 * **A keyboard that is already up is put DOWN first.** The first geometry read is the baseline every later
 * read is compared against, so a keyboard already up would leave the field nothing to lift by and read as
 * one that never came. The device is asked before anything else, and a showing IME is retracted with
 * `KEYCODE_BACK` — asked FIRST because, with no IME showing, that key reaches the app and closes the very
 * modal the frame is about to photograph. So the helper is safe to call once per frame of a multi-frame
 * suite, and every call still proves its own lift. The other answer — accepting a zero lift whenever the
 * device reports a keyboard — was refused, because it accepts a frame the helper did not prove.
 *
 * **The field is EMPTIED for the touch and written back afterwards**, because a touch that lands inside
 * text draws Chromium's selection handle and the framebuffer photographs it — see
 * {@link RaiseSoftKeyboardParams.shouldEmptyFieldForTouch}, which turns that off.
 *
 * **The caret is then parked at offset 0**, so Gboard's suggestion strip is its toolbar rather than word
 * predictions that race the write-back and vary between runs — see
 * {@link RaiseSoftKeyboardParams.shouldPinKeyboardToolbar}, which turns that off.
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
 * @throws Error if the selector matches more than one element — the harness would empty one field while the
 *   touch landed on another — if a keyboard already up would not go down, if the field never matched, if it holds text
 *   this cannot empty and put back, if it never lifted — after writing the device framebuffer and the
 *   device's own `input_method` state to the diagnostics directory — if the text written back would not
 *   stay in the field, or if the caret would not stay at offset 0. A write-back the IME undoes is written
 *   again until it holds; see `restoreFieldText`.
 */
export async function raiseSoftKeyboard(params: RaiseSoftKeyboardParams): Promise<SoftKeyboardViewportSnapshot> {
  await assertFieldIsUnambiguous(params);
  await lowerSoftKeyboardIfShown(params);

  const textToRestore = await emptyFieldForTouch(params);

  let snapshot: SoftKeyboardViewportSnapshot;

  try {
    snapshot = await tapUntilKeyboardIsUp(params);
  } catch (error) {
    // Restored even when the raise failed: a caller that is about to read its own diagnostic should not
    // also have to discover that its query is gone. Best-effort, so the raise's own error is the one thrown.
    if (textToRestore !== null) {
      await holdFieldTextBestEffort(params, textToRestore);
    }

    throw error;
  }

  if (textToRestore !== null) {
    await restoreFieldText(params, textToRestore);
  }

  if (params.shouldPinKeyboardToolbar !== false) {
    await parkCaretAtStart(params);
  }

  return snapshot;
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
 * Refuses a selector that matches more than one element, before anything is touched.
 *
 * Every step of the raise addresses the field through `document.querySelector`, which is the FIRST match in
 * document order: the emptying, the geometry the tap point comes from, the write-back and the caret park. The
 * device's touch lands on whatever is drawn on top at that point, which for two stacked modals is the LAST
 * one. So the harness emptied one field and the touch landed inside the other one's text, and Chromium drew
 * its insertion handle into the frame. That is the defect the emptying exists to prevent, arriving with no
 * error. Measured 2026-09-25: a probe that opened each fresh `SuggestModal` without closing the previous
 * one drew the handle on every raise after the first.
 *
 * @param params - The field to look for.
 * @returns A {@link Promise} that resolves when the selector matches at most one element. No match is left to
 *   the geometry read, which reports it with its own message.
 * @throws Error if the selector matches more than one element.
 */
async function assertFieldIsUnambiguous(params: RaiseSoftKeyboardParams): Promise<void> {
  const matchCount = await evalInObsidian({
    callback({ inputSelector }): number {
      return document.querySelectorAll(inputSelector).length;
    },
    input: { inputSelector: params.inputSelector },
    ...(params.vaultPath !== undefined && { vaultPath: params.vaultPath })
  });

  if (matchCount > 1) {
    throw new Error(
      `raiseSoftKeyboard: "${params.inputSelector}" matches ${String(matchCount)} elements, so the field the harness empties and `
        + 'measures (the first match) need not be the one the touch lands on (the one drawn on top). A touch that lands inside '
        + 'the other field\'s text draws a selection handle, which a device capture photographs. Close the UI left behind, '
        + 'or pass a selector that matches only the field to raise the keyboard on.'
    );
  }
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

  return buildSoftKeyboardDiagnosticMessage({
    baselineSnapshot,
    inputMethodState: await readInputMethodState(params),
    screenshotPath,
    snapshot
  });
}

/**
 * Whether anything in the page matches the field's selector.
 *
 * @param params - The field to look for.
 * @returns A {@link Promise} that resolves to whether it matched.
 */
async function checkIsFieldPresent(params: RaiseSoftKeyboardParams): Promise<boolean> {
  return await evalInObsidian({
    callback({ inputSelector }): boolean {
      return document.querySelector(inputSelector) !== null;
    },
    input: { inputSelector: params.inputSelector },
    ...(params.vaultPath !== undefined && { vaultPath: params.vaultPath })
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
 * Holds the text in the field without ever throwing — the restore on a raise that already failed.
 *
 * @param params - The field to write.
 * @param text - What it must hold.
 * @returns A {@link Promise} that resolves once the hold has run, whatever it found.
 */
async function holdFieldTextBestEffort(params: RaiseSoftKeyboardParams, text: string): Promise<void> {
  try {
    await holdTextInField(params, text);
  } catch {
    // The raise's own failure is what the caller needs to see; a field that is gone as well adds nothing to it.
  }
}

/**
 * Writes the text into the field and holds it there, per {@link holdFieldText}.
 *
 * @param params - The field to write.
 * @param text - What it must hold.
 * @returns A {@link Promise} that resolves to what the hold found.
 */
async function holdTextInField(params: RaiseSoftKeyboardParams, text: string): Promise<HoldFieldTextResult> {
  return await holdFieldText({
    expectedText: text,
    async readText(): Promise<null | string> {
      const content = await readFieldContent(params);
      return content?.text ?? null;
    },
    sleep,
    async writeText(value: string): Promise<void> {
      await writeFieldText(params, value);
    }
  });
}

/**
 * Puts the keyboard down when the device reports one showing, so the baseline read next is one the touch
 * can lift the field from.
 *
 * **A keyboard is pressed at only once it has been reported showing TWICE, one retract animation apart.**
 * `KEYCODE_BACK` is retracted by the IME only while the IME is up; once it has gone, the key reaches the
 * app, and Obsidian closes the modal on screen — the one the caller is about to photograph. A keyboard
 * already on its way down (the modal that raised it has just closed, and the caller opened a fresh one
 * straight after) is still reported showing at the start of its retract, so pressing at the first read
 * raced it. It is watched for one retract animation first, and a keyboard that went down on its own is
 * left alone.
 *
 * **And a press that reached the app anyway is named as that.** The field is looked up before the press
 * and after it; one that matched before and not after was closed by the key, and saying so beats the
 * `nothing matches` that the raise would otherwise report a step later, about a selector that was right.
 *
 * @param params - The device to ask, and the field that must survive the press.
 * @returns A {@link Promise} that resolves once no keyboard is showing.
 * @throws Error if a keyboard is still showing after {@link KEYBOARD_RETRACT_ATTEMPT_COUNT} presses of
 *   `KEYCODE_BACK` — the raise that follows could prove nothing, and its own failure would blame a keyboard
 *   that never came when the truth is one that never left — or if a press closed the field's own UI.
 */
async function lowerSoftKeyboardIfShown(params: RaiseSoftKeyboardParams): Promise<void> {
  let inputMethodState = await readInputMethodState(params);

  for (let attempt = 0; attempt < KEYBOARD_RETRACT_ATTEMPT_COUNT; attempt++) {
    if (!checkIsInputMethodShown(inputMethodState)) {
      return;
    }

    await sleep(KEYBOARD_SHOWN_CONFIRMATION_DELAY_IN_MILLISECONDS);
    inputMethodState = await readInputMethodState(params);

    if (!checkIsInputMethodShown(inputMethodState)) {
      return;
    }

    const isFieldPresentBeforePress = await checkIsFieldPresent(params);
    await runAdbText({
      commandArguments: ['shell', 'input', 'keyevent', 'KEYCODE_BACK'],
      deviceId: params.deviceId
    });
    await sleep(KEYBOARD_RETRACT_DELAY_IN_MILLISECONDS);

    if (isFieldPresentBeforePress && !await checkIsFieldPresent(params)) {
      throw new Error(
        'raiseSoftKeyboard: KEYCODE_BACK, pressed to put down a keyboard the device reported showing, reached the app instead and '
          + `closed the UI holding "${params.inputSelector}" — it matched before the press and matches nothing after it. The `
          + 'keyboard went down between the last read and the press. Let the previous keyboard settle before opening the UI '
          + `to raise it on.
device before the press: ${inputMethodState}`
      );
    }

    inputMethodState = await readInputMethodState(params);
  }

  if (checkIsInputMethodShown(inputMethodState)) {
    throw new Error(
      `raiseSoftKeyboard: a keyboard was already up and did not go down after ${String(KEYBOARD_RETRACT_ATTEMPT_COUNT)} presses of `
        + 'KEYCODE_BACK, so the lift that proves a raise could not be measured. The field would read as one that never '
        + `moved under a keyboard that is plainly showing.
device: ${inputMethodState}`
    );
  }
}

/**
 * Parks the field's caret at offset 0, and does not return until it has stayed there.
 *
 * Read back after {@link CARET_PARK_CONFIRMATION_DELAY_IN_MILLISECONDS}, and parked again when it moved: the IME
 * answers a selection change, and a caret it moved back to the end would bring the predictions back with it.
 *
 * @param params - The field whose caret to park.
 * @returns A {@link Promise} that resolves once the caret has stayed at offset 0, or at once for a field that
 *   is not an `<input>` or a `<textarea>`.
 * @throws Error if the caret did not stay at offset 0 after {@link CARET_PARK_ATTEMPT_COUNT} attempts.
 */
async function parkCaretAtStart(params: RaiseSoftKeyboardParams): Promise<void> {
  const selections: (FieldSelection | null)[] = [];

  for (let attempt = 0; attempt < CARET_PARK_ATTEMPT_COUNT; attempt++) {
    const isParked = await evalInObsidian({
      callback({ inputSelector }): boolean {
        const element = document.querySelector(inputSelector);

        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
          return false;
        }

        element.setSelectionRange(0, 0);
        return true;
      },
      input: { inputSelector: params.inputSelector },
      ...(params.vaultPath !== undefined && { vaultPath: params.vaultPath })
    });

    if (!isParked) {
      return;
    }

    await sleep(CARET_PARK_CONFIRMATION_DELAY_IN_MILLISECONDS);
    const selection = await readFieldSelection(params);
    selections.push(selection);

    if (selection?.selectionStart === 0 && selection.selectionEnd === 0) {
      return;
    }
  }

  throw new Error(
    `raiseSoftKeyboard: the caret parked at offset 0 in "${params.inputSelector}" did not stay there, so Gboard's `
      + `strip would show word predictions rather than its toolbar. ${String(CARET_PARK_ATTEMPT_COUNT)} attempt(s); `
      + `the field read ${JSON.stringify(selections)}. Pass shouldPinKeyboardToolbar: false to leave the caret alone.
device: ${await readInputMethodState(params)}`
  );
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
 * Reads where the field's caret is.
 *
 * @param params - The field to read.
 * @returns A {@link Promise} that resolves to the selection, or `null` when nothing writable matched.
 */
async function readFieldSelection(params: RaiseSoftKeyboardParams): Promise<FieldSelection | null> {
  return await evalInObsidian({
    callback({ inputSelector }): FieldSelection | null {
      const element = document.querySelector(inputSelector);

      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? { selectionEnd: element.selectionEnd, selectionStart: element.selectionStart }
        : null;
    },
    input: { inputSelector: params.inputSelector },
    ...(params.vaultPath !== undefined && { vaultPath: params.vaultPath })
  });
}

/**
 * Asks the device what its IME is doing — the only place that knows, since nothing in the page reports it.
 *
 * @param params - The device to ask.
 * @returns A {@link Promise} that resolves to the fields {@link parseInputMethodState} keeps.
 */
async function readInputMethodState(params: RaiseSoftKeyboardParams): Promise<string> {
  const dumpsysOutput = await runAdbText({
    commandArguments: ['shell', 'dumpsys', 'input_method'],
    deviceId: params.deviceId
  });

  return parseInputMethodState(dumpsysOutput);
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
 * Writes the emptied field's text back, and does not return until it has stayed there.
 *
 * **Writing it once is not enough.** The touch that raised the keyboard landed on the EMPTY field, so the
 * IME's input connection started from an empty field, and about one time in five a later update from it wrote
 * that empty state back over this write (measured 2026-09-25 in `obsidian-alias-quick-switcher`'s capture
 * suite: 2 of 10 frames showed the placeholder, while the Gboard strip still offered the word that had been
 * written). The capture taken straight after photographed the empty field, and nothing said so. So the field is
 * re-read until several reads agree, and written again whenever one does not.
 *
 * @param params - The field to write, and the device to ask about its IME when the text will not hold.
 * @param text - What the field held before it was emptied.
 * @returns A {@link Promise} that resolves once the text has held.
 * @throws Error if the text did not hold after every rewrite, or the field went away — naming every read and
 *   the device's `input_method` state, rather than returning with the field silently empty.
 */
async function restoreFieldText(params: RaiseSoftKeyboardParams, text: string): Promise<void> {
  const result = await holdTextInField(params, text);

  if (result.writeCount > 1) {
    log(
      `[soft-keyboard] The text written back into "${params.inputSelector}" was lost ${String(result.writeCount - 1)} time(s) `
        + `and written again; reads: ${JSON.stringify(result.readTexts)}.`
    );
  }

  if (!result.isHeld) {
    throw new Error(
      `raiseSoftKeyboard: the text written back into "${params.inputSelector}" after the touch did not stay there. `
        + `Expected ${JSON.stringify(text)}; ${String(result.writeCount)} write(s), and the field read `
        + `${JSON.stringify(result.readTexts)}. A capture taken now would show the field without its text.
device: ${await readInputMethodState(params)}`
    );
  }
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
