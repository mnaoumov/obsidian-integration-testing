import {
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi
} from 'vitest';

import type { ObsidianTransport } from './transport.ts';

import { ContextId } from './context-id.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';

const mockTransportEvaluate = vi.hoisted(() => vi.fn<ObsidianTransport['evaluate']>());
const mockTransportPreflightCheck = vi.hoisted(() => vi.fn<ObsidianTransport['preflightCheck']>().mockResolvedValue(undefined));
const mockTransportRegisterVault = vi.hoisted(() => vi.fn<ObsidianTransport['registerVault']>().mockResolvedValue(undefined));
const mockTransportUnregisterVault = vi.hoisted(() => vi.fn<ObsidianTransport['unregisterVault']>().mockResolvedValue(undefined));

const mockTransport: ObsidianTransport = {
  evaluate: mockTransportEvaluate,
  isMobile: false,
  preflightCheck: mockTransportPreflightCheck,
  registerVault: mockTransportRegisterVault,
  unregisterVault: mockTransportUnregisterVault
};

vi.mock('./transport-factory.ts', () => ({
  getOrCreateTransport: (): Promise<ObsidianTransport> => Promise.resolve(mockTransport)
}));

const mockExistsSync = vi.hoisted(() => vi.fn<(path: string) => boolean>().mockReturnValue(true));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync
  };
});

beforeEach(() => {
  mockTransportEvaluate.mockReset();
  mockTransportPreflightCheck.mockReset().mockResolvedValue(undefined);
  mockExistsSync.mockReset().mockReturnValue(true);
});

function getLastExpression(): string {
  const lastCall = mockTransportEvaluate.mock.lastCall;
  return (lastCall as unknown[])[0] as string;
}

describe('evalInObsidian', () => {
  it('should parse JSON result from transport output', async () => {
    mockTransportEvaluate.mockResolvedValue('{"key":"value"}');
    const result = await evalInObsidian({
      fn(): Record<string, string> {
        return { key: 'value' };
      }
    });
    expect(result).toEqual({ key: 'value' });
  });

  it('should return void when transport outputs (no output)', async () => {
    mockTransportEvaluate.mockResolvedValue('(no output)');

    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- Testing void function.
      await evalInObsidian({
        args: { pluginId: 'test-plugin' },
        async fn({ pluginId }): Promise<void> {
          await Promise.resolve(pluginId);
        }
      })
    ).toBeVoid();
  });

  it('should pass args and call transport.evaluate', async () => {
    mockTransportEvaluate.mockResolvedValue('5');
    const result = await evalInObsidian({
      args: { a: 2, b: 3 },
      fn({ a, b }): number {
        return a + b;
      }
    });
    expect(result).toBe(5);
    expect(mockTransportEvaluate).toHaveBeenCalled();
  });

  it('should generate syntactically valid JavaScript in the expression', async () => {
    mockTransportEvaluate.mockResolvedValue('5');
    await evalInObsidian({
      args: { a: 2, b: 3 },
      fn({ a, b }): number {
        return a + b;
      }
    });
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(getLastExpression())).not.toThrow();
  });

  it('should generate valid JavaScript when args contain functions', async () => {
    mockTransportEvaluate.mockResolvedValue('10');
    await evalInObsidian({
      args: {
        transform(this: void, x: number): number {
          return x * 2;
        },
        value: 5
      },
      fn({ transform, value }): number {
        return transform(value);
      }
    });
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(getLastExpression())).not.toThrow();
  });

  it('should inject context setup when contextId is provided', async () => {
    mockTransportEvaluate.mockResolvedValue('"ok"');
    interface Context {
      value: number;
    }
    const ctx = new ContextId<Context>();
    await evalInObsidian({
      contextId: ctx,
      fn({ context }): string {
        context.value = 42;
        return 'ok';
      }
    });
    const expression = getLastExpression();
    expect(expression).toContain('__obsidianContexts__');
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(expression)).not.toThrow();
  });

  it('should not inject context when contextId is absent', async () => {
    mockTransportEvaluate.mockResolvedValue('1');
    await evalInObsidian({
      fn(): number {
        return 1;
      }
    });
    const expression = getLastExpression();
    expect(expression).not.toContain('__obsidianContexts__');
  });

  it('should throw with error details when Obsidian returns an eval error marker', async () => {
    mockTransportEvaluate.mockResolvedValue(JSON.stringify({ __obsidianEvalError__: 'Error: something broke\n    at fn (eval:1:1)' }));
    await expect(evalInObsidian({
      fn(): string {
        return 'ok';
      }
    })).rejects.toThrow('evalInObsidian: Error inside Obsidian:\nError: something broke\n    at fn (eval:1:1)');
  });

  it('should throw with descriptive message when Obsidian returns non-JSON output', async () => {
    mockTransportEvaluate.mockResolvedValue('Error: something went wrong');
    await expect(evalInObsidian({
      fn(): string {
        return 'ok';
      }
    })).rejects.toThrow('evalInObsidian: Obsidian returned non-JSON output');
  });

  it('should rethrow transport errors', async () => {
    mockTransportEvaluate.mockRejectedValue(new Error('Something unexpected'));
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      },
      shouldSkipPreflightChecks: true
    })).rejects.toThrow('Something unexpected');
  });
});

