import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildEmulatorBootTimeoutMessage,
  DEFAULT_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS,
  describeEmulatorBootBudget,
  resolveEmulatorBootBudget,
  SINGLE_CORE_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS
} from './emulator-boot-budget.ts';

describe('resolveEmulatorBootBudget', () => {
  it('should give a one-core boot 600 s', () => {
    expect(resolveEmulatorBootBudget({ coreCount: 1 })).toEqual({ coreCount: 1, isOverridden: false, timeoutInMilliseconds: SINGLE_CORE_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS });
    expect(SINGLE_CORE_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS).toBe(600_000);
  });

  it.each([2, 4])('should keep 300 s at %i cores', (coreCount) => {
    expect(resolveEmulatorBootBudget({ coreCount })).toEqual({ coreCount, isOverridden: false, timeoutInMilliseconds: DEFAULT_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS });
    expect(DEFAULT_EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS).toBe(300_000);
  });

  it('should keep 300 s for a device whose core count is unknown', () => {
    expect(resolveEmulatorBootBudget({})).toEqual({ coreCount: undefined, isOverridden: false, timeoutInMilliseconds: 300_000 });
  });

  it('should let the override win at any core count', () => {
    expect(resolveEmulatorBootBudget({ coreCount: 1, overrideInMilliseconds: 900_000 })).toEqual({ coreCount: 1, isOverridden: true, timeoutInMilliseconds: 900_000 });
    expect(resolveEmulatorBootBudget({ overrideInMilliseconds: 60_000 })).toEqual({ coreCount: undefined, isOverridden: true, timeoutInMilliseconds: 60_000 });
  });

  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('should reject the override %s', (overrideInMilliseconds) => {
    expect(() => resolveEmulatorBootBudget({ coreCount: 1, overrideInMilliseconds })).toThrow('emulatorBootTimeoutInMilliseconds must be a positive safe integer.');
  });
});

describe('describeEmulatorBootBudget', () => {
  it('should name one core in the singular', () => {
    expect(describeEmulatorBootBudget(resolveEmulatorBootBudget({ coreCount: 1 }))).toBe('600000ms boot budget (1 guest core)');
  });

  it('should name several cores in the plural', () => {
    expect(describeEmulatorBootBudget(resolveEmulatorBootBudget({ coreCount: 4 }))).toBe('300000ms boot budget (4 guest cores)');
  });

  it('should say when the core count is unknown and when the budget was overridden', () => {
    expect(describeEmulatorBootBudget(resolveEmulatorBootBudget({ overrideInMilliseconds: 450_000 }))).toBe(
      '450000ms boot budget (guest core count unknown: the device was not launched by this run, set by emulatorBootTimeoutInMilliseconds)'
    );
  });
});

describe('buildEmulatorBootTimeoutMessage', () => {
  it('should name the device, the budget, the connected time and the core count', () => {
    expect(buildEmulatorBootTimeoutMessage({
      bootBudget: resolveEmulatorBootBudget({ coreCount: 1 }),
      connectedForInMilliseconds: 570_123,
      deviceId: 'emulator-5554'
    })).toBe(
      'Device "emulator-5554" connected but did not finish booting within 600000ms (it was connected for the last 570123ms of that budget; 600000ms boot budget (1 guest core)).'
    );
  });
});
