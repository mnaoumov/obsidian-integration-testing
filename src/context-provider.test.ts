import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianTransportOptions } from './transport-options.ts';

import {
  getTransportOptions,
  setTransportOptionsResolver
} from './context-provider.ts';

describe('context-provider', () => {
  describe('getTransportOptions', () => {
    it('should return undefined when no resolver is registered', () => {
      setTransportOptionsResolver(() => undefined);
      expect(getTransportOptions()).toBeUndefined();
    });

    it('should return the value from the registered resolver', () => {
      const options: ObsidianTransportOptions = { type: 'obsidian-cli' };
      setTransportOptionsResolver(() => options);
      expect(getTransportOptions()).toBe(options);
    });
  });
});
