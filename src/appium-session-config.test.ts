import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

import {
  DEFAULT_SESSION_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS,
  resolveSessionConnectionRetryTimeoutInMilliseconds
} from './appium-session-config.ts';

const BASE_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

describe('resolveSessionConnectionRetryTimeoutInMilliseconds', () => {
  it('should default to 180000ms when the option is omitted', () => {
    expect(resolveSessionConnectionRetryTimeoutInMilliseconds(BASE_OPTIONS)).toBe(180000);
    expect(DEFAULT_SESSION_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS).toBe(180000);
  });

  it('should use the provided value when the option is set', () => {
    const CUSTOM_TIMEOUT_IN_MILLISECONDS = 420000;
    expect(
      resolveSessionConnectionRetryTimeoutInMilliseconds({
        ...BASE_OPTIONS,
        sessionConnectionRetryTimeoutInMilliseconds: CUSTOM_TIMEOUT_IN_MILLISECONDS
      })
    ).toBe(CUSTOM_TIMEOUT_IN_MILLISECONDS);
  });
});
