import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianTransportOptions } from './transport-options.ts';

import {
  getSetupError,
  getTransportOptions,
  getVaultPath,
  setSetupErrorResolver,
  setTransportOptionsResolver,
  setVaultPathResolver
} from './context-provider.ts';

describe('context-provider', () => {
  describe('getSetupError', () => {
    it('should return null when no resolver is registered', () => {
      setSetupErrorResolver(() => null);
      expect(getSetupError()).toBeNull();
    });

    it('should return the value from the registered resolver', () => {
      const setupError = {
        errorName: 'WebDriverError',
        message: 'WebDriverError: Could not find a connected Android device in 20000ms',
        transportLabel: 'obsidian-android-appium'
      };
      setSetupErrorResolver(() => setupError);
      expect(getSetupError()).toBe(setupError);
    });
  });

  describe('getTransportOptions', () => {
    it('should return null when no resolver is registered', () => {
      setTransportOptionsResolver(() => null);
      expect(getTransportOptions()).toBeNull();
    });

    it('should return the value from the registered resolver', () => {
      const options: ObsidianTransportOptions = { type: 'obsidian-cdp' };
      setTransportOptionsResolver(() => options);
      expect(getTransportOptions()).toBe(options);
    });
  });

  describe('getVaultPath', () => {
    it('should return null when no resolver is registered', () => {
      setVaultPathResolver(() => null);
      expect(getVaultPath()).toBeNull();
    });

    it('should return the value from the registered resolver', () => {
      const vaultPath = '/tmp/test-vault';
      setVaultPathResolver(() => vaultPath);
      expect(getVaultPath()).toBe(vaultPath);
    });
  });
});
