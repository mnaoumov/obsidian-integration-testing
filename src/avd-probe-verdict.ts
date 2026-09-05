/**
 * @file
 *
 * Pure classification of the AVD adoption probe — deciding, from what each
 * connected device answered, whether this run may reuse one, must start its
 * own emulator, or cannot safely do either.
 *
 * The probe (`adb -s <device> emu avd name`) used to discard its error and
 * resolve `''`, so a call that **never answered** was indistinguishable from one
 * that answered *"a different AVD"*. Both fell through to "start a new
 * emulator", which collides with the emulator already serving that AVD:
 *
 * ```text
 * 14:27:52.114  Checking existing devices for AVD "obsidian_test"... (connected: [emulator-5554])
 * 14:27:57.170  AVD "obsidian_test" not found on any existing device, starting a new emulator...
 * ```
 *
 * 5.056s apart — exactly the probe's own timeout. The launch that followed hit
 * `FATAL | Running multiple emulators with the same AVD is an experimental
 * feature`, which the emulator writes to its own stdout. **A probe that never
 * answered is not evidence that the answer is no** — the same distinction
 * `adb-device-list.ts` draws between `offline` and absent, and the same one
 * the connectivity probe draws between a failed dump and a missing network.
 *
 * Worse, the probe is asked its question precisely when the guest is least able
 * to answer it — a wedged emulator times out every `adb` call — which is the
 * condition under which a colliding launch does the most damage.
 *
 * Kept separate from the integration-only `transport-factory` (excluded from
 * unit tests) so the classification stays unit-testable — the factory itself
 * shells out to `adb`.
 */

import { assertNever } from './type-guards.ts';

/**
 * What one device answered when asked which AVD it is serving.
 *
 * `not-an-emulator` and `other-avd` are both legitimate skips; only
 * `no-answer` is the silence that must never be read as one.
 */
export type AvdProbeOutcome = 'match' | 'no-answer' | 'not-an-emulator' | 'other-avd';

/**
 * The run cannot tell whether the AVD is already running, so it must not launch.
 */
export interface AvdProbeRefuseVerdict {
  /**
  The devices that could not be read, and therefore cannot be ruled out as the AVD's holder.
   */
  readonly unreadableDeviceIds: string[];

  /**
  Discriminant.
   */
  readonly verdict: 'refuse';
}

/**
 * One device's probe outcome.
 */
export interface AvdProbeResult {
  /**
  The device UDID, e.g. `emulator-5554`.
   */
  readonly deviceId: string;

  /**
  What the device answered.
   */
  readonly outcome: AvdProbeOutcome;
}

/**
 * The AVD is already running, on a device this run may adopt.
 */
export interface AvdProbeReuseVerdict {
  /**
  The device already serving the requested AVD.
   */
  readonly deviceId: string;

  /**
  Discriminant.
   */
  readonly verdict: 'reuse';
}

/**
 * Every device answered, none is serving the AVD, so launching cannot collide.
 */
export interface AvdProbeStartNewVerdict {
  /**
  Discriminant.
   */
  readonly verdict: 'start-new';
}

/**
 * What the run may do, given every device's probe outcome.
 */
export type AvdProbeVerdict = AvdProbeRefuseVerdict | AvdProbeReuseVerdict | AvdProbeStartNewVerdict;

/**
 * Parameters for {@link buildUnreadableDevicesMessage}.
 */
export interface BuildUnreadableDevicesMessageParams {
  /**
  The AVD the run wanted.
   */
  readonly avdName: string;

  /**
  The budget each probe attempt was given, in milliseconds.
   */
  readonly probeTimeoutInMilliseconds: number;

  /**
  The devices that did not answer.
   */
  readonly unreadableDeviceIds: readonly string[];
}

/**
 * Parameters for {@link classifyAvdProbe}.
 */
export interface ClassifyAvdProbeParams {
  /**
  The AVD the run wants.
   */
  readonly avdName: string;

  /**
  The device that was probed.
   */
  readonly deviceId: string;

  /**
  The AVD name the device answered, or `undefined` when it did not answer at all.
   */
  readonly probedAvdName?: string | undefined;
}

/**
 * Matches the device IDs adb gives emulators started the way this harness
 * starts them: `emulator -avd <name>`, whose console lands on a local port.
 *
 * Only such a device can collide with this run's launch, so only such a device's
 * silence is worth refusing over. A physical handset (an arbitrary serial) or a
 * TCP-attached device answers `adb … emu avd name` with an error however healthy
 * it is; reading that as "did not answer" would block every run on a host with a
 * phone plugged in, which is a worse defect than the one this module fixes.
 */
