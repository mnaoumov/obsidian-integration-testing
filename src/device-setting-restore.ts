/**
 * @file
 *
 * Decides how a device setting that was changed for a capture gets put back.
 *
 * A suite that flips a setting owes the device its original value back —
 * including the case where it never had one. `settings get` prints the literal
 * `null` for a setting that has never been written, and `settings put … null`
 * does **not** reproduce that state: it writes the four-character string
 * `null`. Restoring an unset setting takes `settings delete`, which is why this
 * is a decision rather than a straight write-back.
 *
 * Pure and unit-tested; the calls that carry it out live in `device-settings`.
 */

/**
 * How a setting is restored.
 */
export enum DeviceSettingRestoreKind {
  /**
   * The setting had never been written, so restoring it means removing it again.
   */
  Delete = 'delete',

  /**
   * The setting held a value, which is written back verbatim.
   */
  Write = 'write'
}

/**
 * What restoring a setting requires: putting a value back, or removing it again.
 */
export type DeviceSettingRestore = DeviceSettingRestoreDelete | DeviceSettingRestoreWrite;

/**
 * Restoring a setting by removing it, because it had never been written.
 */
export interface DeviceSettingRestoreDelete {
  /**
   * Discriminates the union.
   */
  readonly kind: DeviceSettingRestoreKind.Delete;
}

/**
 * Restoring a setting by writing its previous value back.
 */
export interface DeviceSettingRestoreWrite {
  /**
   * Discriminates the union.
   */
  readonly kind: DeviceSettingRestoreKind.Write;

  /**
   * The value to write back, exactly as it was read.
   */
  readonly value: string;
}

/**
 * What `settings get` prints for a setting that has never been written.
 */
const UNSET_SETTING_VALUE = 'null';

/**
 * Decides how a setting read before a change is put back afterwards.
 *
 * @param previousValue - Exactly what `readDeviceSetting` returned before the change.
 * @returns Whether to write the value back or to remove the setting again.
 */
export function resolveDeviceSettingRestore(previousValue: string): DeviceSettingRestore {
  if (previousValue === UNSET_SETTING_VALUE) {
    return { kind: DeviceSettingRestoreKind.Delete };
  }

  return {
    kind: DeviceSettingRestoreKind.Write,
    value: previousValue
  };
}
