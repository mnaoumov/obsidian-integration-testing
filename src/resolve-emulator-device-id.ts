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

import type { AvdNameChannel } from './avd-name-channel.ts';
import type { EmulatorDeviceCandidate } from './emulator-device-id.ts';

import { listOnlineDeviceIds } from './adb-device-list.ts';
import {
  runAdbText,
  runAdbTextWithoutDevice
} from './adb.ts';
import {
  buildAvdNameChannelCommand,
  FIRST_AVD_NAME_CHANNEL,
  parseAvdNameAnswer,
  resolveNextAvdNameChannel
} from './avd-name-channel.ts';
import { selectEmulatorDeviceId } from './emulator-device-id.ts';
import { ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS } from './emulator-reclaim.ts';

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
 * **A device that will not identify itself is listed with an empty name, not
 * thrown over.** It is somebody else's wedged emulator far more often than it is
 * this caller's, and failing the whole lookup over it is precisely the
 * machine-wide interlock `avd-name-channel.ts` exists to undo — the wanted
 * emulator, sitting right beside it and answering perfectly, is still found.
 *
 * @returns A {@link Promise} that resolves to one entry per running emulator.
 */
async function listEmulatorDeviceCandidates(): Promise<EmulatorDeviceCandidate[]> {
  const devicesOutput = await runAdbTextWithoutDevice(['devices']);
  const deviceIds = listOnlineDeviceIds(devicesOutput).filter((deviceId) => deviceId.startsWith(EMULATOR_DEVICE_ID_PREFIX));

  const candidates: EmulatorDeviceCandidate[] = [];
  for (const deviceId of deviceIds) {
    candidates.push({ avdName: await probeAvdName(deviceId), deviceId });
  }

  return candidates;
}

/**
 * Asks one emulator which AVD it was started from, over each channel in turn.
 *
 * The guest property comes first because it travels `adbd` — the channel this
 * lookup needs anyway — while the console is a separate port that wedges on its
 * own; see `avd-name-channel.ts`. Every call is bounded, so one unresponsive
 * device costs a timeout rather than the whole lookup.
 *
 * @param deviceId - The emulator to ask.
 * @returns A {@link Promise} that resolves to the AVD name, or `''` when no channel identified it.
 */
async function probeAvdName(deviceId: string): Promise<string> {
  let channel: AvdNameChannel | undefined = FIRST_AVD_NAME_CHANNEL;

  while (channel !== undefined) {
    let didChannelRespond = true;
    let reportedAvdName = '';

    try {
      reportedAvdName = parseAvdNameAnswer(
        await runAdbText({
          commandArguments: buildAvdNameChannelCommand(channel),
          deviceId,
          timeoutInMilliseconds: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS
        })
      );
    } catch {
      didChannelRespond = false;
    }

    if (reportedAvdName.length > 0) {
      return reportedAvdName;
    }

    channel = resolveNextAvdNameChannel({ channel, didChannelRespond });
  }

  return '';
}

/* v8 ignore stop */
