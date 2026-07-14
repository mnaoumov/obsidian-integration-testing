import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianVersionMetadata } from './obsidian-metadata.ts';

import { checkInstallerCompatibility } from './installer-compatibility.ts';

const APP_VERSION = '1.13.1';

describe('checkInstallerCompatibility', () => {
  it('is `unknown` when the installer version is not known', () => {
    const verdict = checkInstallerCompatibility({
      appVersion: APP_VERSION,
      installerVersion: undefined,
      metadata: { minRunnableInstallerVersion: '1.1.9' }
    });
    expect(verdict).toEqual({ appVersion: APP_VERSION, installerVersion: null, tier: 'unknown' });
  });

  it('is `unknown` when there is no metadata entry', () => {
    const verdict = checkInstallerCompatibility({
      appVersion: APP_VERSION,
      installerVersion: '1.1.9',
      metadata: undefined
    });
    expect(verdict).toEqual({ appVersion: APP_VERSION, installerVersion: '1.1.9', tier: 'unknown' });
  });

  it('is `unknown` when the entry has no run floor', () => {
    const metadata: ObsidianVersionMetadata = { channel: 'catalyst' };
    const verdict = checkInstallerCompatibility({ appVersion: APP_VERSION, installerVersion: '1.1.9', metadata });
    expect(verdict.tier).toBe('unknown');
    expect(verdict.installerVersion).toBe('1.1.9');
  });

  it('is `unrunnable` when the installer is below the run floor', () => {
    const metadata: ObsidianVersionMetadata = { minRunnableInstallerVersion: '1.1.9' };
    const verdict = checkInstallerCompatibility({ appVersion: APP_VERSION, installerVersion: '0.14.5', metadata });
    expect(verdict).toEqual({
      appVersion: APP_VERSION,
      installerVersion: '0.14.5',
      minRunnableInstallerVersion: '1.1.9',
      tier: 'unrunnable'
    });
  });

  it('carries the recommended floor on an `unrunnable` verdict when present', () => {
    const metadata: ObsidianVersionMetadata = {
      minRecommendedInstallerVersion: '0.11.0',
      minRunnableInstallerVersion: '0.6.4'
    };
    const verdict = checkInstallerCompatibility({ appVersion: '0.15.6', installerVersion: '0.5.0', metadata });
    expect(verdict.tier).toBe('unrunnable');
    expect(verdict.minRecommendedInstallerVersion).toBe('0.11.0');
    expect(verdict.minRunnableInstallerVersion).toBe('0.6.4');
  });

  it('is `nagged` when at/above the run floor but below the recommended floor', () => {
    const metadata: ObsidianVersionMetadata = {
      minRecommendedInstallerVersion: '0.11.0',
      minRunnableInstallerVersion: '0.6.4'
    };
    const verdict = checkInstallerCompatibility({ appVersion: '0.15.6', installerVersion: '0.6.4', metadata });
    expect(verdict.tier).toBe('nagged');
    expect(verdict.minRecommendedInstallerVersion).toBe('0.11.0');
    expect(verdict.message).toContain('0.11.0');
  });

  it('is `ok` when at/above the recommended floor', () => {
    const metadata: ObsidianVersionMetadata = {
      minRecommendedInstallerVersion: '0.11.0',
      minRunnableInstallerVersion: '0.6.4'
    };
    const verdict = checkInstallerCompatibility({ appVersion: '0.15.6', installerVersion: '0.12.0', metadata });
    expect(verdict).toEqual({
      appVersion: '0.15.6',
      installerVersion: '0.12.0',
      minRecommendedInstallerVersion: '0.11.0',
      minRunnableInstallerVersion: '0.6.4',
      tier: 'ok'
    });
  });

  it('is `ok` (no message) when at/above the run floor and no recommended floor is known', () => {
    const metadata: ObsidianVersionMetadata = { minRunnableInstallerVersion: '1.1.9' };
    const verdict = checkInstallerCompatibility({ appVersion: APP_VERSION, installerVersion: '1.5.8', metadata });
    expect(verdict).toEqual({
      appVersion: APP_VERSION,
      installerVersion: '1.5.8',
      minRunnableInstallerVersion: '1.1.9',
      tier: 'ok'
    });
    expect(verdict.message).toBeUndefined();
  });
});
