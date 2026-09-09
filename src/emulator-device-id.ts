/**
 * @file
 *
 * Picks the running emulator that belongs to a named AVD.
 *
 * A capture suite must never take "the first device `adb devices` lists". Two
 * things routinely make that the wrong device on this fleet: a physical phone is
 * often plugged into the same machine, and the harness's own `obsidian_test` AVD
 * runs at a different geometry than the `obsidian_screenshots` AVD sized to the
 * store's frame. Picking by position silently photographs the wrong screen at
 * the wrong size, and the dimension assertion that would have caught it fires
 * several minutes later, after the run.
 *
 * Pure and unit-tested; the `adb` round-trips that gather the AVD names live in
 * `resolve-emulator-device-id`.
 */

/**
 * One running emulator, paired with the AVD it was started from.
 */
export interface EmulatorDeviceCandidate {
  /**
   * The AVD name the emulator reports, e.g. `obsidian_screenshots`.
   */
  readonly avdName: string;

  /**
   * The device UDID, e.g. `emulator-5554`.
   */
  readonly deviceId: string;
}

/**
 * Parameters for {@link selectEmulatorDeviceId}.
 */
export interface SelectEmulatorDeviceIdParams {
  /**
   * The AVD name to match.
   */
  readonly avdName: string;

  /**
   * Every running emulator, with the AVD each was started from.
   */
  readonly candidates: readonly EmulatorDeviceCandidate[];
}

/**
 * Picks the emulator started from a named AVD.
 *
 * @param params - The AVD to match and the running emulators to match against.
 * @returns The matching device UDID, or `null` when no running emulator carries that AVD name.
 */
export function selectEmulatorDeviceId(params: SelectEmulatorDeviceIdParams): null | string {
  const match = params.candidates.find((candidate) => candidate.avdName === params.avdName);
  return match ? match.deviceId : null;
}
