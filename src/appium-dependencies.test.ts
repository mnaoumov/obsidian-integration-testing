import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

import {
  checkIsAppiumDriverInstalled,
  resolveShouldAutoInstallAppiumDependencies,
  UIAUTOMATOR2_DRIVER_NAME
} from './appium-dependencies.ts';

const BASE_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

const INSTALLED_DRIVER_LIST_JSON = '{"uiautomator2":{"version":"4.2.3","installed":true}}';

describe('checkIsAppiumDriverInstalled', () => {
  it('should return true when the driver key is present in the installed list', () => {
    expect(
      checkIsAppiumDriverInstalled({ driverListJson: INSTALLED_DRIVER_LIST_JSON, driverName: UIAUTOMATOR2_DRIVER_NAME })
    ).toBe(true);
  });

  it('should return false when the driver is absent from a non-empty list', () => {
    expect(
      checkIsAppiumDriverInstalled({ driverListJson: '{"espresso":{"version":"1.0.0"}}', driverName: UIAUTOMATOR2_DRIVER_NAME })
    ).toBe(false);
  });

  it('should return false for an empty installed list', () => {
    expect(
      checkIsAppiumDriverInstalled({ driverListJson: '{}', driverName: UIAUTOMATOR2_DRIVER_NAME })
    ).toBe(false);
  });

  it('should return false when the JSON cannot be parsed', () => {
    expect(
      checkIsAppiumDriverInstalled({ driverListJson: 'not json', driverName: UIAUTOMATOR2_DRIVER_NAME })
    ).toBe(false);
  });

  it('should return false when the parsed JSON is not an object', () => {
    expect(
      checkIsAppiumDriverInstalled({ driverListJson: '"uiautomator2"', driverName: UIAUTOMATOR2_DRIVER_NAME })
    ).toBe(false);
  });

  it('should return false when the parsed JSON is null', () => {
    expect(
      checkIsAppiumDriverInstalled({ driverListJson: 'null', driverName: UIAUTOMATOR2_DRIVER_NAME })
    ).toBe(false);
  });
});

describe('resolveShouldAutoInstallAppiumDependencies', () => {
  it('should default to true when the option is omitted', () => {
    expect(resolveShouldAutoInstallAppiumDependencies(BASE_OPTIONS)).toBe(true);
  });

  it('should use the provided value when the option is set to false', () => {
    expect(
      resolveShouldAutoInstallAppiumDependencies({
        ...BASE_OPTIONS,
        shouldAutoInstallAppiumDependencies: false
      })
    ).toBe(false);
  });
});
