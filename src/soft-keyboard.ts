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
 * @param params - The device, the field to touch, and how far it must lift.
 * @returns A {@link Promise} that resolves to the geometry read once the keyboard is up.
 * @throws Error if the field never matched, or if it never lifted, the latter after writing the device
 *   framebuffer and the device's own `input_method` state to the diagnostics directory.
 */
export async function raiseSoftKeyboard(params: RaiseSoftKeyboardParams): Promise<SoftKeyboardViewportSnapshot> {
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

/* v8 ignore stop */
