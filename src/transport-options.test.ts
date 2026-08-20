import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

import { checkIsMobileTransport } from './transport-options.ts';

const ANDROID_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

describe('checkIsMobileTransport', () => {
  it('reports an Android Appium transport as mobile', () => {
    expect(checkIsMobileTransport(ANDROID_OPTIONS)).toBe(true);
  });

  it('reports a desktop CDP transport as not mobile', () => {
    expect(checkIsMobileTransport({ type: 'obsidian-cdp' })).toBe(false);
    // The other knobs must not enter into it -- the caller consults this before a transport exists, so
    // The discriminant is the only field it can rely on.
    expect(checkIsMobileTransport({ isObsidianAppVisible: true, type: 'obsidian-cdp' })).toBe(false);
  });
});
