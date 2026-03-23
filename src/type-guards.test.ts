import {
  describe,
  expect,
  it
} from 'vitest';

import {
  assertNonNullable,
  ensureNonNullable
} from './type-guards.ts';

describe('assertNonNullable', () => {
  it('should not throw for a defined value', () => {
    expect(() => {
      assertNonNullable('hello' as string | undefined);
    }).not.toThrow();
  });

  it('should throw for null', () => {
    expect(() => {
      assertNonNullable(null);
    }).toThrow('Value is null');
  });

  it('should throw for undefined', () => {
    expect(() => {
      assertNonNullable(undefined);
    }).toThrow('Value is undefined');
  });

  it('should throw with custom message', () => {
    expect(() => {
      assertNonNullable(null, 'custom error');
    }).toThrow('custom error');
  });

  it('should throw with custom Error', () => {
    const error = new Error('my error');
    expect(() => {
      assertNonNullable(null, error);
    }).toThrow(error);
  });
});

describe('ensureNonNullable', () => {
  it('should return the value when not null or undefined', () => {
    expect(ensureNonNullable('hello' as string | undefined)).toBe('hello');
  });

  it('should throw for null', () => {
    expect(() => ensureNonNullable(null)).toThrow('Value is null');
  });

  it('should throw for undefined', () => {
    expect(() => ensureNonNullable(undefined)).toThrow('Value is undefined');
  });
});
