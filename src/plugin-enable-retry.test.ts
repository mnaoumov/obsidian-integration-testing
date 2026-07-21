import {
  describe,
  expect,
  it
} from 'vitest';

import type { EnablePluginResult } from './enable-plugin.ts';
import type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianCdpTransportOptions
} from './transport-options.ts';

import {
  computeBackoffDelayInMilliseconds,
  DEFAULT_PLUGIN_ENABLE_RETRY_COUNT,
  DEFAULT_PLUGIN_ENABLE_RETRY_DELAY_IN_MILLISECONDS,
  resolvePluginEnableRetryCount,
  resolvePluginEnableRetryDelayInMilliseconds,
  shouldRetryPluginEnable
} from './plugin-enable-retry.ts';

const ANDROID_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

const CDP_OPTIONS: ObsidianCdpTransportOptions = {
  type: 'obsidian-cdp'
};

/** Builds an {@link EnablePluginResult}, defaulting to the transient swallow signature. */
function makeResult(overrides: Partial<EnablePluginResult> = {}): EnablePluginResult {
  return {
    errorMessage: undefined,
    isEnabled: true,
    isLoaded: false,
    rendererConsoleErrors: undefined,
    ...overrides
  };
}

describe('resolvePluginEnableRetryCount', () => {
  it('should default to 3 when the option is omitted', () => {
    expect(resolvePluginEnableRetryCount(ANDROID_OPTIONS)).toBe(3);
    expect(DEFAULT_PLUGIN_ENABLE_RETRY_COUNT).toBe(3);
  });

  it('should use the provided value when the option is set', () => {
    const CUSTOM_COUNT = 5;
    expect(
      resolvePluginEnableRetryCount({ ...ANDROID_OPTIONS, pluginEnableRetryCount: CUSTOM_COUNT })
    ).toBe(CUSTOM_COUNT);
  });

  it('should allow 0 to disable retry', () => {
    expect(
      resolvePluginEnableRetryCount({ ...ANDROID_OPTIONS, pluginEnableRetryCount: 0 })
    ).toBe(0);
  });

  it('should fall back to the default for non-Android transports', () => {
    expect(resolvePluginEnableRetryCount(CDP_OPTIONS)).toBe(DEFAULT_PLUGIN_ENABLE_RETRY_COUNT);
  });

  it('should fall back to the default when options are null', () => {
    expect(resolvePluginEnableRetryCount(null)).toBe(DEFAULT_PLUGIN_ENABLE_RETRY_COUNT);
  });
});

describe('resolvePluginEnableRetryDelayInMilliseconds', () => {
  it('should default to 2000ms when the option is omitted', () => {
    expect(resolvePluginEnableRetryDelayInMilliseconds(ANDROID_OPTIONS)).toBe(2000);
    expect(DEFAULT_PLUGIN_ENABLE_RETRY_DELAY_IN_MILLISECONDS).toBe(2000);
  });

  it('should use the provided value when the option is set', () => {
    const CUSTOM_DELAY_IN_MILLISECONDS = 500;
    expect(
      resolvePluginEnableRetryDelayInMilliseconds({
        ...ANDROID_OPTIONS,
        pluginEnableRetryDelayInMilliseconds: CUSTOM_DELAY_IN_MILLISECONDS
      })
    ).toBe(CUSTOM_DELAY_IN_MILLISECONDS);
  });

  it('should allow 0 for no delay between attempts', () => {
    expect(
      resolvePluginEnableRetryDelayInMilliseconds({
        ...ANDROID_OPTIONS,
        pluginEnableRetryDelayInMilliseconds: 0
      })
    ).toBe(0);
  });

  it('should fall back to the default for non-Android transports', () => {
    expect(
      resolvePluginEnableRetryDelayInMilliseconds(CDP_OPTIONS)
    ).toBe(DEFAULT_PLUGIN_ENABLE_RETRY_DELAY_IN_MILLISECONDS);
  });
});

describe('computeBackoffDelayInMilliseconds', () => {
  const BASE_DELAY_IN_MILLISECONDS = 2000;

  it('should return the base delay for the first retry', () => {
    expect(computeBackoffDelayInMilliseconds(BASE_DELAY_IN_MILLISECONDS, 0)).toBe(2000);
  });

  it('should double the delay for the second retry', () => {
    expect(computeBackoffDelayInMilliseconds(BASE_DELAY_IN_MILLISECONDS, 1)).toBe(4000);
  });

  it('should grow exponentially for later retries', () => {
    expect(computeBackoffDelayInMilliseconds(BASE_DELAY_IN_MILLISECONDS, 2)).toBe(8000);
    expect(computeBackoffDelayInMilliseconds(BASE_DELAY_IN_MILLISECONDS, 3)).toBe(16000);
  });

  it('should stay 0 when the base delay is 0', () => {
    expect(computeBackoffDelayInMilliseconds(0, 2)).toBe(0);
  });
});

describe('shouldRetryPluginEnable', () => {
  it('should retry the transient swallow signature (enabled but not loaded, no cause)', () => {
    expect(shouldRetryPluginEnable(makeResult())).toBe(true);
  });

  it('should not retry once the plugin has loaded', () => {
    expect(shouldRetryPluginEnable(makeResult({ isLoaded: true }))).toBe(false);
  });

  it('should not retry a captured monkey-patch error (deterministic bug)', () => {
    expect(shouldRetryPluginEnable(makeResult({ errorMessage: 'boom' }))).toBe(false);
  });

  it('should not retry a captured renderer console error (deterministic bug)', () => {
    expect(shouldRetryPluginEnable(makeResult({ rendererConsoleErrors: 'TypeError: x' }))).toBe(false);
  });
});
