/**
 * @file
 *
 * The integration coverage for `raiseSoftKeyboard`'s field emptying (**L54**, **L65**): the field is emptied
 * for the touch that raises the keyboard, and its text is written back afterwards — including when the raise
 * fails — unless `shouldEmptyFieldForTouch: false` asks for the field to be touched as it stands — and the
 * caret parked at offset 0 afterwards, so Gboard's suggestion strip is the same toolbar on every raise.
 *
 * Every line of `src/soft-keyboard.ts` is inside a `v8 ignore` block, and until this file the touching had
 * only ever been proved from a consumer's capture suite. The emptying is the step that most needs proving
 * here, because a regression in it is silent in the renderer: a field that is never emptied still raises a
 * keyboard, and a field that is never restored still reads as a capture that succeeded.
 *
 * What is asserted is what the renderer can see. The field records its own value at the moment the device's
 * touch arrives (`touchstart`, which only a real `adb shell input tap` produces here) and at every `input`
 * event, so "emptied for the touch" is observed rather than inferred from the final value. The selection
 * handle the emptying exists to prevent is NOT asserted: it is a system-drawn layer, so proving its absence
 * stays a framebuffer diff in a capture suite.
 *
 * The field is the `.prompt-input` of a `SuggestModal` the suite opens itself — the bottom-anchored shape
 * every proven capture suite raises the keyboard on, closed again after each test.
 *
 * Runs in its own Vitest project (`integration-tests:android`) against a real emulator via Appium. It is
 * deliberately NOT part of the default `integration-tests` aggregate, which is desktop.
 */

import type { Modal } from 'obsidian';

