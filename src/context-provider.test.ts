import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianTransportOptions } from './transport-options.ts';

import {
  getTransportOptions,
  getVaultPath,
  setTransportOptionsResolver,
  setVaultPathResolver
} from './context-provider.ts';

describe('context-provider', () => {
  describe('getTransportOptions', () => {
    it('should return undefined when no resolver is registered', () => {
      setTransportOptionsResolver(() => undefined);
      expect(getTransportOptions()).toBeUndefined();
    });

    it('should return the value from the registered resolver', () => {
      const options: ObsidianTransportOptions = { type: 'obsidian-cdp' };
      setTransportOptionsResolver(() => options);
      expect(getTransportOptions()).toBe(options);
    });
  });

  describe('getVaultPath', () => {
    it('should return undefined when no resolver is registered', () => {
      setVaultPathResolver(() => undefined);
      expect(getVaultPath()).toBeUndefined();
    });

    it('should return the value from the registered resolver', () => {
      const vaultPath = '/tmp/test-vault';
      setVaultPathResolver(() => vaultPath);
      expect(getVaultPath()).toBe(vaultPath);
    });
  });
});
