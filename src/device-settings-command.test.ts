import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildDeviceSettingsCommandArguments,
  DeviceSettingNamespace,
  DeviceSettingVerb
} from './device-settings-command.ts';

describe('buildDeviceSettingsCommandArguments', () => {
  it('should build a read', () => {
    expect(buildDeviceSettingsCommandArguments({ name: 'show_ime_with_hard_keyboard', verb: DeviceSettingVerb.Get })).toEqual([
      'shell',
      'settings',
      'get',
      'secure',
      'show_ime_with_hard_keyboard'
    ]);
  });

  it('should append the value on a write', () => {
    expect(
      buildDeviceSettingsCommandArguments({
        name: 'show_ime_with_hard_keyboard',
        value: '1',
        verb: DeviceSettingVerb.Put
      })
    ).toEqual([
      'shell',
      'settings',
      'put',
      'secure',
      'show_ime_with_hard_keyboard',
      '1'
    ]);
  });

  it('should build a delete, which takes no value', () => {
    expect(buildDeviceSettingsCommandArguments({ name: 'show_ime_with_hard_keyboard', verb: DeviceSettingVerb.Delete })).toEqual([
      'shell',
      'settings',
      'delete',
      'secure',
      'show_ime_with_hard_keyboard'
    ]);
  });

  /*
   * This is the test the `@default` tag on `namespace` owes: the documented default is only true if
   * omitting the member actually produces it.
   */
  it('should default the namespace to secure', () => {
    const withoutNamespace = buildDeviceSettingsCommandArguments({ name: 'a_setting', verb: DeviceSettingVerb.Get });
    const withSecure = buildDeviceSettingsCommandArguments({
      name: 'a_setting',
      namespace: DeviceSettingNamespace.Secure,
      verb: DeviceSettingVerb.Get
    });

    expect(withoutNamespace).toEqual(withSecure);
    expect(withoutNamespace).toContain('secure');
  });

  it('should honour a namespace other than secure', () => {
    expect(
      buildDeviceSettingsCommandArguments({
        name: 'hide_error_dialogs',
        namespace: DeviceSettingNamespace.Global,
        value: '1',
        verb: DeviceSettingVerb.Put
      })
    ).toEqual([
      'shell',
      'settings',
      'put',
      'global',
      'hide_error_dialogs',
      '1'
    ]);
  });

  /*
   * A value handed to a non-write verb is a caller mistake, and `settings get secure name 1` is not an
   * error adb reports — it silently ignores the extra argument. Dropping it here keeps the mistake from
   * becoming a command that reads as if it worked.
   */
  it('should ignore a value passed to a verb that takes none', () => {
    expect(
      buildDeviceSettingsCommandArguments({
        name: 'a_setting',
        value: '1',
        verb: DeviceSettingVerb.Get
      })
    ).toEqual([
      'shell',
      'settings',
      'get',
      'secure',
      'a_setting'
    ]);
  });

  it('should keep an empty-string value, which is a legitimate setting value', () => {
    expect(
      buildDeviceSettingsCommandArguments({
        name: 'a_setting',
        value: '',
        verb: DeviceSettingVerb.Put
      })
    ).toEqual([
      'shell',
      'settings',
      'put',
      'secure',
      'a_setting',
      ''
    ]);
  });
});
