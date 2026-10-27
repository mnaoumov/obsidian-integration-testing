import {
  describe,
  expect,
  it
} from 'vitest';

import { SilentAsarFallbackError } from './silent-asar-fallback-error.ts';

describe('SilentAsarFallbackError', () => {
  const error = new SilentAsarFallbackError({
    requestedVersion: '1.13.0',
    runningApiVersion: '1.1.9'
  });

  it('is an Error with the specific name', () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SilentAsarFallbackError');
  });

  it('names both versions in the message', () => {
    expect(error.message).toContain('1.13.0');
    expect(error.message).toContain('1.1.9');
  });

  it('exposes the versions as fields', () => {
    expect(error.requestedVersion).toBe('1.13.0');
    expect(error.runningApiVersion).toBe('1.1.9');
  });
});
