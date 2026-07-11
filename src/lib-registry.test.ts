import {
  describe,
  expect,
  it
} from 'vitest';

import {
  computeBootstrapVersion,
  getBootstrapVersion,
  getRegisteredLibResolvers,
  registerLibResolver
} from './lib-registry.ts';
import { LIBRARY_VERSION } from './library.ts';

describe('lib-registry', () => {
  describe('computeBootstrapVersion', () => {
    it('should return the base version unchanged when there are no resolvers', () => {
      expect(computeBootstrapVersion('1.2.3', [])).toBe('1.2.3');
    });

    it('should fold a single resolver source into the version', () => {
      const result = computeBootstrapVersion('1.2.3', [resolverA]);
      expect(result).toContain('1.2.3');
      expect(result).toContain(resolverA.toString());
      expect(result).not.toBe('1.2.3');
    });

    it('should fold multiple resolver sources into the version', () => {
      const result = computeBootstrapVersion('1.2.3', [resolverA, resolverB]);
      expect(result).toContain(resolverA.toString());
      expect(result).toContain(resolverB.toString());
    });

    it('should produce different versions for different resolver sets', () => {
      expect(computeBootstrapVersion('1.2.3', [resolverA])).not.toBe(computeBootstrapVersion('1.2.3', [resolverB]));
    });
  });

  describe('registry', () => {
    it('should register resolvers, dedupe by source, and reflect them in the bootstrap version', () => {
      // The registry is untouched by the pure `computeBootstrapVersion` tests, so it starts empty here.
      expect(getRegisteredLibResolvers()).toHaveLength(0);
      expect(getBootstrapVersion()).toBe(LIBRARY_VERSION);

      registerLibResolver(resolverA);
      registerLibResolver(resolverB);
      // Registering the same resolver again is a no-op (deduped by source text).
      registerLibResolver(resolverA);

      expect(getRegisteredLibResolvers()).toStrictEqual([resolverA, resolverB]);

      const version = getBootstrapVersion();
      expect(version).not.toBe(LIBRARY_VERSION);
      expect(version).toContain(resolverA.toString());
      expect(version).toContain(resolverB.toString());
    });
  });
});

function resolverA(): object {
  return { a: 1 };
}

function resolverB(): object {
  return { b: 2 };
}
