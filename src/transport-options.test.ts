import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

import {
  checkIsMobileTransport,
  resolveOwnedConfigDirectory
} from './transport-options.ts';

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

describe('resolveOwnedConfigDirectory', () => {
  it('returns the override when the harness owns the instance', () => {
    expect(resolveOwnedConfigDirectory({ configDirectory: '.obsidian-desktop', type: 'obsidian-cdp' })).toBe('.obsidian-desktop');
  });

  it('returns undefined when no override is configured', () => {
    expect(resolveOwnedConfigDirectory({ type: 'obsidian-cdp' })).toBeUndefined();
  });

  it('ignores the override in attach mode, where the vault is opened under the user own config', () => {
    // `port` is the attach discriminator, and the option's own docs call it ignored there. Honouring it
    // Anyway would write the harness defaults into a folder the attached Obsidian never reads.
    expect(resolveOwnedConfigDirectory({ configDirectory: '.obsidian-desktop', port: 9222, type: 'obsidian-cdp' })).toBeUndefined();
  });

  it('returns undefined for a mobile transport, which has no override at all', () => {
    expect(resolveOwnedConfigDirectory(ANDROID_OPTIONS)).toBeUndefined();
  });
});
