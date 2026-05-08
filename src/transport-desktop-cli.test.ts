import type { MockInstance } from 'vitest';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  getAnyRegisteredVaultPath,
  getVaultId
} from './obsidian-config.ts';
import { DesktopCliTransport } from './transport-desktop-cli.ts';
import { ensureNonNullable } from './type-guards.ts';

interface ExecOptions extends Record<string, unknown> {
  cwd: string;
}

interface ScriptErrorEnvelope {
  type: string;
  value: string;
}

const mockExec = vi.hoisted(() =>
  vi.fn<(command: string | string[], options?: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue({
    exitCode: 0,
    exitSignal: null,
    stderr: '',
    stdout: ''
  })
);

vi.mock('./exec.ts', () => ({
  exec: mockExec
}));

const mockExistsSync = vi.hoisted(() => vi.fn<(path: string) => boolean>().mockReturnValue(true));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync
  };
});

const mockMkdir = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockReadFile = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockUnlink = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const mockWriteFile = vi.hoisted(() => vi.fn<(path: string, content: string) => Promise<void>>().mockResolvedValue(undefined));

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  unlink: mockUnlink,
  writeFile: mockWriteFile
}));

vi.mock('./log.ts', () => ({
  log: vi.fn()
}));

const mockRegisterVaultInConfig = vi.hoisted(() => vi.fn());
const mockRemoveVaultFromConfig = vi.hoisted(() => vi.fn().mockReturnValue(true));

const mockEnableCliInConfig = vi.hoisted(() => vi.fn());

vi.mock('./obsidian-config.ts', () => ({
  enableCliInConfig: mockEnableCliInConfig,
  getAnyRegisteredVaultPath: vi.fn().mockReturnValue('/existing-vault'),
  getRegisteredVaults: vi.fn().mockReturnValue([]),
  getVaultId: vi.fn(),
  isCliEnabled: vi.fn().mockReturnValue(true),
  isVaultOpen: vi.fn().mockReturnValue(true),
  isVaultRegistered: vi.fn().mockReturnValue(true),
  registerVaultInConfig: mockRegisterVaultInConfig,
  removeVaultFromConfig: mockRemoveVaultFromConfig
}));

let transport: DesktopCliTransport;

beforeEach(() => {
  transport = new DesktopCliTransport();
  mockExec.mockReset().mockResolvedValue({ exitCode: 0, exitSignal: null, stderr: '', stdout: '' });
  mockExistsSync.mockReset().mockReturnValue(true);
  mockMkdir.mockReset().mockResolvedValue(undefined);
  mockReadFile.mockReset();
  mockUnlink.mockReset().mockResolvedValue(undefined);
  mockWriteFile.mockReset().mockResolvedValue(undefined);
});

describe('DesktopCliTransport.evaluate', () => {
  it('should return result string from JSON envelope', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ value: '{"key":"value"}' }));
    const result = await transport.evaluate('someExpr', { cwd: '/vault' });
    expect(result).toBe('{"key":"value"}');
  });

  it('should return empty string when envelope type is null', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ type: 'null', value: '' }));
    const result = await transport.evaluate('someExpr', { cwd: '/vault' });
    expect(result).toBe('');
  });

  it('should return empty string when envelope type is undefined', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ type: 'undefined', value: '' }));
    const result = await transport.evaluate('someExpr', { cwd: '/vault' });
    expect(result).toBe('');
  });

  it('should throw when envelope type is error', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ type: 'error', value: 'TypeError: x is not a function' }));
    await expect(transport.evaluate('someExpr', { cwd: '/vault' }))
      .rejects.toThrow('Script error in Obsidian for path: /vault: TypeError: x is not a function');
  });

  it('should throw when result file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(transport.evaluate('someExpr', { cwd: '/vault' }))
      .rejects.toThrow('Script did not execute for path: /vault');
  });

  it('should clean up script and result files in finally block', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ value: '"ok"' }));
    await transport.evaluate('someExpr', { cwd: '/vault' });
    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it('should clean up files even when evaluate throws', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(transport.evaluate('someExpr', { cwd: '/vault' })).rejects.toThrow();
    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it('should include vault=<id> before eval in CLI command when vault is registered', async () => {
    vi.mocked(getVaultId).mockReturnValue('abc123');
    mockReadFile.mockResolvedValue(JSON.stringify({ value: 'test' }));
    await transport.evaluate('someExpr', { cwd: '/vault' });

    const command = ensureNonNullable(mockExec.mock.calls[0])[0] as string[];
    expect(command[0]).toBe('obsidian');
    expect(command[1]).toBe('vault=abc123');
    expect(command[2]).toBe('eval');
  });

  it('should omit vault= from CLI command when vault ID is not found', async () => {
    vi.mocked(getVaultId).mockReturnValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({ value: 'test' }));
    await transport.evaluate('someExpr', { cwd: '/vault' });

    const command = ensureNonNullable(mockExec.mock.calls[0])[0] as string[];
    expect(command[0]).toBe('obsidian');
    expect(command[1]).toBe('eval');
  });

  it('should use new Function to execute script instead of module.constructor._load', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ value: 'test' }));
    await transport.evaluate('someExpr', { cwd: '/vault' });

    const command = ensureNonNullable(mockExec.mock.calls[0])[0] as string[];
    const codeArg = ensureNonNullable(command.find((arg) => arg.startsWith('code=')));
    expect(codeArg).not.toContain('module.constructor._load');
    expect(codeArg).toContain('new Function');
    expect(codeArg).toContain('fn()()');
    expect(codeArg).toContain('console.debug');
    expect(codeArg).toContain('readFile');
  });
});

