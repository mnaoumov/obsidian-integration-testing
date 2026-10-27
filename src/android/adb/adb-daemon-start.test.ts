import {
  describe,
  expect,
  it
} from 'vitest';

import { checkIsAdbDaemonStarting } from './adb-daemon-start.ts';

describe('checkIsAdbDaemonStarting', () => {
  it('should recognize the message from a killed cold-start listing', () => {
    expect(checkIsAdbDaemonStarting('Command failed: adb devices\n* daemon not running; starting now at tcp:5037\n')).toBe(true);
  });

  it('should not match a listing failure with another cause', () => {
    expect(checkIsAdbDaemonStarting('spawn adb ENOENT')).toBe(false);
  });

  it('should not match a normal listing', () => {
    expect(checkIsAdbDaemonStarting('List of devices attached\nemulator-5554\tdevice\n')).toBe(false);
  });
});
