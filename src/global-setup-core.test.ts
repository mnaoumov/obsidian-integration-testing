import {
  describe,
  expect,
  it
} from 'vitest';

import { resolveIntegrationTransportOptions } from './global-setup-core.ts';

describe('resolveIntegrationTransportOptions', () => {
  it('should hide the default desktop instance', () => {
    expect(resolveIntegrationTransportOptions()).toStrictEqual({
      isObsidianAppVisible: false,
      type: 'obsidian-cdp'
    });
  });

  it('should hide a desktop instance when visibility is not configured', () => {
    expect(resolveIntegrationTransportOptions({ type: 'obsidian-cdp' })).toStrictEqual({
      isObsidianAppVisible: false,
      type: 'obsidian-cdp'
    });
  });

  it('should preserve an explicitly configured desktop visibility', () => {
    expect(resolveIntegrationTransportOptions({
      isObsidianAppVisible: true,
      type: 'obsidian-cdp'
    })).toStrictEqual({
      isObsidianAppVisible: true,
      type: 'obsidian-cdp'
    });
  });

  it('should preserve Android transport options', () => {
    const options = {
      appiumUrl: 'http://localhost:4723',
      avdName: 'alpha',
      type: 'obsidian-android-appium' as const
    };

    expect(resolveIntegrationTransportOptions(options)).toBe(options);
  });
});
