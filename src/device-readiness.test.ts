import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

import {
  checkDeviceIdle,
  DEFAULT_DEVICE_IDLE_TIMEOUT_IN_MILLISECONDS,
  resolveDeviceIdleTimeoutInMilliseconds
} from './device-readiness.ts';

const BASE_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

const PACKAGE_LIST_OUTPUT = 'package:md.obsidian\npackage:com.android.settings\n';

describe('checkDeviceIdle', () => {
  it('should be idle when the boot animation has stopped and packages are listed', () => {
    expect(
      checkDeviceIdle({ bootAnimationProp: 'stopped\n', packageListOutput: PACKAGE_LIST_OUTPUT })
    ).toBe(true);
  });

  it('should tolerate surrounding whitespace in the boot animation prop', () => {
    expect(
      checkDeviceIdle({ bootAnimationProp: '  stopped  ', packageListOutput: PACKAGE_LIST_OUTPUT })
    ).toBe(true);
  });

  it('should not be idle while the boot animation is still running', () => {
    expect(
      checkDeviceIdle({ bootAnimationProp: 'running\n', packageListOutput: PACKAGE_LIST_OUTPUT })
    ).toBe(false);
  });

  it('should not be idle when the boot animation prop is empty', () => {
    expect(
      checkDeviceIdle({ bootAnimationProp: '', packageListOutput: PACKAGE_LIST_OUTPUT })
    ).toBe(false);
  });

  it('should not be idle when the package manager lists no packages yet', () => {
    expect(
      checkDeviceIdle({ bootAnimationProp: 'stopped', packageListOutput: '' })
    ).toBe(false);
  });

  it('should ignore non-package lines in the package list output', () => {
    expect(
      checkDeviceIdle({ bootAnimationProp: 'stopped', packageListOutput: 'Error: something\n' })
    ).toBe(false);
  });
});

describe('resolveDeviceIdleTimeoutInMilliseconds', () => {
  it('should default to 60000ms when the option is omitted', () => {
    expect(resolveDeviceIdleTimeoutInMilliseconds(BASE_OPTIONS)).toBe(60000);
    expect(DEFAULT_DEVICE_IDLE_TIMEOUT_IN_MILLISECONDS).toBe(60000);
  });

  it('should use the provided value when the option is set', () => {
    const CUSTOM_TIMEOUT_IN_MILLISECONDS = 90000;
    expect(
      resolveDeviceIdleTimeoutInMilliseconds({
        ...BASE_OPTIONS,
        deviceIdleTimeoutInMilliseconds: CUSTOM_TIMEOUT_IN_MILLISECONDS
      })
    ).toBe(CUSTOM_TIMEOUT_IN_MILLISECONDS);
  });

  it('should allow 0 to skip the wait', () => {
    expect(
      resolveDeviceIdleTimeoutInMilliseconds({
        ...BASE_OPTIONS,
        deviceIdleTimeoutInMilliseconds: 0
      })
    ).toBe(0);
  });
});
