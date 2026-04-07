import {
  describe,
  expect,
  expectTypeOf,
  it,
  vi
} from 'vitest';

import { ContextId } from './context-id.ts';
import { noop } from './noop.ts';
import { evalInObsidian } from './obsidian-cli.ts';

const mockExec = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockExistsSync = vi.hoisted(() => vi.fn<(path: string) => boolean>().mockReturnValue(true));
const mockIsVaultRegistered = vi.hoisted(() => vi.fn<(path: string) => boolean>().mockReturnValue(true));
const mockIsCliEnabled = vi.hoisted(() => vi.fn<() => boolean>().mockReturnValue(true));
const mockGetVaultId = vi.hoisted(() => vi.fn<(path: string) => string | undefined>().mockReturnValue('abc123'));
const mockPlatform = vi.hoisted(() => ({ value: 'win32' }));

vi.mock('./exec.ts', () => ({
  exec: mockExec
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync
  };
});

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return {
    ...actual,
    default: {
      ...actual,
      get platform(): string {
        return mockPlatform.value;
      }
    }
  };
});

vi.mock('./obsidian-config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./obsidian-config.ts')>();
  return {
    ...actual,
    getVaultId: mockGetVaultId,
    isCliEnabled: mockIsCliEnabled,
    isVaultRegistered: mockIsVaultRegistered
  };
});

function getLastCodeArg(): string {
  const lastCall = mockExec.mock.lastCall as unknown[];
  const cmdArgs = lastCall[0] as string[];
  const codeArg = cmdArgs[2] ?? '';
  expect(codeArg).toMatch(/^code=/);
  return codeArg.slice('code='.length);
}

describe('evalInObsidian', () => {
  it('should parse JSON result from exec output', async () => {
    mockExec.mockResolvedValue('=> {"key":"value"}');
    const result = await evalInObsidian({
      fn(): Record<string, string> {
        return { key: 'value' };
      }
    });
    expect(result).toEqual({ key: 'value' });
  });

  it('should return void when exec outputs (no output)', async () => {
    mockExec.mockResolvedValue('=> (no output)');

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

  it('should handle (no output) without => prefix', async () => {
    mockExec.mockResolvedValue('(no output)');

    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- Testing void function.
      await evalInObsidian({
        fn(): void {
          noop();
        }
      })
    ).toBeVoid();
  });

  it('should pass args to the exec command', async () => {
    mockExec.mockResolvedValue('=> 5');
    const result = await evalInObsidian({
      args: { a: 2, b: 3 },
      fn({ a, b }): number {
        return a + b;
      }
    });
    expect(result).toBe(5);
    expect(mockExec).toHaveBeenCalledWith(
      expect.arrayContaining(['obsidian', 'eval']),
      expect.objectContaining({ isQuiet: true })
    );
  });

  it('should generate syntactically valid JavaScript in the code argument', async () => {
    mockExec.mockResolvedValue('=> 5');
    await evalInObsidian({
      args: { a: 2, b: 3 },
      fn({ a, b }): number {
        return a + b;
      }
    });
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(getLastCodeArg())).not.toThrow();
  });

  it('should generate valid JavaScript when args contain functions', async () => {
    mockExec.mockResolvedValue('=> 10');
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
    expect(() => new Function(getLastCodeArg())).not.toThrow();
  });

  it('should handle result without => prefix', async () => {
    mockExec.mockResolvedValue('"hello"');
    const result = await evalInObsidian({
      fn(): string {
        return 'hello';
      }
    });
    expect(result).toBe('hello');
  });

  it('should inject context setup when contextId is provided', async () => {
    mockExec.mockResolvedValue('=> "ok"');
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
    const code = getLastCodeArg();
    expect(code).toContain('__obsidianContexts__');
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(code)).not.toThrow();
  });

  it('should not inject context when contextId is absent', async () => {
    mockExec.mockResolvedValue('=> 1');
    await evalInObsidian({
      fn(): number {
        return 1;
      }
    });
    const code = getLastCodeArg();
    expect(code).not.toContain('__obsidianContexts__');
  });

  it('should throw with descriptive message when Obsidian returns non-JSON output', async () => {
    mockExec.mockResolvedValue('=> Error: something went wrong');
    await expect(evalInObsidian({
      fn(): string {
        return 'ok';
      }
    })).rejects.toThrow('evalInObsidian: Obsidian returned non-JSON output');
  });

  it('should rethrow unknown exec errors', async () => {
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      // First call: CLI availability check — succeed
      if (callCount === 1) {
        return Promise.resolve('');
      }
      // Second call: eval — fail with unexpected error
      return Promise.reject(new Error('Something unexpected'));
    });
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
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

  it('should throw when vault is not registered in Obsidian', async () => {
    mockIsVaultRegistered.mockReturnValue(false);
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
    })).rejects.toThrow('Vault is not registered in Obsidian');
    mockIsVaultRegistered.mockReturnValue(true);
  });

  it('should throw when CLI is disabled in Obsidian settings', async () => {
    mockIsCliEnabled.mockReturnValue(false);
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
    })).rejects.toThrow('Obsidian CLI is disabled');
    mockIsCliEnabled.mockReturnValue(true);
  });

  it('should throw when Obsidian CLI is not in PATH', async () => {
    mockExec.mockRejectedValue(new Error('not found'));
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
    })).rejects.toThrow('Obsidian CLI is not available');
    mockExec.mockReset();
  });

  it('should use "where.exe obsidian" (without .com) on Windows', async () => {
    mockPlatform.value = 'win32';
    mockExec.mockResolvedValue('=> 1');
    await evalInObsidian({
      fn(): number {
        return 1;
      }
    });
    expect(mockExec).toHaveBeenCalledWith('where.exe obsidian', expect.objectContaining({ isQuiet: true }));
    mockPlatform.value = 'win32';
  });

  it('should use "which obsidian" on non-Windows platforms', async () => {
    mockPlatform.value = 'linux';
    mockExec.mockResolvedValue('=> 1');
    await evalInObsidian({
      fn(): number {
        return 1;
      }
    });
    expect(mockExec).toHaveBeenCalledWith('which obsidian', expect.objectContaining({ isQuiet: true }));
    mockPlatform.value = 'win32';
  });

  it('should skip pre-flight checks when shouldSkipPreflightChecks is true', async () => {
    mockIsVaultRegistered.mockReturnValue(false);
    mockIsCliEnabled.mockReturnValue(false);
    mockExec.mockResolvedValue('=> 42');
    const result = await evalInObsidian({
      fn(): number {
        return 42;
      },
      shouldSkipPreflightChecks: true
    });
    expect(result).toBe(42);
    mockIsVaultRegistered.mockReturnValue(true);
    mockIsCliEnabled.mockReturnValue(true);
  });

  it('should throw on unexpected empty response from Obsidian CLI', async () => {
    mockExec.mockResolvedValue('');
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
    })).rejects.toThrow('Unexpected empty response from Obsidian CLI');
  });

  it('should throw on "Vault not found." response from Obsidian CLI', async () => {
    mockExec.mockResolvedValue('Vault not found.');
    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
    })).rejects.toThrow('Unexpected empty response from Obsidian CLI');
  });
});

