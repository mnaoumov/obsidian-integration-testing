import {
  describe,
  expect,
  it
} from 'vitest';

import { getFunctionExpressionString } from './function-expression.ts';

function noop(): void {
  // Does nothing.
}

async function noopAsync(): Promise<void> {
  // Does nothing.
}

describe('getFunctionExpressionString', () => {
  it('should return the string as-is for a function declaration', () => {
    function named(): void {
      noop();
    }
    expect(getFunctionExpressionString(named)).toBe(named.toString());
  });

  it('should return the string as-is for an arrow function', () => {
    // eslint-disable-next-line func-style -- Testing arrow function form.
    const arrow = (): void => {
      noop();
    };
    expect(getFunctionExpressionString(arrow)).toBe(arrow.toString());
  });

  it('should return the string as-is for an async function declaration', () => {
    async function asyncNamed(): Promise<void> {
      await noopAsync();
    }
    expect(getFunctionExpressionString(asyncNamed)).toBe(asyncNamed.toString());
  });

  it('should return the string as-is for an async arrow function', () => {
    // eslint-disable-next-line func-style -- Testing arrow function form.
    const asyncArrow = async (): Promise<void> => {
      await noopAsync();
    };
    expect(getFunctionExpressionString(asyncArrow)).toBe(asyncArrow.toString());
  });

  it('should prefix with "function " for a shorthand method', () => {
    const obj = {
      method(this: void): void {
        noop();
      }
    };
    expect(getFunctionExpressionString(obj.method)).toMatch(/^function method\(\)/);
  });

  it('should prefix with "async function " for an async shorthand method', () => {
    const obj = {
      async method(this: void): Promise<void> {
        await noopAsync();
      }
    };
    expect(getFunctionExpressionString(obj.method)).toMatch(/^async function method\(\)/);
  });

  it('should prefix with "function " for a shorthand method named like "async1"', () => {
    const obj = {
      async1(this: void): void {
        noop();
      }
    };
    expect(getFunctionExpressionString(obj.async1)).toMatch(/^function async1\(\)/);
  });

  it('should prefix with "function " for a shorthand method named like "function1"', () => {
    const obj = {
      function1(this: void): void {
        noop();
      }
    };
    expect(getFunctionExpressionString(obj.function1)).toMatch(/^function function1\(\)/);
  });
});
