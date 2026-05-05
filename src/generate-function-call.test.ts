import {
  describe,
  expect,
  it
} from 'vitest';

import { generateFunctionCall } from './generate-function-call.ts';

interface AddArgs {
  a: number;
  b: number;
}

interface TransformArgs {
  transform: (x: number) => number;
}

describe('generateFunctionCall', () => {
  it('should generate a no-arg call when args is omitted', () => {
    function greet(): string {
      return 'hello';
    }
    const result = generateFunctionCall(greet);
    expect(result).toMatch(/^\(function greet\(\).*\)\(\)$/s);
  });

  it('should generate a call with serialized args', () => {
    function add({ a, b }: AddArgs): number {
      return a + b;
    }
    const result = generateFunctionCall(add, { a: 2, b: 3 });
    expect(result).toContain('function add');
    expect(result).toContain('"a": 2');
    expect(result).toContain('"b": 3');
  });

  it('should produce syntactically valid JavaScript for no-arg calls', () => {
    function greet(): string {
      return 'hello';
    }
    const result = generateFunctionCall(greet);
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });

  it('should produce syntactically valid JavaScript for calls with args', () => {
    function add({ a, b }: AddArgs): number {
      return a + b;
    }
    const result = generateFunctionCall(add, { a: 1, b: 2 });
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });

  it('should handle function-valued args', () => {
    function outer({ transform }: TransformArgs): number {
      return transform(5);
    }
    const result = generateFunctionCall(outer, {
      transform(x: number): number {
        return x * 2;
      }
    });
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
    expect(result).toContain('function transform');
  });

  it('should handle arrow functions', () => {
    function fn(x: number): number {
      return x + 1;
    }
    const result = generateFunctionCall(fn);
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });

  it('should handle async functions', () => {
    async function fetchData(): Promise<string> {
      return await Promise.resolve('data');
    }
    const result = generateFunctionCall(fetchData, { url: 'test' });
    expect(result).toContain('async function fetchData');
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });
});