describe('auto-start', () => {
  it('should auto-start Obsidian and retry when not running', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      // First call: CLI availability check (where.exe) — succeed
      if (callCount === 1) {
        return Promise.resolve('');
      }
      // Second call: eval — fail with "unable to find Obsidian"
      if (callCount === 2) {
        return Promise.reject(new Error('The CLI is unable to find Obsidian.'));
      }
      // Third call: open URI — succeed
      if (callCount === 3) {
        return Promise.resolve('');
      }
      // Fourth call: retry eval — succeed
      return Promise.resolve('=> 42');
    });

    const result = await evalInObsidian({
      fn(): number {
        return 42;
      }
    });

    expect(result).toBe(42);
    expect(warnSpy).toHaveBeenCalledWith('Obsidian is not running. Starting Obsidian...');
    warnSpy.mockRestore();
  });

  it('should throw after auto-start timeout', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      // First call: CLI availability check — succeed
      if (callCount === 1) {
        return Promise.resolve('');
      }
      // All subsequent calls: fail with "unable to find Obsidian"
      return Promise.reject(new Error('The CLI is unable to find Obsidian.'));
    });

    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
    })).rejects.toThrow('Obsidian did not start within');
    warnSpy.mockRestore();
  }, 60000);

  it('should use generic URI when vault ID is not found', async () => {
    mockGetVaultId.mockReturnValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve('');
      }
      if (callCount === 2) {
        return Promise.reject(new Error('The CLI is unable to find Obsidian.'));
      }
      if (callCount === 3) {
        return Promise.resolve('');
      }
      return Promise.resolve('=> 1');
    });

    await evalInObsidian({
      fn(): number {
        return 1;
      }
    });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringMatching(/obsidian:\/\/open"/),
      expect.anything()
    );
    warnSpy.mockRestore();
    mockGetVaultId.mockReturnValue('abc123');
  });

  it('should continue polling when open URI command fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve('');
      }
      if (callCount === 2) {
        return Promise.reject(new Error('The CLI is unable to find Obsidian.'));
      }
      // Open URI command fails
      if (callCount === 3) {
        return Promise.reject(new Error('open command failed'));
      }
      return Promise.resolve('=> 1');
    });

    const result = await evalInObsidian({
      fn(): number {
        return 1;
      }
    });

    expect(result).toBe(1);
    warnSpy.mockRestore();
  });

  it('should use "open" command on macOS', async () => {
    mockPlatform.value = 'darwin';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve('');
      }
      if (callCount === 2) {
        return Promise.reject(new Error('The CLI is unable to find Obsidian.'));
      }
      if (callCount === 3) {
        return Promise.resolve('');
      }
      return Promise.resolve('=> 1');
    });

    await evalInObsidian({
      fn(): number {
        return 1;
      }
    });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringMatching(/^open /),
      expect.anything()
    );
    warnSpy.mockRestore();
    mockPlatform.value = 'win32';
  });

  it('should use "xdg-open" command on Linux', async () => {
    mockPlatform.value = 'linux';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve('');
      }
      if (callCount === 2) {
        return Promise.reject(new Error('The CLI is unable to find Obsidian.'));
      }
      if (callCount === 3) {
        return Promise.resolve('');
      }
      return Promise.resolve('=> 1');
    });

    await evalInObsidian({
      fn(): number {
        return 1;
      }
    });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringMatching(/^xdg-open /),
      expect.anything()
    );
    warnSpy.mockRestore();
    mockPlatform.value = 'win32';
  });

  it('should rethrow non-Obsidian errors during auto-start polling', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      // First call: CLI availability check — succeed
      if (callCount === 1) {
        return Promise.resolve('');
      }
      // Second call: eval — fail with "unable to find Obsidian"
      if (callCount === 2) {
        return Promise.reject(new Error('The CLI is unable to find Obsidian.'));
      }
      // Third call: open URI — succeed
      if (callCount === 3) {
        return Promise.resolve('');
      }
      // Fourth call: retry — fail with a different error
      return Promise.reject(new Error('Permission denied'));
    });

    await expect(evalInObsidian({
      fn(): number {
        return 1;
      }
    })).rejects.toThrow('Permission denied');
    warnSpy.mockRestore();
  });

  it('should handle non-Error rejection during poll retry', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      // First call: CLI availability check — succeed
      if (callCount === 1) {
        return Promise.resolve('');
      }
      // Second call: eval — fail with Error
      if (callCount === 2) {
        return Promise.reject(new Error('The CLI is unable to find Obsidian.'));
      }
      // Third call: open URI — succeed
      if (callCount === 3) {
        return Promise.resolve('');
      }
      // Fourth call: retry — fail with non-Error string
      if (callCount === 4) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing non-Error rejection handling.
        return Promise.reject('The CLI is unable to find Obsidian.');
      }
      // Fifth call: retry — succeed
      return Promise.resolve('=> 1');
    });

    const result = await evalInObsidian({
      fn(): number {
        return 1;
      }
    });

    expect(result).toBe(1);
    warnSpy.mockRestore();
  });

  it('should detect Obsidian not running from non-Error rejection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(noop);
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      // First call: CLI availability check — succeed
      if (callCount === 1) {
        return Promise.resolve('');
      }
      // Second call: eval — fail with string (not Error)
      if (callCount === 2) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing non-Error rejection handling.
        return Promise.reject('The CLI is unable to find Obsidian.');
      }
      // Third call: open URI — succeed
      if (callCount === 3) {
        return Promise.resolve('');
      }
      // Fourth call: retry — succeed
      return Promise.resolve('=> 1');
    });

    const result = await evalInObsidian({
      fn(): number {
        return 1;
      }
    });

    expect(result).toBe(1);
    warnSpy.mockRestore();
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
    mockExec.mockResolvedValue('=> (no output)');
    const ctx = new ContextId();
    await ctx.dispose();
    expect(mockExec).toHaveBeenCalled();
    const code = getLastCodeArg();
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(code)).not.toThrow();
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
      mockExec.mockResolvedValue('=> (no output)');
      const ctx = new ContextId();
      await ctx.dispose(dir);
      expect(mockExec).toHaveBeenCalledWith(
        expect.arrayContaining(['obsidian', 'eval']),
        expect.objectContaining({ cwd: dir })
      );
    } finally {
      rmdirSync(dir);
    }
  });

  it('should support await using', async () => {
    mockExec.mockResolvedValue('=> (no output)');
    {
      await using _ctx = new ContextId();
    }
    expect(mockExec).toHaveBeenCalled();
  });
});
