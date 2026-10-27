/**
 * @file
 *
 * Pure helpers for parsing `adb devices` output.
 *
 * Kept separate from the integration-only `transport-factory` (excluded from
 * unit tests) so the parsing stays unit-testable — the factory itself shells out
 * to `adb`.
 *
 * The listing answers two **different** questions, and conflating them is a
 * defect rather than a nicety:
 *
 * - *Is the device usable?* — only a device in the `device` state is, which is
 *   what the session preflight asks ({@link listOnlineDeviceIds}).
 * - *Is the device gone?* — a dying emulator drops to `offline` while it still
 *   holds the AVD's `multiinstance.lock` and its console port, so teardown must
 *   treat **any** listed state as "still here" ({@link checkIsDeviceListed}).
 *   Reading `offline` as gone is what lets the next run collide with a leftover.
 */

/**
 * One row of `adb devices`.
 */
export interface AdbDeviceEntry {
  /**
  The device UDID, e.g. `emulator-5554`.
   */
  readonly deviceId: string;

  /**
  The device state adb reports, e.g. `device`, `offline`, `unauthorized`.
   */
  readonly state: string;
}

/**
 * Parameters for {@link checkIsDeviceListed}.
 */
export interface CheckIsDeviceListedParams {
  /**
  The device UDID to look for.
   */
  readonly deviceId: string;

  /**
  Raw stdout of `adb devices`.
   */
  readonly devicesOutput: string;
}

const ONLINE_DEVICE_STATE = 'device';

/**
 * Decides whether a device is still listed at all, **in any state**.
 *
 * This is teardown's question, not the preflight's: an emulator that answers
 * `offline` has not released the AVD.
 *
 * @param params - The listing output and the device to look for.
 * @returns `true` when the device appears in the listing, whatever its state.
 */
export function checkIsDeviceListed(params: CheckIsDeviceListedParams): boolean {
  return parseAdbDevices(params.devicesOutput).some((entry) => entry.deviceId === params.deviceId);
}

/**
 * Lists the devices that are actually usable — those in the `device` state.
 *
 * @param devicesOutput - Raw stdout of `adb devices`.
 * @returns The online device IDs, in listed order.
 */
export function listOnlineDeviceIds(devicesOutput: string): string[] {
  return parseAdbDevices(devicesOutput)
    .filter((entry) => entry.state === ONLINE_DEVICE_STATE)
    .map((entry) => entry.deviceId);
}

/**
 * Parses the rows of `adb devices` into device IDs and states.
 *
 * Every row is `<id>\t<state>`; the `List of devices attached` header and the
 * `* daemon … *` banner carry no tab, which is what distinguishes them.
 *
 * @param devicesOutput - Raw stdout of `adb devices`.
 * @returns One entry per listed device, in listed order.
 */
export function parseAdbDevices(devicesOutput: string): AdbDeviceEntry[] {
  const entries: AdbDeviceEntry[] = [];

  for (const rawLine of devicesOutput.split('\n')) {
    const line = rawLine.trim();
    const separatorIndex = line.indexOf('\t');
    if (separatorIndex === -1) {
      continue;
    }

    entries.push({
      deviceId: line.slice(0, separatorIndex).trim(),
      state: line.slice(separatorIndex + 1).trim()
    });
  }

  return entries;
}
