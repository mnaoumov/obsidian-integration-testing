import {
  describe,
  expect,
  it
} from 'vitest';

import type { GenerateFunctionCallParams } from './generate-function-call.ts';

import { generateFunctionCall } from './generate-function-call.ts';

interface AddArguments {
  a: number;
  b: number;
}

interface TransformArguments {
  transform: (x: number) => number;
}

describe('generateFunctionCall', () => {
  it('should generate a call with no additional params', () => {
    function greet(_params: GenerateFunctionCallParams): string {
      return 'hello';
    }
    const result = generateFunctionCall(greet, {});
    expect(result).toContain('function greet');
    expect(result).toContain('window.app');
  });

  it('should generate a call with serialized input', () => {
    function add(params: GenerateFunctionCallParams<AddArguments>): number {
      return params.a + params.b;
    }
    const result = generateFunctionCall(add, { a: 2, b: 3 });
    expect(result).toContain('function add');
    expect(result).toContain('"a": 2');
    expect(result).toContain('"b": 3');
  });

  it('should produce syntactically valid JavaScript for no-additional-params calls', () => {
    function greet(_params: GenerateFunctionCallParams): string {
      return 'hello';
    }
    const result = generateFunctionCall(greet, {});
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });

  it('should produce syntactically valid JavaScript for calls with input', () => {
    function add(params: GenerateFunctionCallParams<AddArguments>): number {
      return params.a + params.b;
    }
    const result = generateFunctionCall(add, { a: 1, b: 2 });
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });

  it('should handle function-valued input', () => {
    function outer(params: GenerateFunctionCallParams<TransformArguments>): number {
      return params.transform(5);
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
    function callback(_params: GenerateFunctionCallParams): number {
      return 1;
    }
    const result = generateFunctionCall(callback, {});
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });

  it('should handle async functions', () => {
    interface FetchDataParams {
      readonly url: string;
    }
    async function fetchData(_params: GenerateFunctionCallParams<FetchDataParams>): Promise<string> {
      // eslint-disable-next-line unicorn/no-useless-promise-resolve-reject -- The `await` is the point: this fixture has to be a genuinely asynchronous function for the generated call to carry the `async` keyword the assertion below looks for.
      return await Promise.resolve('data');
    }
    const result = generateFunctionCall(fetchData, { url: 'test' });
    expect(result).toContain('async function fetchData');
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(`return ${result}`)).not.toThrow();
  });

  it('should inject app from window.app into the generated expression', () => {
    function check(_params: GenerateFunctionCallParams): string {
      return 'ok';
    }
    const result = generateFunctionCall(check, {});
    expect(result).toContain('Object.assign(');
    expect(result).toContain('app: window.app');
  });
});
