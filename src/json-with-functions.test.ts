import {
  describe,
  expect,
  it
} from 'vitest';

import { jsonWithFunctions } from './json-with-functions.ts';

describe('jsonWithFunctions', () => {
  it('should serialize plain objects like JSON.stringify', () => {
    const result = jsonWithFunctions({ a: 1, b: 'hello' });
    expect(JSON.parse(result)).toEqual({ a: 1, b: 'hello' });
  });

  it('should include function bodies in the output', () => {
    const result = jsonWithFunctions({
      transform(x: number): number {
        return x * 2;
      },
      value: 5
    });
    expect(result).toContain('function transform');
    expect(result).toContain('return x * 2');
    expect(result).not.toContain('"__fn_');
  });

  it('should produce parseable JavaScript when used as an expression', () => {
    const result = jsonWithFunctions({
      greet(name: string): string {
        return `hello ${name}`;
      },
      value: 42
    });
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });

  it('should handle multiple functions', () => {
    const result = jsonWithFunctions({
      add(a: number, b: number): number {
        return a + b;
      },
      multiply(a: number, b: number): number {
        return a * b;
      }
    });
    expect(result).toContain('function add');
    expect(result).toContain('function multiply');
  });

  it('should handle objects with no functions', () => {
    const result = jsonWithFunctions({ x: 1, y: [2, 3] });
    expect(JSON.parse(result)).toEqual({ x: 1, y: [2, 3] });
  });

  it('should handle arrow functions', () => {
    const result = jsonWithFunctions({
      fn: (x: number): number => x + 1
    });
    expect(result).toContain('=>');
  });
});
