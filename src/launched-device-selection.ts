/**
 * @file
 *
 * Pure selection of the device an emulator this run just launched produced.
 *
 * The wait used to take the first online device that was not listed before the
 * launch. The "before" snapshot lists online devices only, so a handset that was
 * `unauthorized`, `offline` or unplugged at that moment — and came online during
 * the boot, which a USB reconnect or accepting the debugging prompt is enough
 * for — looked new, and was adopted as the emulator:
 *
 * ```text
 * AVD "obsidian_test" not found on any existing device, starting a new emulator...
 * Waiting for a new device to appear in ADB ...
 * Device 3C15BN001Y900000 appeared in ADB, waiting for boot to complete...
 * Emulator "obsidian_test" started, device 3C15BN001Y900000 is connected (owned emulator PIDs: [])
 * ```
 *
 * The suite then ran on the phone, and the emulator really launched was owned by
 * nobody. So a new device is the launched emulator only when it is an emulator
 * **and** it says it is serving the launched AVD — which also keeps a second
 * emulator another project started concurrently from being adopted.
 *
 * Kept separate from the integration-only `transport-factory` so the decision is
 * unit-testable; the factory does the `adb` round-trips.
 */

import { checkIsEmulatorDeviceId } from './avd-probe-verdict.ts';

/**
 * One new emulator device, with what it answered when asked for its AVD name.
 */
export interface LaunchedDeviceCandidate {
  /**
   * The device UDID, e.g. `emulator-5554`.
   */
  readonly deviceId: string;

  /**
   * The AVD the device reported, or `undefined` when it did not answer.
   */
  readonly probedAvdName: string | undefined;
}

/**
 * The new devices a poll found, split by whether they can be the launched emulator.
 */
export interface NewDeviceSplit {
  /**
   * New emulator devices, to be asked which AVD they serve.
   */
  readonly emulatorDeviceIds: string[];

  /**
   * New devices that are not emulators (a handset, a TCP-attached device) and are never adopted.
   */
  readonly nonEmulatorDeviceIds: string[];
}

/**
 * Parameters for {@link resolveLaunchedDevice}.
 */
export interface ResolveLaunchedDeviceParams {
  /**
   * The AVD this run launched.
   */
  readonly avdName: string;

  /**
   * The new emulator devices, with their probe answers.
   */
  readonly candidates: readonly LaunchedDeviceCandidate[];
}

/**
 * What the probe answers say about the launched emulator's device.
 */
export interface ResolveLaunchedDeviceResult {
  /**
   * The device serving the launched AVD, or `undefined` when none does yet.
   */
  readonly deviceId: string | undefined;

  /**
   * Devices that answered with a different AVD: another emulator, never this run's.
   */
  readonly otherAvdDeviceIds: string[];

  /**
   * Devices that did not answer yet, to be asked again on the next poll.
   */
  readonly unansweredDeviceIds: string[];
}

/**
 * Parameters for {@link splitNewDevices}.
 */
export interface SplitNewDevicesParams {
  /**
   * The devices online now.
   */
  readonly connectedDeviceIds: readonly string[];

  /**
   * The devices online before the launch.
   */
  readonly deviceIdsBefore: readonly string[];
}

/**
 * Picks the new emulator device that serves the launched AVD.
 *
 * Silence is not a match: a device that did not answer is asked again, never adopted
 * on the strength of being new.
 *
 * @param params - The launched AVD and the probed candidates.
 * @returns The matching device, plus the ones ruled out and the ones still unknown.
 */
export function resolveLaunchedDevice(params: ResolveLaunchedDeviceParams): ResolveLaunchedDeviceResult {
  const match = params.candidates.find((candidate) => candidate.probedAvdName === params.avdName);
  return {
    deviceId: match?.deviceId,
    otherAvdDeviceIds: params.candidates
      .filter((candidate) => candidate.probedAvdName !== undefined && candidate.probedAvdName !== params.avdName)
      .map((candidate) => candidate.deviceId),
    unansweredDeviceIds: params.candidates.filter((candidate) => candidate.probedAvdName === undefined).map((candidate) => candidate.deviceId)
  };
}

/**
 * Splits the devices that were not online before the launch into emulators and everything else.
 *
 * @param params - The devices online now and before the launch.
 * @returns The new devices, split.
 */
export function splitNewDevices(params: SplitNewDevicesParams): NewDeviceSplit {
  const newDeviceIds = params.connectedDeviceIds.filter((deviceId) => !params.deviceIdsBefore.includes(deviceId));
  return {
    emulatorDeviceIds: newDeviceIds.filter((deviceId) => checkIsEmulatorDeviceId(deviceId)),
    nonEmulatorDeviceIds: newDeviceIds.filter((deviceId) => !checkIsEmulatorDeviceId(deviceId))
  };
}