const EMULATOR_DEVICE_ID_PATTERN = /^emulator-\d+$/;

/**
 * Builds the summary line naming what each device answered.
 *
 * The old log printed only the conclusion (`not found on any existing device`),
 * which is exactly the line that was wrong; printing the evidence next to it is
 * what makes a bad conclusion visible without a second run.
 *
 * @param results - Every device's probe outcome.
 * @returns The summary, or `no devices` when nothing was connected.
 */
export function buildAvdProbeSummary(results: readonly AvdProbeResult[]): string {
  if (results.length === 0) {
    return 'no devices';
  }

  return results.map((result) => `${result.deviceId}=${result.outcome}`).join(', ');
}

/**
 * Builds the refusal message for devices that could not be read.
 *
 * Names the device, the AVD, the budget, the consequence and the recovery — the
 * shape `teardown-verdict.ts` uses for its own warning, because a message that
 * stops a run has to leave the reader able to unblock it.
 *
 * @param params - The AVD, the probe budget, and the devices that did not answer.
 * @returns The refusal message.
 */
export function buildUnreadableDevicesMessage(params: BuildUnreadableDevicesMessageParams): string {
  /*
   * When there is exactly one device the joined list IS its ID, so the singular
   * wording needs no index access — and no unreachable fallback for one.
   */
  const deviceList = params.unreadableDeviceIds.join(', ');
  const isSingle = params.unreadableDeviceIds.length === 1;

  const subject = isSingle ? `device ${deviceList}` : `devices ${deviceList}`;
  const command = isSingle ? `adb -s ${deviceList} emu avd name` : 'adb -s <device> emu avd name';
  const holder = isSingle ? 'it is' : 'one of them is';
  const remedy = isSingle ? 'Kill the unresponsive device' : 'Kill the unresponsive devices';

  return `AVD "${params.avdName}": ${subject} did not answer \`${command}\` within ${String(params.probeTimeoutInMilliseconds)}ms (retried once), `
    + `so this run cannot tell whether ${holder} already serving that AVD. Starting an emulator anyway would collide `
    + '(`FATAL | Running multiple emulators with the same AVD is an experimental feature`), which the emulator reports only to its own stdout. '
    + `${remedy}, or run \`adb kill-server\`, then retry.`;
}

/**
 * Decides whether a device can hold an AVD this run could collide with.
 *
 * @param deviceId - The device UDID to judge.
 * @returns `true` for a locally started emulator, whose console this run can ask.
 */
export function checkIsEmulatorDeviceId(deviceId: string): boolean {
  return EMULATOR_DEVICE_ID_PATTERN.test(deviceId);
}

/**
 * Classifies one device's probe.
 *
 * @param params - The AVD wanted, the device probed, and what it answered.
 * @returns The outcome.
 */
export function classifyAvdProbe(params: ClassifyAvdProbeParams): AvdProbeOutcome {
  if (!checkIsEmulatorDeviceId(params.deviceId)) {
    return 'not-an-emulator';
  }

  if (params.probedAvdName === undefined || params.probedAvdName.length === 0) {
    return 'no-answer';
  }

  return params.probedAvdName === params.avdName ? 'match' : 'other-avd';
}

/**
 * Decides what the run may do, from every device's probe outcome.
 *
 * **A match wins over an unreadable sibling.** Once the requested AVD is found
 * and reusable, an unrelated wedged device is somebody else's problem and must
 * not block a run that has everything it needs — the same restraint
 * `emulator-backend.ts` shows in never sweeping a `qemu*` it does not own. Only
 * when nothing matched does silence become decisive, because only then would the
 * run go on to launch.
 *
 * @param results - Every device's probe outcome.
 * @returns The verdict.
 */
export function resolveAvdProbeVerdict(results: readonly AvdProbeResult[]): AvdProbeVerdict {
  const unreadableDeviceIds: string[] = [];

  for (const result of results) {
    switch (result.outcome) {
      case 'match': {
        return { deviceId: result.deviceId, verdict: 'reuse' };
      }
      case 'no-answer': {
        unreadableDeviceIds.push(result.deviceId);
        break;
      }
      case 'not-an-emulator':
      case 'other-avd': {
        break;
      }
      default: {
        return assertNever(result.outcome);
      }
    }
  }

  if (unreadableDeviceIds.length > 0) {
    return { unreadableDeviceIds, verdict: 'refuse' };
  }

  return { verdict: 'start-new' };
}