import {
  mkdtempSync,
  writeFileSync
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from 'vitest';

import type { SharpRawResult } from './sharp-loader.ts';

import { runAdbText } from './adb.ts';
import { ContextId } from './context-id.ts';
import { captureDeviceScreenshot } from './device-screenshot.ts';
import { withSoftKeyboardEnabled } from './device-settings.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { hideCaret } from './hide-caret.ts';
import { resolveEmulatorDeviceId } from './resolve-emulator-device-id.ts';
import { importSharp } from './sharp-loader.ts';
import {
  checkIsInputMethodShown,
  parseInputMethodState
} from './soft-keyboard-geometry.ts';
import { raiseSoftKeyboard } from './soft-keyboard.ts';
import { TemporaryVault } from './temporary-vault.ts';

/*
 * The same budget the other Android suites carry: 240s of emulator boot and Appium session, plus the 120s
 * the network-ready gate (L45) can add on a guest that never reports a validated default network.
 */
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 360_000;

/*
 * A raise costs a keyboard retract (up to ~2s), one or two touches with a 1.5s settle each, and a handful of
 * evals; a failed one adds a framebuffer capture and a `dumpsys`. 120s is the other suites' figure and
 * covers it with room.
 */
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

/**
 * The AVD `scripts/android-transport-setup.ts` points this project at. The device has to be addressed by
 * name rather than by position: a physical phone is routinely attached to the machines this runs on.
 */
const AVD_NAME = 'obsidian_test';

/**
 * The class the probe modal's input carries, so the selector matches this suite's field and nothing else.
 */
const PROBE_INPUT_CLASS = 'soft-keyboard-probe-input';

const PROBE_INPUT_SELECTOR = `.${PROBE_INPUT_CLASS}`;

/**
 * The text the field holds when the raise starts — what the emptying must remove and the restore put back.
 */
const QUERY_TEXT = 'note';

/**
 * A lift no keyboard can produce, which makes a raise fail deterministically after it has touched the field.
 */
const UNREACHABLE_KEYBOARD_HEIGHT_IN_PIXELS = 100_000;

/**
 * How long a keyboard is given to go down with the modal that raised it, and how often that is checked.
 */
const KEYBOARD_SETTLE_TIMEOUT_IN_MILLISECONDS = 10_000;
const KEYBOARD_SETTLE_POLL_INTERVAL_IN_MILLISECONDS = 250;

/**
 * The gaps between closing a modal with the keyboard up and opening a fresh one, straddling the ~1s the device
 * goes on reporting the retracting keyboard as showing.
 */
const RETRACT_RACE_GAPS_IN_MILLISECONDS = [600, 750, 900, 1050, 1200];

/*
 * Six raises, each up to ~15s with the retract confirmation, the touch settle and the evals around them.
 */
const RETRACT_RACE_TEST_TIMEOUT_IN_MILLISECONDS = 240_000;

/**
 * The queries a consumer's capture suite lost the write-back on, each asked twice so one run takes enough
 * raises to see a one-in-five loss: ten raises all holding at that rate happens about one run in nine.
 */
const HOLD_QUERIES = ['Charlie', 'Alpha/Delta/Echo', 'Delta', 'Delta/Echo', 'Alpha/Delta/India'].flatMap((query) => [query, query]);

/**
 * How long after a raise returns the field is read back — about what a device capture takes to be written.
 */
const POST_RAISE_OBSERVATION_DELAY_IN_MILLISECONDS = 1500;

/*
 * Ten raises, each up to ~15s, plus a keyboard settle and the observation delay per raise.
 */
const HOLD_TEST_TIMEOUT_IN_MILLISECONDS = 480_000;

/**
 * The text the strip test seeds: a word Gboard has plenty of predictions for (`multiple` / `multiples` /
 * `multiplex`), so a strip showing predictions cannot pass for one showing the toolbar.
 */
const STRIP_QUERY_TEXT = 'multiple';

/**
 * How many raise+capture rounds the strip has to hold still across.
 */
const STRIP_ROUND_COUNT = 10;

/**
 * How long after a raise returns the strip is photographed — about what a capture suite waits.
 */
const STRIP_CAPTURE_DELAY_IN_MILLISECONDS = 1500;

/**
 * How far a channel may differ between two frames before the pixel counts as changed. The probe modal's
 * soft shadow was seen one value off now and then on the device framebuffer, which the desktop-only
 * raster flag in `deterministic-raster.ts` does not reach; the strip's glyphs differ at full contrast, so
 * this cannot hide them.
 */
const RASTER_NOISE_CHANNEL_DELTA = 1;

/*
 * Ten raises, each up to ~15s, plus a keyboard settle, the capture delay and the capture per raise.
 */
const STRIP_TEST_TIMEOUT_IN_MILLISECONDS = 480_000;

/**
 * What the suite keeps in the renderer between evals: the modal to close, and the log the field writes.
 */
interface ChangedRows {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly pixelCount: number;
}

/**
 * What the probe field recorded about itself.
 */
interface FieldLog {
  /**
   * The field's value after each `input` event, in order. The harness's own writes dispatch one each.
   */
  readonly inputValues: string[];

  /**
   * The field's value at each `touchstart` — the moment the device's touch arrived.
   */
  readonly touchValues: string[];
}

interface ProbeContext {
  inputValues: string[];
  modal?: Modal;
  stackedModal?: Modal;
  touchValues: string[];
}

describe('raiseSoftKeyboard on Android', () => {
  const vault = new TemporaryVault();
  let deviceId = '';
  let contextId = new ContextId<ProbeContext>();

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
    deviceId = await resolveEmulatorDeviceId({ avdName: AVD_NAME });
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  beforeEach(async () => {
    contextId = new ContextId<ProbeContext>();
    await openProbeModal();
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  afterEach(async () => {
    await closeProbeModal();
    await contextId.dispose(vault.path);
    await waitForKeyboardToSettleDown();
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // Guard, not a feature test — the one every Android suite opens with. Without a registered transport
  // resolver the harness silently falls back to the desktop owned-CDP default, and every eval below would
  // then run on desktop while the touches went to a device nothing was reading.
  it('should actually be running on mobile', async () => {
    const isMobile = await evalInObsidian({
      callback({ obsidianModule }): boolean {
        return obsidianModule.Platform.isMobile;
      },
      vaultPath: vault.path
    });

    expect(isMobile).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should empty the field for the touch and write its text back', async () => {
    const snapshot = await withSoftKeyboardEnabled({
      callback: async () => await raiseSoftKeyboard({ deviceId, inputSelector: PROBE_INPUT_SELECTOR, vaultPath: vault.path }),
      deviceId
    });
    const log = await readFieldLog();

    // The raise itself proved the lift; its returned geometry is read with the field still empty.
    expect(snapshot.inputRect).not.toBeNull();

    // The touch arrived at an EMPTY field — the whole point of the emptying. At least one touch, and every
    // one of them into the emptied field, since a second tap point is tried only when the first did not lift.
    expect(log.touchValues.length).toBeGreaterThan(0);
    expect(log.touchValues.every((value) => value === '')).toBe(true);

    // One write to empty it and one to put the text back, in that order, and nothing else.
    expect(log.inputValues).toEqual(['', QUERY_TEXT]);
    expect(await readFieldValue()).toBe(QUERY_TEXT);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // The `finally` half. A raise that fails still owes the caller its query back: a caller about to read its
  // own diagnostic should not also have to discover that the text it set up is gone.
  it('should write the text back when the raise fails', async () => {
    const diagnosticsDirectory = mkdtempSync(join(tmpdir(), 'soft-keyboard-diagnostics-'));

    try {
      await expect(withSoftKeyboardEnabled({
        callback: async () =>
          await raiseSoftKeyboard({
            deviceId,
            diagnosticsDirectory,
            inputSelector: PROBE_INPUT_SELECTOR,
            minimumKeyboardHeightInPixels: UNREACHABLE_KEYBOARD_HEIGHT_IN_PIXELS,
            vaultPath: vault.path
          }),
        deviceId
      })).rejects.toThrow('raiseSoftKeyboard: the keyboard did not come up.');
    } finally {
      await rm(diagnosticsDirectory, { force: true, recursive: true });
    }

    const log = await readFieldLog();

    // It failed AFTER touching — so it really is the restore after a touch that is under test here, not an
    // early throw that never emptied anything.
    expect(log.touchValues.length).toBeGreaterThan(0);
    expect(log.touchValues.every((value) => value === '')).toBe(true);
    expect(log.inputValues).toEqual(['', QUERY_TEXT]);
    expect(await readFieldValue()).toBe(QUERY_TEXT);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // The opt-out restores the pre-emptying behaviour exactly: the touch lands on the field as it stands.
  it('should leave the field alone when shouldEmptyFieldForTouch is false', async () => {
    await withSoftKeyboardEnabled({
      callback: async () =>
        await raiseSoftKeyboard({
          deviceId,
          inputSelector: PROBE_INPUT_SELECTOR,
          shouldEmptyFieldForTouch: false,
          vaultPath: vault.path
        }),
      deviceId
    });
    const log = await readFieldLog();

    expect(log.touchValues.length).toBeGreaterThan(0);
    expect(log.touchValues.every((value) => value === QUERY_TEXT)).toBe(true);
    expect(log.inputValues).toEqual([]);
    expect(await readFieldValue()).toBe(QUERY_TEXT);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // Two fields matching one selector split the raise in two: every step addresses the FIRST match, and the
  // device's touch lands on the one drawn on top, the LAST. The harness then emptied one field while the touch
  // landed inside the other one's text, and Chromium drew its insertion handle into the frame. Measured
  // 2026-09-25 with modals opened without closing the previous one: every raise after the first drew the handle,
  // and the field log showed the touch arriving at the seeded text. The raise now refuses before it touches.
  it('should refuse a selector that matches more than one field, before touching either', async () => {
    await evalInObsidian({
      callback({ app, context, inputClass, obsidianModule, queryText }): void {
        const stacked = new obsidianModule.Modal(app);
        stacked.open();
        stacked.contentEl.createEl('input', { cls: inputClass, value: queryText });
        context.stackedModal = stacked;
      },
      contextId,
      input: { inputClass: PROBE_INPUT_CLASS, queryText: QUERY_TEXT },
      vaultPath: vault.path
    });

    try {
      await expect(withSoftKeyboardEnabled({
        callback: async () => await raiseSoftKeyboard({ deviceId, inputSelector: PROBE_INPUT_SELECTOR, vaultPath: vault.path }),
        deviceId
      })).rejects.toThrow(`raiseSoftKeyboard: "${PROBE_INPUT_SELECTOR}" matches 2 elements`);
    } finally {
      await evalInObsidian({
        callback({ context }): void {
          context.stackedModal?.close();
        },
        contextId,
        vaultPath: vault.path
      });
    }

    const log = await readFieldLog();

    expect(log.touchValues).toEqual([]);
    expect(log.inputValues).toEqual([]);
    expect(await readFieldValue()).toBe(QUERY_TEXT);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // The race the lowering step used to lose. A modal closed with the keyboard up takes the keyboard down
  // with it, but the device goes on reporting `mInputShown=true` for about a second first (measured
  // 2026-09-24: true at 1.2s after the close, false by 1.8s). A fresh modal opened inside that window focuses
  // its field without a touch, so the keyboard does not come back — and a raise that pressed KEYCODE_BACK at
  // its first read landed the key on the app once the IME had gone, closing the fresh modal before its touch.
  //
  // The gaps between the close and the open straddle that window. It is a race, so no single gap is certain
  // to hit it: against the unfixed helper, 3 of 35 raises over gaps of 600-1200ms failed with
  // `nothing matches ".soft-keyboard-probe-input"`, the signature first seen on 2026-09-23, while the fixed
  // helper passed 20 of 20. At that rate five raises catch a regression in roughly one run of three, so a
  // green run here proves little on its own, and a red one with that signature is this race.
  it('should raise on a fresh modal opened while the previous modal\'s keyboard is going down', async () => {
    await withSoftKeyboardEnabled({
      callback: async () => {
        await raiseSoftKeyboard({ deviceId, inputSelector: PROBE_INPUT_SELECTOR, vaultPath: vault.path });

        for (const gapInMilliseconds of RETRACT_RACE_GAPS_IN_MILLISECONDS) {
          await closeProbeModal();
          await sleep(gapInMilliseconds);
          await openProbeModal();
          await raiseSoftKeyboard({ deviceId, inputSelector: PROBE_INPUT_SELECTOR, vaultPath: vault.path });
        }
      },
      deviceId
    });
    const log = await readFieldLog();

    // The last fresh modal survived the lowering step and took its own touch into its emptied field.
    expect(log.touchValues.length).toBeGreaterThan(0);
    expect(log.touchValues.every((value) => value === '')).toBe(true);
    expect(log.inputValues).toEqual(['', QUERY_TEXT]);
    expect(await readFieldValue()).toBe(QUERY_TEXT);
  }, RETRACT_RACE_TEST_TIMEOUT_IN_MILLISECONDS);

  // The write-back has to SURVIVE the IME, not merely be made. The touch that raises the keyboard lands on the
  // emptied field, so the IME's input connection starts from an empty field; about one frame in five (measured
  // 2026-09-25 in a consumer's capture suite, on these queries) its later update wrote that empty state back
  // over the harness's write, and the capture taken straight after showed the placeholder. The raise now holds
  // the text until it stays put, so the field must still carry each query well after the raise returned.
  it('should keep the written-back text after the keyboard settles, raise after raise', async () => {
    const heldValues: (null | string)[] = [];

    await withSoftKeyboardEnabled({
      callback: async () => {
        for (const query of HOLD_QUERIES) {
          await closeProbeModal();
          await waitForKeyboardToSettleDown();
          await openProbeModal(query);
          await raiseSoftKeyboard({ deviceId, inputSelector: PROBE_INPUT_SELECTOR, vaultPath: vault.path });
          await sleep(POST_RAISE_OBSERVATION_DELAY_IN_MILLISECONDS);
          heldValues.push(await readFieldValue());
        }
      },
      deviceId
    });

    expect(heldValues).toEqual(HOLD_QUERIES);
  }, HOLD_TEST_TIMEOUT_IN_MILLISECONDS);

  // Gboard's suggestion strip is either its toolbar or word predictions for the text before the caret, and the
  // raise used to leave that to a race: the touch lands on the emptied field (toolbar), and the write-back leaves
  // the caret after the text (predictions) once Gboard hears about it. The predictions also vary between runs,
  // because they come from the keyboard's learned dictionary. Parking the caret at offset 0 makes both outcomes
  // the toolbar. The lower half of the frame holds the lifted field (caret hidden) and the whole keyboard, so
  // every round has to photograph it the same, down to rasterization noise of one value per channel.
  it('should show the same keyboard strip on every raise', async () => {
    const frames: Uint8Array[] = [];
    const selectionStarts: (null | number)[] = [];
    const sharp = await importSharp('soft-keyboard.android.integration.test');

    await withSoftKeyboardEnabled({
      callback: async () => {
        for (let round = 0; round < STRIP_ROUND_COUNT; round++) {
          await closeProbeModal();
          await waitForKeyboardToSettleDown();
          await openProbeModal(STRIP_QUERY_TEXT);
          await raiseSoftKeyboard({ deviceId, inputSelector: PROBE_INPUT_SELECTOR, vaultPath: vault.path });
          selectionStarts.push(await readSelectionStart());

          const hiddenCaret = await hideCaret({ vaultPath: vault.path });
          try {
            await sleep(STRIP_CAPTURE_DELAY_IN_MILLISECONDS);
            frames.push(await captureDeviceScreenshot({ deviceId }));
          } finally {
            await hiddenCaret.restore();
          }
        }
      },
      deviceId
    });

    expect(selectionStarts).toEqual(Array.from({ length: STRIP_ROUND_COUNT }, () => 0));

    const [firstFrame] = frames;
    if (!firstFrame) {
      throw new Error('No frame was captured.');
    }

    const first = await sharp(firstFrame).raw().toBuffer({ resolveWithObject: true });
    const differences: string[] = [];
    let framesDirectory = '';

    for (const [index, frame] of frames.entries()) {
      const current = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
      const changedRows = findChangedRows(first, current, Math.floor(first.info.height / 2));

      if (!changedRows) {
        continue;
      }

      framesDirectory ||= mkdtempSync(join(tmpdir(), 'soft-keyboard-strip-'));
      writeFileSync(join(framesDirectory, 'frame-0.png'), firstFrame);
      writeFileSync(join(framesDirectory, `frame-${String(index)}.png`), frame);
      differences.push(`frame ${String(index)}: ${String(changedRows.pixelCount)} pixel(s) in rows ${String(changedRows.firstRow)}-${String(changedRows.lastRow)}`);
    }

    expect(differences, `frames differing from frame 0, kept in ${framesDirectory}`).toEqual([]);
  }, STRIP_TEST_TIMEOUT_IN_MILLISECONDS);

  // The opt-out leaves the caret where the write-back put it: after the text.
  it('should leave the caret after the text when shouldPinKeyboardToolbar is false', async () => {
    await withSoftKeyboardEnabled({
      callback: async () =>
        await raiseSoftKeyboard({
          deviceId,
          inputSelector: PROBE_INPUT_SELECTOR,
          shouldPinKeyboardToolbar: false,
          vaultPath: vault.path
        }),
      deviceId
    });

    expect(await readSelectionStart()).toBe(QUERY_TEXT.length);
    expect(await readFieldValue()).toBe(QUERY_TEXT);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  async function closeProbeModal(): Promise<void> {
    await evalInObsidian({
      callback({ context }): void {
        context.modal?.close();
      },
      contextId,
      vaultPath: vault.path
    });
  }

  /**
   * Opens the probe modal with its field seeded, and makes it the one the log and the teardown follow.
   */
  async function openProbeModal(seededText = QUERY_TEXT): Promise<void> {
    await evalInObsidian({
      callback({ app, context, inputClass, obsidianModule, queryText }): void {
        class ProbeModal extends obsidianModule.SuggestModal<string> {
          public override getSuggestions(query: string): string[] {
            return ['alpha', 'beta', 'note'].filter((suggestion) => suggestion.includes(query));
          }

          public override onChooseSuggestion(): void {
            // The suite never chooses; the modal exists only to hold the field.
          }

          public override renderSuggestion(suggestion: string, el: HTMLElement): void {
            el.setText(suggestion);
          }
        }

        const modal = new ProbeModal(app);
        modal.open();
        modal.inputEl.addClass(inputClass);

        context.inputValues = [];
        context.touchValues = [];
        context.modal = modal;

        modal.inputEl.addEventListener('touchstart', () => {
          context.touchValues.push(modal.inputEl.value);
        }, { passive: true });

        // Written by script and announced, so the suggester renders rows for it — the state a capture
        // suite raises the keyboard over. Recorded only from here on, so the log holds the harness's writes.
        modal.inputEl.value = queryText;
        modal.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

        modal.inputEl.addEventListener('input', () => {
          context.inputValues.push(modal.inputEl.value);
        });
      },
      contextId,
      input: { inputClass: PROBE_INPUT_CLASS, queryText: seededText },
      vaultPath: vault.path
    });
  }

  async function readFieldLog(): Promise<FieldLog> {
    return await evalInObsidian({
      callback({ context }): FieldLog {
        return { inputValues: context.inputValues, touchValues: context.touchValues };
      },
      contextId,
      vaultPath: vault.path
    });
  }

  /**
   * Waits for the keyboard a test left up to go down with the modal that raised it.
   *
   * Without this, the next test's `raiseSoftKeyboard` can find the device still reporting the old IME
   * mid-retract, press `KEYCODE_BACK` after it has gone, and have the key reach the app, where it closes
   * the fresh probe modal before the touch. Observed once, on 2026-09-23: the next raise failed with
   * `nothing matches ".soft-keyboard-probe-input"`. Each test raises its own keyboard, so each test has to
   * start with none.
   */
  async function waitForKeyboardToSettleDown(): Promise<void> {
    const deadline = performance.now() + KEYBOARD_SETTLE_TIMEOUT_IN_MILLISECONDS;

    while (performance.now() < deadline) {
      const dumpsysOutput = await runAdbText({ commandArguments: ['shell', 'dumpsys', 'input_method'], deviceId });

      if (!checkIsInputMethodShown(parseInputMethodState(dumpsysOutput))) {
        return;
      }

      await sleep(KEYBOARD_SETTLE_POLL_INTERVAL_IN_MILLISECONDS);
    }

    throw new Error(`The keyboard was still up ${String(KEYBOARD_SETTLE_TIMEOUT_IN_MILLISECONDS)}ms after the probe modal closed.`);
  }

  async function readSelectionStart(): Promise<null | number> {
    return await evalInObsidian({
      callback({ inputSelector }): null | number {
        const element = document.querySelector(inputSelector);
        return element instanceof HTMLInputElement ? element.selectionStart : null;
      },
      input: { inputSelector: PROBE_INPUT_SELECTOR },
      vaultPath: vault.path
    });
  }

  async function readFieldValue(): Promise<null | string> {
    return await evalInObsidian({
      callback({ inputSelector }): null | string {
        const element = document.querySelector(inputSelector);
        return element instanceof HTMLInputElement ? element.value : null;
      },
      input: { inputSelector: PROBE_INPUT_SELECTOR },
      vaultPath: vault.path
    });
  }
});

/**
 * Finds the pixels below `fromRow` whose channels differ by more than {@link RASTER_NOISE_CHANNEL_DELTA}
 * between two frames of the same size, and the rows they span.
 *
 * @param first - One frame.
 * @param second - The other.
 * @param fromRow - The first row compared.
 * @returns The rows and count of changed pixels, or `null` when none changed.
 */
function findChangedRows(first: SharpRawResult, second: SharpRawResult, fromRow: number): ChangedRows | null {
  const { channels, width } = first.info;
  let firstRow = -1;
  let lastRow = -1;
  let pixelCount = 0;

  for (let offset = fromRow * width * channels; offset < first.data.length; offset += channels) {
    for (let channel = 0; channel < channels; channel++) {
      if (Math.abs((first.data[offset + channel] ?? 0) - (second.data[offset + channel] ?? 0)) > RASTER_NOISE_CHANNEL_DELTA) {
        const row = Math.floor(offset / (width * channels));
        firstRow = firstRow === -1 ? row : firstRow;
        lastRow = row;
        pixelCount++;
        break;
      }
    }
  }

  return pixelCount === 0 ? null : { firstRow, lastRow, pixelCount };
}
