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

import type { AdbDeviceEntry } from '../adb/adb-device-list.ts';
import type { AdbDevicesFailure } from '../adb/adb-devices-failure.ts';

import { describeAdbDevicesFailure } from '../adb/adb-devices-failure.ts';
import { checkIsEmulatorDeviceId } from './avd-probe-verdict.ts';

/**
 * Parameters for {@link buildNoLaunchedDeviceMessage}.
 */
export interface BuildNoLaunchedDeviceMessageParams {
  /**
   * The devices the last successful listing showed, in any state, or `undefined` when no listing succeeded.
   */
  readonly lastListedDevices: readonly AdbDeviceEntry[] | undefined;

  /**
   * The most recent failed listing, if any failed.
   */
  readonly lastListingFailure: AdbDevicesFailure | undefined;

  /**
   * How many of the polls' listings failed.
   */
  readonly listingFailureCount: number;

  /**
   * How many times the wait listed the devices.
   */
  readonly pollCount: number;

  /**
   * How many of the wait's listings failed their first try and answered only on the retry.
   */
  readonly retriedListingCount: number;

  /**
   * The wait's budget, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

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
 * Builds the message for a launched emulator that produced no usable device in time.
 *
 * The emulator process is still running when this is reached (an exit fails the
 * wait sooner), so what is left to say is what adb saw: a device stuck
 * `offline` means the emulator registered and the guest's `adbd` never came up,
 * no device at all means the emulator never registered with the adb server, and
 * failed listings mean adb itself was not answering.
 *
 * @param params - What the wait observed.
 * @returns The message, without the emulator's output tail.
 */
export function buildNoLaunchedDeviceMessage(params: BuildNoLaunchedDeviceMessageParams): string {
  const parts = [
    `No new emulator device appeared within ${String(params.timeoutInMilliseconds)}ms, and the emulator process is still running.`
  ];

  if (params.lastListedDevices === undefined) {
    parts.push('No device listing succeeded during the wait.');
  } else if (params.lastListedDevices.length === 0) {
    parts.push('The last listing showed no devices: the emulator never registered with the adb server.');
  } else {
    const devices = params.lastListedDevices.map((entry) => `${entry.deviceId} ${entry.state}`).join(', ');
    const hasOfflineEmulator = params.lastListedDevices.some((entry) => checkIsEmulatorDeviceId(entry.deviceId) && entry.state === 'offline');
    parts.push(
      `The last listing showed: ${devices}.${hasOfflineEmulator ? ' An emulator stuck `offline` registered with adb, but the guest\'s adbd never came up.' : ''}`
    );
  }

  if (params.lastListingFailure !== undefined) {
    parts.push(
      `${String(params.listingFailureCount)} of ${String(params.pollCount)} listing(s) failed; the last: ${describeAdbDevicesFailure(params.lastListingFailure)}`
    );
  }

  /*
   * A listing that needed its retry is invisible in the failure count above, and
   * on 2026-10-23 that was every listing of a wait that ended with the guest
   * offline: the host's load, not the device, was the thing worth naming.
   */
  if (params.retriedListingCount > 0) {
    parts.push(
      `${String(params.retriedListingCount)} of ${String(params.pollCount)} listing(s) answered only on a retry, because the adb server, or the host under it, was too busy to list devices on the first try. The host was heavily loaded during this wait, and a guest that stays offline on such a host is more likely starved than broken: re-run when the machine is quieter before suspecting the AVD.`
    );
  }

  return parts.join(' ');
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
