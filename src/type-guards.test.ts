import {
  describe,
  expect,
  it
} from 'vitest';

import {
  assertNonNullable,
  castTo,
  ensureGenericObject,
  ensureNonNullable
} from './type-guards.ts';

interface Boxed {
  value: number;
}

const TEST_VALUE = 42;

describe('castTo', () => {
  it('should return the same value', () => {
    const value = { value: TEST_VALUE };
    expect(castTo<Boxed>(value)).toBe(value);
  });
});

describe('ensureGenericObject', () => {
  it('should return the same object', () => {
    const obj = { name: 'test' };
    expect(ensureGenericObject(obj)).toBe(obj);
  });

  it('should expose dynamic string-keyed access', () => {
    const obj = { name: 'test' };
    expect(ensureGenericObject(obj)['missing']).toBeUndefined();
  });
});

describe('assertNonNullable', () => {
  it('should not throw for a defined value', () => {
    expect(() => {
      assertNonNullable<string | undefined>('hello');
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
    expect(ensureNonNullable<string | undefined>('hello')).toBe('hello');
  });

  it('should throw for null', () => {
    expect(() => ensureNonNullable(null)).toThrow('Value is null');
  });

  it('should throw for undefined', () => {
    expect(() => ensureNonNullable(undefined)).toThrow('Value is undefined');
  });
});
