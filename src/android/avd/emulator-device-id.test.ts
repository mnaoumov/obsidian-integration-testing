import {
  describe,
  expect,
  it
} from 'vitest';

import type { EmulatorDeviceCandidate } from './emulator-device-id.ts';

import { selectEmulatorDeviceId } from './emulator-device-id.ts';

/**
 * The shape this machine routinely presents: two emulators at different geometries, in an order nothing
 * guarantees.
 */
const CANDIDATES: EmulatorDeviceCandidate[] = [
  { avdName: 'obsidian_test', deviceId: 'emulator-5554' },
  { avdName: 'obsidian_screenshots', deviceId: 'emulator-5556' }
];

describe('selectEmulatorDeviceId', () => {
  it('should return the device whose AVD matches', () => {
    expect(selectEmulatorDeviceId({ avdName: 'obsidian_screenshots', candidates: CANDIDATES })).toBe('emulator-5556');
  });

  /*
   * The defect this function exists to prevent. Taking the first listed device gives `emulator-5554`, the
   * 1344x2992 harness AVD, and the store frame comes out at the wrong size several minutes later.
   */
  it('should not fall back to the first device when it is a different AVD', () => {
    expect(selectEmulatorDeviceId({ avdName: 'obsidian_screenshots', candidates: CANDIDATES })).not.toBe('emulator-5554');
  });

  it('should return null when no running emulator carries that AVD', () => {
    expect(selectEmulatorDeviceId({ avdName: 'obsidian_missing', candidates: CANDIDATES })).toBeNull();
  });

  it('should return null when nothing is running', () => {
    expect(selectEmulatorDeviceId({ avdName: 'obsidian_screenshots', candidates: [] })).toBeNull();
  });

  it('should match exactly, not by prefix', () => {
    const candidates: EmulatorDeviceCandidate[] = [{ avdName: 'obsidian_screenshots_old', deviceId: 'emulator-5554' }];

    expect(selectEmulatorDeviceId({ avdName: 'obsidian_screenshots', candidates })).toBeNull();
  });

  it('should return the first match when two emulators share an AVD name', () => {
    const candidates: EmulatorDeviceCandidate[] = [
      { avdName: 'obsidian_screenshots', deviceId: 'emulator-5554' },
      { avdName: 'obsidian_screenshots', deviceId: 'emulator-5556' }
    ];

    expect(selectEmulatorDeviceId({ avdName: 'obsidian_screenshots', candidates })).toBe('emulator-5554');
  });
});