describe('buildScriptFile (via evaluate)', () => {
  it('should write a script file that wraps the expression in a JSON envelope', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ value: 'test' }));
    await transport.evaluate('1 + 1', { cwd: '/vault' });

    const scriptContent = getWrittenScript(mockWriteFile);
    expect(scriptContent).toContain('JSON.stringify({ value:');
  });

  it('should write a script that distinguishes undefined, null, and string results', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ value: '' }));
    await transport.evaluate('null', { cwd: '/vault' });

    const scriptContent = getWrittenScript(mockWriteFile);
    expect(scriptContent).toContain('result === undefined');
    expect(scriptContent).toContain('result === null');
    expect(scriptContent).toContain('type: "undefined"');
    expect(scriptContent).toContain('type: "null"');
    expect(scriptContent).toContain('type: "error"');
  });
});

describe('generated script execution', () => {
  async function runGeneratedScript(expression: string): Promise<unknown> {
    mockReadFile.mockResolvedValue(JSON.stringify({ result: null }));
    await transport.evaluate(expression, { cwd: '/vault' });

    const scriptContent = getWrittenScript(mockWriteFile);

    let writtenJson = '';
    const fakeFsPromises = {
      writeFile(_path: string, data: string): void {
        writtenJson = data;
      }
    };
    const originalRequire = globalThis.require;
    globalThis.require = ((mod: string): unknown => {
      if (mod === 'node:fs/promises') {
        return fakeFsPromises;
      }
      throw new Error(`Unexpected require: ${mod}`);
    }) as NodeJS.Require;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- Testing the generated script via new Function, matching production behavior.
      const fn = new Function(`return ${scriptContent}`) as () => () => Promise<void>;
      await fn()();
    } finally {
      // eslint-disable-next-line require-atomic-updates -- Restoring the original value; no actual race condition in a single-threaded test.
      globalThis.require = originalRequire;
    }
    return JSON.parse(writtenJson);
  }

  it('should write { type: "undefined" } when expression returns undefined', async () => {
    const envelope = await runGeneratedScript('undefined');
    expect(envelope).toEqual({ type: 'undefined', value: '' });
  });

  it('should write { type: "null" } when expression returns null', async () => {
    const envelope = await runGeneratedScript('null');
    expect(envelope).toEqual({ type: 'null', value: '' });
  });

  it('should write { value: "hello" } when expression returns a string', async () => {
    const envelope = await runGeneratedScript('"hello"');
    expect(envelope).toEqual({ value: 'hello' });
  });

  it('should write { value: "" } when expression returns empty string', async () => {
    const envelope = await runGeneratedScript('""');
    expect(envelope).toEqual({ value: '' });
  });

  it('should write { type: "error" } with serialized error when expression throws', async () => {
    const envelope = await runGeneratedScript('(() => { throw new Error("boom") })()') as ScriptErrorEnvelope;
    expect(envelope.type).toBe('error');
    expect(envelope.value).toContain('Error: boom');
  });
});

describe('DesktopCliTransport.registerVault', () => {
  it('should use existing vault as cwd for enablePluginsInLocalStorage eval', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue('abc123');
    vi.mocked(getAnyRegisteredVaultPath).mockReturnValue('/existing-vault');
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    // RegisterVault calls evaluate 3 times:
    //   1. vault-open IPC (cwd: existing registered vault)
    //   2. enablePluginsInLocalStorage (cwd: existing registered vault — localStorage is shared)
    //   3. poll loop (cwd: vaultPath)
    const secondCall = ensureNonNullable(mockExec.mock.calls[1]);
    const options = secondCall[1] as ExecOptions;
    expect(options.cwd).toBe('/existing-vault');
  });

  it('should write enable-plugin localStorage script when getVaultId returns a value', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue('abc123');
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    // The 2nd writeFile call is the enablePluginsInLocalStorage script.
    const secondWrite = ensureNonNullable(mockWriteFile.mock.calls[1]);
    const scriptContent = secondWrite[1];
    expect(scriptContent).toContain('enable-plugin-abc123');
  });

  it('should skip enablePluginsInLocalStorage when getVaultId returns undefined', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    // With getVaultId returning undefined, only 2 exec calls (IPC + poll), not 3.
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('should use an existing registered vault path for the initial vault-open IPC eval', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue('abc123');
    vi.mocked(getAnyRegisteredVaultPath).mockReturnValue('/existing-vault');
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    const firstCall = ensureNonNullable(mockExec.mock.calls[0]);
    const options = firstCall[1] as ExecOptions;
    expect(options.cwd).toBe('/existing-vault');
  });

  it('should register vault directly in config when no existing vault is registered', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getAnyRegisteredVaultPath).mockReturnValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    expect(mockRegisterVaultInConfig).toHaveBeenCalledWith(vaultPath);
  });

  it('should use vaultPath as cwd for the poll loop eval', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue('abc123');
    vi.mocked(getAnyRegisteredVaultPath).mockReturnValue('/existing-vault');
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    // The poll loop call is the 3rd exec invocation.
    const thirdCall = ensureNonNullable(mockExec.mock.calls[2]);
    const options = thirdCall[1] as ExecOptions;
    expect(options.cwd).toBe(vaultPath);
  });
});

function getWrittenScript(mock: MockInstance<(path: string, content: string) => Promise<void>>): string {
  return ensureNonNullable(mock.mock.calls[0])[1];
}
