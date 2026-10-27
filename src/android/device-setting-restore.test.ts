import {
  describe,
  expect,
  it
} from 'vitest';

import {
  DeviceSettingRestoreKind,
  resolveDeviceSettingRestore
} from './device-setting-restore.ts';

describe('resolveDeviceSettingRestore', () => {
  /*
   * The whole reason this is a decision rather than a write-back. `settings get` prints the literal `null`
   * for a setting that was never written, and `settings put … null` writes the four-character string
   * instead of restoring the absence — so a device that started unset has to be `settings delete`d back.
   */
  it('should restore a never-written setting by deleting it', () => {
    expect(resolveDeviceSettingRestore('null')).toEqual({ kind: DeviceSettingRestoreKind.Delete });
  });

  it('should restore a written setting by writing its value back', () => {
    expect(resolveDeviceSettingRestore('0')).toEqual({ kind: DeviceSettingRestoreKind.Write, value: '0' });
  });

  it('should write back the value the suite itself would have set, rather than treating it as already correct', () => {
    expect(resolveDeviceSettingRestore('1')).toEqual({ kind: DeviceSettingRestoreKind.Write, value: '1' });
  });

  /*
   * An empty value is not an absent one: it is a setting that exists and holds nothing, which
   * `settings put` can reproduce and `settings delete` cannot.
   */
  it('should write back an empty value rather than deleting the setting', () => {
    expect(resolveDeviceSettingRestore('')).toEqual({ kind: DeviceSettingRestoreKind.Write, value: '' });
  });

  it('should treat a value that merely contains null as a real value', () => {
    expect(resolveDeviceSettingRestore('nullable')).toEqual({ kind: DeviceSettingRestoreKind.Write, value: 'nullable' });
  });
});
