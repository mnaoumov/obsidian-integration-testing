/**
 * @file
 *
 * Reads and writes Android device settings — and wraps the one setting a
 * screenshot suite has to change.
 *
 * The screenshot AVDs are built `hw.keyboard=yes`, so Android suppresses the
 * on-screen keyboard even where the page asks for one. `show_ime_with_hard_keyboard`
 * is what turns it back on. {@link withSoftKeyboardEnabled} flips it, runs the
 * work, and puts the device back exactly as it found it — including restoring a
 * setting that had never been written, which takes a delete rather than a write
 * (see `device-setting-restore`).
 *
 * Every function here shells out, so the whole module is integration-time code;
 * the restore decision and the argument list it depends on are unit-tested in
 * their own modules.
 */

/* v8 ignore start -- Integration-time code (shells out to a real device) covered by integration tests, not unit tests. */

import type { DeviceSettingNamespace } from './device-settings-command.ts';

import { runAdbText } from './adb.ts';
import {
  DeviceSettingRestoreKind,
  resolveDeviceSettingRestore
} from './device-setting-restore.ts';
import {
  buildDeviceSettingsCommandArguments,
  DeviceSettingVerb
} from './device-settings-command.ts';

/**
 * Parameters for {@link deleteDeviceSetting} and {@link readDeviceSetting}.
 */
export interface DeviceSettingParams {
  /**
   * The device to address.
   */
  readonly deviceId: string;

  /**
   * The setting's name within {@link namespace}, e.g. `show_ime_with_hard_keyboard`.
   */
  readonly name: string;

  /**
   * The settings namespace the name lives in.
   *
   * @default {@link DeviceSettingNamespace.Secure}
   */
  readonly namespace?: DeviceSettingNamespace;
}

/**
 * Parameters for {@link withSoftKeyboardEnabled}.
 *
 * @typeParam T - What the wrapped work returns.
 */
export interface WithSoftKeyboardEnabledParams<T> {
  /**
   * The work to run while the on-screen keyboard is permitted.
   */
  readonly callback: (this: void) => Promise<T>;

  /**
   * The device to address.
   */
  readonly deviceId: string;
}

/**
 * Parameters for {@link writeDeviceSetting}.
 */
export interface WriteDeviceSettingParams extends DeviceSettingParams {
  /**
   * The value to write.
   */
  readonly value: string;
}

/**
 * The setting deciding whether Android draws a keyboard while a hardware one is attached.
 */
const SOFT_KEYBOARD_SETTING_NAME = 'show_ime_with_hard_keyboard';

const SOFT_KEYBOARD_SETTING_ON = '1';

/**
 * Clears a device setting, returning it to never-having-been-written.
 *
 * @param params - The device, the setting and its namespace.
 * @returns A {@link Promise} that resolves once the setting is gone.
 */
export async function deleteDeviceSetting(params: DeviceSettingParams): Promise<void> {
  await runAdbText({
    commandArguments: buildDeviceSettingsCommandArguments({
      name: params.name,
      ...(params.namespace !== undefined && { namespace: params.namespace }),
      verb: DeviceSettingVerb.Delete
    }),
    deviceId: params.deviceId
  });
}

/**
 * Reads a device setting.
 *
 * @param params - The device, the setting and its namespace.
 * @returns A {@link Promise} that resolves to the setting's value, or the literal `null` when it has never
 *   been written.
 */
export async function readDeviceSetting(params: DeviceSettingParams): Promise<string> {
  return await runAdbText({
    commandArguments: buildDeviceSettingsCommandArguments({
      name: params.name,
      ...(params.namespace !== undefined && { namespace: params.namespace }),
      verb: DeviceSettingVerb.Get
    }),
    deviceId: params.deviceId
  });
}

/**
 * Permits the on-screen keyboard for the duration of a callback, then restores the device exactly.
 *
 * The restore runs whether the callback succeeded or threw — a suite that dies mid-capture must not leave
 * the device configured differently than it found it.
 *
 * @typeParam T - What the wrapped work returns.
 * @param params - The device and the work to run.
 * @returns A {@link Promise} that resolves to whatever the callback returned.
 */
export async function withSoftKeyboardEnabled<T>(params: WithSoftKeyboardEnabledParams<T>): Promise<T> {
  const settingParams: DeviceSettingParams = {
    deviceId: params.deviceId,
    name: SOFT_KEYBOARD_SETTING_NAME
  };

  const previousValue = await readDeviceSetting(settingParams);
  await writeDeviceSetting({ ...settingParams, value: SOFT_KEYBOARD_SETTING_ON });

  try {
    return await params.callback();
  } finally {
    const restore = resolveDeviceSettingRestore(previousValue);
    if (restore.kind === DeviceSettingRestoreKind.Delete) {
      await deleteDeviceSetting(settingParams);
    } else {
      await writeDeviceSetting({ ...settingParams, value: restore.value });
    }
  }
}

/**
 * Writes a device setting.
 *
 * @param params - The device, the setting, its namespace and the value to write.
 * @returns A {@link Promise} that resolves once the setting is written.
 */
export async function writeDeviceSetting(params: WriteDeviceSettingParams): Promise<void> {
  await runAdbText({
    commandArguments: buildDeviceSettingsCommandArguments({
      name: params.name,
      ...(params.namespace !== undefined && { namespace: params.namespace }),
      value: params.value,
      verb: DeviceSettingVerb.Put
    }),
    deviceId: params.deviceId
  });
}

/* v8 ignore stop */
