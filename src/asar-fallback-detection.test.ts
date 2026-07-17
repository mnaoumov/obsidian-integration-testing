import {
  describe,
  expect,
  it
} from 'vitest';

import { checkAsarFallback } from './asar-fallback-detection.ts';

describe('checkAsarFallback', () => {
  it('is `unknown` when no asar version was requested', () => {
    const verdict = checkAsarFallback({ requestedVersion: undefined, runningApiVersion: '1.1.9' });
    expect(verdict).toEqual({ requestedVersion: null, runningApiVersion: '1.1.9', tier: 'unknown' });
  });

  it('is `unknown` when the running version could not be read', () => {
    const verdict = checkAsarFallback({ requestedVersion: '1.13.0', runningApiVersion: undefined });
    expect(verdict).toEqual({ requestedVersion: '1.13.0', runningApiVersion: null, tier: 'unknown' });
  });

  it('is `unknown` when both versions are absent', () => {
    const verdict = checkAsarFallback({ requestedVersion: undefined, runningApiVersion: undefined });
    expect(verdict).toEqual({ requestedVersion: null, runningApiVersion: null, tier: 'unknown' });
  });

  it('is `match` when the running version equals the requested version', () => {
    const verdict = checkAsarFallback({ requestedVersion: '1.13.1', runningApiVersion: '1.13.1' });
    expect(verdict).toEqual({ requestedVersion: '1.13.1', runningApiVersion: '1.13.1', tier: 'match' });
    expect(verdict.message).toBeUndefined();
  });

  it('is `fallback` when the running version is older than the requested version (silent revert)', () => {
    const verdict = checkAsarFallback({ requestedVersion: '1.13.0', runningApiVersion: '1.1.9' });
    expect(verdict.tier).toBe('fallback');
    expect(verdict.requestedVersion).toBe('1.13.0');
    expect(verdict.runningApiVersion).toBe('1.1.9');
    expect(verdict.message).toContain('1.13.0');
    expect(verdict.message).toContain('1.1.9');
  });

  it('is `fallback` for any mismatch, including a newer running version', () => {
    const verdict = checkAsarFallback({ requestedVersion: '1.13.0', runningApiVersion: '1.13.1' });
    expect(verdict.tier).toBe('fallback');
    expect(verdict.requestedVersion).toBe('1.13.0');
    expect(verdict.runningApiVersion).toBe('1.13.1');
  });
});
