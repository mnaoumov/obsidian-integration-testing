import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianVersionMetadata } from './obsidian-metadata.ts';

import { checkElectronCompatibility } from './electron-compatibility.ts';

const APP_VERSION = '1.13.1';

describe('checkElectronCompatibility', () => {
  it('is `unknown` when the actual Electron version is not known', () => {
    const verdict = checkElectronCompatibility({
      actualElectronVersion: undefined,
      appVersion: APP_VERSION,
      metadata: { minRecommendedElectronVersion: '28.2.3' }
    });
    expect(verdict).toEqual({ actualElectronVersion: null, appVersion: APP_VERSION, tier: 'unknown' });
  });

  it('is `unknown` when there is no metadata entry', () => {
    const verdict = checkElectronCompatibility({
      actualElectronVersion: '18.0.0',
      appVersion: APP_VERSION,
      metadata: undefined
    });
    expect(verdict).toEqual({ actualElectronVersion: '18.0.0', appVersion: APP_VERSION, tier: 'unknown' });
  });

  it('is `unknown` when the entry has no recommended Electron version', () => {
    const metadata: ObsidianVersionMetadata = { channel: 'catalyst' };
    const verdict = checkElectronCompatibility({ actualElectronVersion: '18.0.0', appVersion: APP_VERSION, metadata });
    expect(verdict.tier).toBe('unknown');
    expect(verdict.actualElectronVersion).toBe('18.0.0');
  });

  it('is `nagged` when the actual Electron version is below the recommended version', () => {
    const metadata: ObsidianVersionMetadata = { minRecommendedElectronVersion: '28.2.3' };
    const verdict = checkElectronCompatibility({ actualElectronVersion: '18.0.0', appVersion: APP_VERSION, metadata });
    expect(verdict.tier).toBe('nagged');
    expect(verdict.minRecommendedElectronVersion).toBe('28.2.3');
    expect(verdict.message).toContain('28.2.3');
    expect(verdict.message).toContain('18.0.0');
  });

  it('is `ok` when the actual Electron version equals the recommended version', () => {
    const metadata: ObsidianVersionMetadata = { minRecommendedElectronVersion: '28.2.3' };
    const verdict = checkElectronCompatibility({ actualElectronVersion: '28.2.3', appVersion: APP_VERSION, metadata });
    expect(verdict).toEqual({
      actualElectronVersion: '28.2.3',
      appVersion: APP_VERSION,
      minRecommendedElectronVersion: '28.2.3',
      tier: 'ok'
    });
    expect(verdict.message).toBeUndefined();
  });

  it('is `ok` when the actual Electron version is above the recommended version', () => {
    const metadata: ObsidianVersionMetadata = { minRecommendedElectronVersion: '28.2.3' };
    const verdict = checkElectronCompatibility({ actualElectronVersion: '30.0.0', appVersion: APP_VERSION, metadata });
    expect(verdict).toEqual({
      actualElectronVersion: '30.0.0',
      appVersion: APP_VERSION,
      minRecommendedElectronVersion: '28.2.3',
      tier: 'ok'
    });
  });
});
