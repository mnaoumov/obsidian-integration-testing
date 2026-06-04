import type { MockInstance } from 'vitest';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  getAnyOpenVaultPath,
  getVaultId
} from './obsidian-config.ts';
import { serializeError } from './serialize-error.ts';
import {
  DesktopCliTransport,
  invokeAndWriteResult
} from './transport-desktop-cli.ts';
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

vi.mock('./namespace-bootstrap.ts', () => ({
  ensureNamespaceBootstrapped: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./log.ts', () => ({
  log: vi.fn()
}));

const mockRegisterVaultInConfig = vi.hoisted(() => vi.fn());
const mockRemoveVaultFromConfig = vi.hoisted(() => vi.fn().mockReturnValue(true));

const mockEnableCliInConfig = vi.hoisted(() => vi.fn());

vi.mock('./obsidian-config.ts', () => ({
  enableCliInConfig: mockEnableCliInConfig,
  getAnyOpenVaultPath: vi.fn().mockReturnValue('/existing-vault'),
  getRegisteredVaults: vi.fn().mockReturnValue([]),
  getVaultId: vi.fn(),
  isCliEnabled: vi.fn().mockReturnValue(true),
  isVaultOpen: vi.fn().mockReturnValue(true),
  isVaultRegistered: vi.fn().mockReturnValue(true),
  registerVaultInConfig: mockRegisterVaultInConfig,
  removeVaultFromConfig: mockRemoveVaultFromConfig
}));

let transport: DesktopCliTransport;

// Mocks window.app.vault.adapter.fsPromises — serialized functions access fs through the
// Vault adapter instead of window.require, bypassing the emulate-mobile require handler.
const mockFsPromisesAccess = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

vi.stubGlobal('window', {
  app: {
    vault: {
      adapter: {
        fsPromises: {
          access: mockFsPromisesAccess,
          readFile: mockReadFile,
          writeFile: mockWriteFile
        }
      }
    }
  }
});

beforeEach(() => {
  transport = new DesktopCliTransport();
  mockExec.mockReset().mockResolvedValue({ exitCode: 0, exitSignal: null, stderr: '', stdout: '' });
  mockExistsSync.mockReset().mockReturnValue(true);
  mockFsPromisesAccess.mockReset().mockResolvedValue(undefined);
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
    expect(codeArg).not.toContain('fn()()');
    expect(codeArg).toContain('console.debug');
    expect(codeArg).toContain('readFile');
  });
});

describe('buildScriptFile (via evaluate)', () => {
  it('should write a script file as an IIFE with serialized invokeAndWriteResult', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ value: 'test' }));
    await transport.evaluate('1 + 1', { cwd: '/vault' });

    const scriptContent = getWrittenScript(mockWriteFile);
    expect(scriptContent).toContain('invokeAndWriteResult');
    expect(scriptContent).toContain('evaluate:');
    expect(scriptContent).toContain('resultPath:');
    expect(scriptContent).toContain('serializeError:');
  });

  it('should embed the expression inside an evaluate arrow function', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ value: '' }));
    await transport.evaluate('myExpression()', { cwd: '/vault' });

    const scriptContent = getWrittenScript(mockWriteFile);
    expect(scriptContent).toContain('async () => (myExpression())');
  });
});

describe('invokeAndWriteResult', () => {
  it('should write { type: "undefined" } when evaluate returns undefined', async () => {
    await invokeAndWriteResult({
      evaluate: () => Promise.resolve(undefined),
      resultPath: '/tmp/result.json',
      serializeError
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/result.json',
      JSON.stringify({ type: 'undefined', value: '' })
    );
  });

  it('should write { type: "null" } when evaluate returns null', async () => {
    await invokeAndWriteResult({
      evaluate: () => Promise.resolve(null),
      resultPath: '/tmp/result.json',
      serializeError
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/result.json',
      JSON.stringify({ type: 'null', value: '' })
    );
  });

  it('should write { value: "hello" } when evaluate returns a string', async () => {
    await invokeAndWriteResult({
      evaluate: () => Promise.resolve('hello'),
      resultPath: '/tmp/result.json',
      serializeError
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/result.json',
      JSON.stringify({ value: 'hello' })
    );
  });

  it('should write { value: "" } when evaluate returns empty string', async () => {
    await invokeAndWriteResult({
      evaluate: () => Promise.resolve(''),
      resultPath: '/tmp/result.json',
      serializeError
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/result.json',
      JSON.stringify({ value: '' })
    );
  });

  it('should write { type: "error" } with serialized error when evaluate throws', async () => {
    await invokeAndWriteResult({
      evaluate: () => Promise.reject(new Error('boom')),
      resultPath: '/tmp/result.json',
      serializeError
    });
    const writtenData = ensureNonNullable(mockWriteFile.mock.calls[0])[1];
    const envelope = JSON.parse(writtenData) as ScriptErrorEnvelope;
    expect(envelope.type).toBe('error');
    expect(envelope.value).toContain('Error: boom');
  });
});

describe('DesktopCliTransport.registerVault', () => {
  it('should use existing vault as cwd for enablePluginsInLocalStorage eval', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue('abc123');
    vi.mocked(getAnyOpenVaultPath).mockReturnValue('/existing-vault');
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

    // With getVaultId returning undefined, only 3 exec calls (IPC + poll + dismissTrustDialog), not 4 — the localStorage write is skipped.
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it('should use an existing registered vault path for the initial vault-open IPC eval', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue('abc123');
    vi.mocked(getAnyOpenVaultPath).mockReturnValue('/existing-vault');
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    const firstCall = ensureNonNullable(mockExec.mock.calls[0]);
    const options = firstCall[1] as ExecOptions;
    expect(options.cwd).toBe('/existing-vault');
  });

  it('should register vault directly in config when no existing vault is registered', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getAnyOpenVaultPath).mockReturnValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    expect(mockRegisterVaultInConfig).toHaveBeenCalledWith(vaultPath);
  });

  it('should use vaultPath as cwd for the poll loop eval', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue('abc123');
    vi.mocked(getAnyOpenVaultPath).mockReturnValue('/existing-vault');
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