describe('pre-flight checks', () => {
  it('should throw when vaultPath does not exist on disk', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      },
      vaultPath: '/nonexistent/vault/path'
    })).rejects.toThrow('Vault path does not exist');
    mockExistsSync.mockReturnValue(true);
  });

  it('should call transport.preflightCheck when shouldSkipPreflightChecks is false', async () => {
    mockTransportEvaluate.mockResolvedValue('1');
    await evalInObsidian({
      fn(): number {
        return 1;
      }
    });
    expect(mockTransportPreflightCheck).toHaveBeenCalled();
  });

  it('should propagate transport preflightCheck errors', async () => {
    mockTransportPreflightCheck.mockRejectedValueOnce(new Error('Vault is not registered in Obsidian'));
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
    })).rejects.toThrow('Vault is not registered in Obsidian');
  });

  it('should skip pre-flight checks when shouldSkipPreflightChecks is true', async () => {
    mockTransportEvaluate.mockResolvedValue('42');
    const result = await evalInObsidian({
      fn(): number {
        return 42;
      },
      shouldSkipPreflightChecks: true
    });
    expect(result).toBe(42);
    expect(mockTransportPreflightCheck).not.toHaveBeenCalled();
  });
});

describe('ContextId', () => {
  it('should produce unique string representations', () => {
    const a = new ContextId();
    const b = new ContextId();
    expect(String(a)).not.toBe(String(b));
  });

  it('should serialize via toString and toJSON', () => {
    const ctx = new ContextId();
    expect(ctx.toString()).toBe(ctx.toJSON());
    expect(String(ctx)).toBe(ctx.toString());
  });

  it('should dispose context without vaultPath', async () => {
    mockTransportEvaluate.mockResolvedValue('(no output)');
    const ctx = new ContextId();
    await ctx.dispose();
    expect(mockTransportEvaluate).toHaveBeenCalled();
    const expression = getLastExpression();
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(expression)).not.toThrow();
  });

  it('should dispose context with vaultPath', async () => {
    // eslint-disable-next-line no-restricted-syntax -- Dynamic imports needed to bypass the node:fs mock.
    const { mkdtempSync, rmdirSync } = await import('node:fs');
    // eslint-disable-next-line no-restricted-syntax -- Dynamic imports needed to bypass the node:fs mock.
    const { tmpdir } = await import('node:os');
    // eslint-disable-next-line no-restricted-syntax -- Dynamic imports needed to bypass the node:fs mock.
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'test-ctx-dispose-'));
    try {
      mockTransportEvaluate.mockResolvedValue('(no output)');
      const ctx = new ContextId();
      await ctx.dispose(dir);
      expect(mockTransportEvaluate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cwd: dir })
      );
    } finally {
      rmdirSync(dir);
    }
  });

  it('should support await using', async () => {
    mockTransportEvaluate.mockResolvedValue('(no output)');
    {
      await using _ctx = new ContextId();
    }
    expect(mockTransportEvaluate).toHaveBeenCalled();
  });
});
