/**
 * @file
 *
 * Asks the running emulators which AVD each was started from, and resolves one
 * by name through {@link ./emulator-device-id.ts}'s selection.
 *
 * Every function here shells out, so the whole module is integration-time code
 * — which is exactly why the selection it delegates to lives in its own module
 * and stays unit-tested.
 */

/* v8 ignore start -- Integration-time code (shells out to a real device) covered by integration tests, not unit tests. */

import type { EmulatorDeviceCandidate } from './emulator-device-id.ts';

import { listOnlineDeviceIds } from './adb-device-list.ts';
import {
  runAdbText,
  runAdbTextWithoutDevice
} from './adb.ts';
import { selectEmulatorDeviceId } from './emulator-device-id.ts';

/**
 * Parameters for {@link resolveEmulatorDeviceId}.
 */
export interface ResolveEmulatorDeviceIdParams {
  /**
   * The AVD name to match, e.g. `obsidian_screenshots`.
   */
  readonly avdName: string;
}

/**
 * The prefix `adb devices` gives an emulator, as opposed to a physically attached device.
 */
const EMULATOR_DEVICE_ID_PREFIX = 'emulator-';

/**
 * Finds the running emulator whose AVD is the named one.
 *
 * @param params - The AVD to match.
 * @returns A {@link Promise} that resolves to the device UDID to address it by.
 * @throws Error if no running emulator was started from that AVD. The message lists what IS running, since
 *   "the wrong emulator is up" and "no emulator is up" need different answers.
 */
export async function resolveEmulatorDeviceId(params: ResolveEmulatorDeviceIdParams): Promise<string> {
  const candidates = await listEmulatorDeviceCandidates();
  const deviceId = selectEmulatorDeviceId({ avdName: params.avdName, candidates });

  if (!deviceId) {
    const listed = candidates.map((candidate) => `${candidate.deviceId} (${candidate.avdName})`).join(', ') || 'none';
    throw new Error(
      `resolveEmulatorDeviceId: no running emulator for AVD "${params.avdName}". Running emulators: ${listed}. `
        + 'Start it, or run this project once to have the harness start it.'
    );
  }

  return deviceId;
}

/**
 * Asks every online emulator which AVD it was started from.
 *
 * @returns A {@link Promise} that resolves to one entry per running emulator.
 */
async function listEmulatorDeviceCandidates(): Promise<EmulatorDeviceCandidate[]> {
  const devicesOutput = await runAdbTextWithoutDevice(['devices']);
  const deviceIds = listOnlineDeviceIds(devicesOutput).filter((deviceId) => deviceId.startsWith(EMULATOR_DEVICE_ID_PREFIX));

  const candidates: EmulatorDeviceCandidate[] = [];
  for (const deviceId of deviceIds) {
    // `adb emu avd name` answers with the name and then `OK`, each on its own line.
    const output = await runAdbText({ commandArguments: ['emu', 'avd', 'name'], deviceId });
    const avdName = output.split('\n', 1)[0]?.trim() ?? '';
    candidates.push({ avdName, deviceId });
  }

  return candidates;
}

/* v8 ignore stop */
