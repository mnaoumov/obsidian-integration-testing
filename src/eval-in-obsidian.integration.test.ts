import type { FileSystemAdapter } from 'obsidian';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it
} from 'vitest';

import { ContextId } from './context-id.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { TempVault } from './temp-vault.ts';

interface AbArgs {
  a: number;
  b: number;
}

const tempVault = new TempVault();
let vaultPath: string;

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60000;

beforeAll(async () => {
  await tempVault.register();
  vaultPath = tempVault.path;
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await tempVault.dispose();
});

describe('eval-in-obsidian integration', () => {
  it('should access the vault base path via app.vault.adapter.getBasePath()', async () => {
    const basePath = await evalInObsidian({
      fn({ app }): string {
        return (app.vault.adapter as FileSystemAdapter).getBasePath();
      },
      vaultPath: tempVault.path
    });
    expect(basePath).toBe(vaultPath);
  });

  it('should evaluate an anonymous arrow function', async () => {
    const result = await evalInObsidian({
      args: {
        a: 2,
        b: 3
      },
      fn: ({ a, b }): number => a + b,
      vaultPath
    });
    expect(result).toBe(5);
  });

  it('should evaluate an anonymous function expression', async () => {
    const result = await evalInObsidian({
      args: {
        a: 4,
        b: 5
      },
      fn({ a, b }): number {
        return a * b;
      },
      vaultPath
    });
    expect(result).toBe(20);
  });

  it('should evaluate a function declaration', async () => {
    function add({ a, b }: AbArgs): number {
      return a + b;
    }
    const result = await evalInObsidian({ args: { a: 10, b: 20 }, fn: add, vaultPath });
    expect(result).toBe(30);
  });

  it('should evaluate a shorthand method', async () => {
    const obj = {
      add(this: void, { a, b }: AbArgs): number {
        return a + b;
      }
    };
    const result = await evalInObsidian({ args: { a: 7, b: 8 }, fn: obj.add, vaultPath });
    expect(result).toBe(15);
  });

  it('should evaluate an async function', async () => {
    async function addAsync({ a, b }: AbArgs): Promise<number> {
      return await Promise.resolve(a + b);
    }
    const result = await evalInObsidian({ args: { a: 100, b: 200 }, fn: addAsync, vaultPath });
    expect(result).toBe(300);
  });

  it('should evaluate an async shorthand method', async () => {
    const obj = {
      async multiply(this: void, { a, b }: AbArgs): Promise<number> {
        return await Promise.resolve(a * b);
      }
    };
    const result = await evalInObsidian({
      args: {
        a: 6,
        b: 7
      },
      fn: obj.multiply,
      vaultPath
    });
    expect(result).toBe(42);
  });

  it('should pass string args', async () => {
    interface Args {
      parts: string[];
      sep: string;
    }
    const result = await evalInObsidian({ args: { parts: ['a', 'b', 'c'], sep: '-' }, fn: concat, vaultPath });
    expect(result).toBe('a-b-c');

    function concat({ parts, sep }: Args): string {
      return parts.join(sep);
    }
  });

  it('should pass args with a multi-line function declaration', async () => {
    interface Args {
      base: number;
      factor: number;
    }
    function compute({ base, factor }: Args): number {
      const doubled = base * 2;
      const result = doubled * factor;
      return result;
    }
    const result = await evalInObsidian({ args: { base: 5, factor: 3 }, fn: compute, vaultPath });
    expect(result).toBe(30);
  });

  it('should pass args with an async shorthand method', async () => {
    const obj = {
      async compute(this: void, { a, b }: AbArgs): Promise<number> {
        const sum = await Promise.resolve(a + b);
        return sum * 2;
      }
    };
    const result = await evalInObsidian({ args: { a: 3, b: 4 }, fn: obj.compute, vaultPath });
    expect(result).toBe(14);
  });

  it('should preserve newlines in template literals', async () => {
    interface Args {
      name: string;
    }
    function withTemplate({ name }: Args): string {
      const text = `hello
world
${name}`;
      return text;
    }
    const result = await evalInObsidian({ args: { name: 'test' }, fn: withTemplate, vaultPath });
    expect(result).toBe('hello\nworld\ntest');
  });

  it('should return void for a void function', async () => {
    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- Testing void function.
      await evalInObsidian({
        fn() {
          // Cannot use `noop()` here because `evalInObsidian()` does not accept functions with external imports.
        },
        vaultPath
      })
    ).toBeVoid();
  });

  it('should return void for an async void function', async () => {
    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- Testing void function.
      await evalInObsidian({
        async fn(): Promise<void> {
          await Promise.resolve();
        },
        vaultPath
      })
    ).toBeVoid();
  });

  it('should provide the obsidian module via obsidianModule', async () => {
    const result = await evalInObsidian({
      fn({ obsidianModule }): string {
        return obsidianModule.stringifyYaml({ a: 1 });
      },
      vaultPath
    });
    expect(result).toBe('a: 1\n');
  });

  it('should access the public Obsidian API via app', async () => {
    const result = await evalInObsidian({
      fn({ app }): boolean {
        return app.vault.configDir.startsWith('.');
      },
      vaultPath
    });
    expect(result).toBe(true);
  });

  it('should access the internal Obsidian API via app', async () => {
    const result = await evalInObsidian({
      fn({ app }): boolean {
        return app.title.includes('Obsidian');
      },
      vaultPath
    });
    expect(result).toBe(true);
  });

  it('should pass function args and execute them in the Obsidian context', async () => {
    const result = await evalInObsidian({
      args: {
        transform(this: void, x: number): number {
          return x * 2;
        },
        value: 5
      },
      fn({ transform, value }): number {
        return transform(value);
      },
      vaultPath
    });
    expect(result).toBe(10);
  });

  describe('vault targeting', () => {
    it('should work when a different vault is the active one (1b)', async () => {
      // The main Obsidian vault is open, but we target the temp vault via vaultPath.
      const result = await evalInObsidian({
        fn({ app }): string {
          return (app.vault.adapter as FileSystemAdapter).getBasePath();
        },
        vaultPath
      });
      expect(result).toBe(vaultPath);
    });

    it('should work when the target vault is already open (1c)', async () => {
      // The temp vault is already open from registration. Calling eval again should work.
      const first = await evalInObsidian({
        fn(): number {
          return 1;
        },
        vaultPath
      });
      const second = await evalInObsidian({
        fn(): number {
          return 2;
        },
        vaultPath
      });
      expect(first).toBe(1);
      expect(second).toBe(2);
    });

    it('should throw when targeting an unregistered vault path', async () => {
      await expect(evalInObsidian({
        fn(): number {
          return 1;
        },
        vaultPath: 'C:\\nonexistent\\vault\\path'
      })).rejects.toThrow('Vault path does not exist');
    });
  });

  describe('waitUntil', () => {
    it('should resolve once a synchronous predicate becomes truthy', async () => {
      const result = await evalInObsidian({
        async fn({ lib: { waitUntil } }): Promise<number> {
          const FLIP_AFTER_IN_MILLISECONDS = 200;
          const startTime = Date.now();
          let callCount = 0;
          await waitUntil({
            predicate(): boolean {
              callCount++;
              return Date.now() - startTime >= FLIP_AFTER_IN_MILLISECONDS;
            }
          });
          return callCount;
        },
        vaultPath
      });
      // Polled at least twice: false at least once, then truthy.
      expect(result).toBeGreaterThanOrEqual(2);
    });

    it('should await an asynchronous predicate', async () => {
      const result = await evalInObsidian({
        async fn({ lib: { waitUntil } }): Promise<boolean> {
          const FLIP_AFTER_IN_MILLISECONDS = 150;
          const startTime = Date.now();
          await waitUntil({
            async predicate(): Promise<boolean> {
              await Promise.resolve();
              return Date.now() - startTime >= FLIP_AFTER_IN_MILLISECONDS;
            }
          });
          return true;
        },
        vaultPath
      });
      expect(result).toBe(true);
    });

    it('should reject with the message when the predicate never becomes truthy', async () => {
      await expect(evalInObsidian({
        async fn({ lib: { waitUntil } }): Promise<void> {
          const TIMEOUT_IN_MILLISECONDS = 100;
          await waitUntil({
            intervalInMilliseconds: 10,
            message: 'never happened',
            predicate: (): boolean => false,
            timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
          });
        },
        vaultPath
      })).rejects.toThrow('waitUntil timed out after 100 milliseconds: never happened');
    });

    it('should apply the default timeout when none is provided', async () => {
      const DEFAULT_TIMEOUT_IN_MILLISECONDS = 5000;
      const result = await evalInObsidian({
        async fn({ lib: { waitUntil } }): Promise<number> {
          const startTime = Date.now();
          try {
            await waitUntil({ predicate: (): boolean => false });
            return -1;
          } catch {
            return Date.now() - startTime;
          }
        },
        vaultPath
      });
      // The default timeout (5000 ms) fired: elapsed is close to it, not the ~50 ms interval.
      const LOWER_BOUND_IN_MILLISECONDS = 4000;
      const UPPER_BOUND_IN_MILLISECONDS = 8000;
      expect(result).toBeGreaterThanOrEqual(LOWER_BOUND_IN_MILLISECONDS);
      expect(result).toBeLessThan(UPPER_BOUND_IN_MILLISECONDS);
      expect(DEFAULT_TIMEOUT_IN_MILLISECONDS).toBeGreaterThan(LOWER_BOUND_IN_MILLISECONDS);
    });

    it('should poll at the fast default interval when none is provided', async () => {
      const result = await evalInObsidian({
        async fn({ lib: { waitUntil } }): Promise<number> {
          const FLIP_AFTER_IN_MILLISECONDS = 200;
          const startTime = Date.now();
          await waitUntil({
            predicate: (): boolean => Date.now() - startTime >= FLIP_AFTER_IN_MILLISECONDS
          });
          return Date.now() - startTime;
        },
        vaultPath
      });
      // With the default 50 ms interval, it resolves shortly after the 200 ms flip.
      // Well below the default 5000 ms timeout, proving the default interval is small.
      const UPPER_BOUND_IN_MILLISECONDS = 1000;
      expect(result).toBeLessThan(UPPER_BOUND_IN_MILLISECONDS);
    });
  });

  describe('context', () => {
    it('should persist values across calls and dispose cleanly', async () => {
      interface Context {
        storedValue: number;
      }
      const ctx = new ContextId<Context>();

      await evalInObsidian({
        contextId: ctx,
        fn({ context }): void {
          context.storedValue = 123;
        },
        vaultPath
      });

      const retrieved = await evalInObsidian({
        contextId: ctx,
        fn({ context: { storedValue } }): number {
          return storedValue;
        },
        vaultPath
      });
      expect(retrieved).toBe(123);

      await ctx.dispose(vaultPath);

      const afterDispose = await evalInObsidian({
        contextId: ctx,
        fn({ context }): boolean {
          return (context as Partial<typeof context>).storedValue === undefined;
        },
        vaultPath
      });
      expect(afterDispose).toBe(true);
    });
  });
});
