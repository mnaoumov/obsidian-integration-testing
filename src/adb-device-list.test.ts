import {
  describe,
  expect,
  it
} from 'vitest';

import {
  checkIsDeviceListed,
  listOnlineDeviceIds,
  parseAdbDevices
} from './adb-device-list.ts';

const DEVICES_OUTPUT = [
  'List of devices attached',
  'emulator-5554\tdevice',
  '3C15BN001Y900000\tdevice',
  ''
].join('\n');

const DEVICES_OUTPUT_WITH_OFFLINE_EMULATOR = [
  'List of devices attached',
  'emulator-5554\toffline',
  '3C15BN001Y900000\tdevice',
  ''
].join('\n');

describe('parseAdbDevices', () => {
  it('should parse the device ID and state of every listed device', () => {
    expect(parseAdbDevices(DEVICES_OUTPUT)).toEqual([
      { deviceId: 'emulator-5554', state: 'device' },
      { deviceId: '3C15BN001Y900000', state: 'device' }
    ]);
  });

  it('should skip the header line, which carries no tab', () => {
    expect(parseAdbDevices('List of devices attached\n')).toEqual([]);
  });

  it('should skip the daemon banner adb prints before the listing', () => {
    const output = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554\tdevice',
      ''
    ].join('\n');

    expect(parseAdbDevices(output)).toEqual([{ deviceId: 'emulator-5554', state: 'device' }]);
  });

  it('should tolerate the CRLF line endings adb emits on Windows', () => {
    expect(parseAdbDevices('List of devices attached\r\nemulator-5554\tdevice\r\n')).toEqual([
      { deviceId: 'emulator-5554', state: 'device' }
    ]);
  });

  it('should keep a device whose state is not `device`', () => {
    expect(parseAdbDevices(DEVICES_OUTPUT_WITH_OFFLINE_EMULATOR)).toEqual([
      { deviceId: 'emulator-5554', state: 'offline' },
      { deviceId: '3C15BN001Y900000', state: 'device' }
    ]);
  });

  it('should keep a multi-word state intact', () => {
    expect(parseAdbDevices('List of devices attached\nemulator-5554\tno permissions (udev)\n')).toEqual([
      { deviceId: 'emulator-5554', state: 'no permissions (udev)' }
    ]);
  });

  it('should return an empty array for empty output', () => {
    expect(parseAdbDevices('')).toEqual([]);
  });
});

describe('listOnlineDeviceIds', () => {
  it('should return every device in the `device` state', () => {
    expect(listOnlineDeviceIds(DEVICES_OUTPUT)).toEqual(['emulator-5554', '3C15BN001Y900000']);
  });

  it('should exclude a device that is listed but not online', () => {
    expect(listOnlineDeviceIds(DEVICES_OUTPUT_WITH_OFFLINE_EMULATOR)).toEqual(['3C15BN001Y900000']);
  });

  it('should return an empty array for empty output', () => {
    expect(listOnlineDeviceIds('')).toEqual([]);
  });
});

describe('checkIsDeviceListed', () => {
  it('should report an online device as listed', () => {
    expect(checkIsDeviceListed({ deviceId: 'emulator-5554', devicesOutput: DEVICES_OUTPUT })).toBe(true);
  });

  /*
   * The teardown's question is "is the emulator gone?", not "is it usable?". A
   * dying emulator answers `offline` while it still holds the AVD lock and the
   * console port, so reading `offline` as gone is what lets the next run collide
   * with it.
   */
  it('should report an offline device as still listed', () => {
    expect(checkIsDeviceListed({ deviceId: 'emulator-5554', devicesOutput: DEVICES_OUTPUT_WITH_OFFLINE_EMULATOR })).toBe(true);
  });

  it('should report an absent device as not listed', () => {
    expect(checkIsDeviceListed({ deviceId: 'emulator-5556', devicesOutput: DEVICES_OUTPUT })).toBe(false);
  });

  it('should report every device as absent for empty output', () => {
    expect(checkIsDeviceListed({ deviceId: 'emulator-5554', devicesOutput: '' })).toBe(false);
  });
});
