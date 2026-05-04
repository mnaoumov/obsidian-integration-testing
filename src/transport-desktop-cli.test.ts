import type { MockInstance } from 'vitest';

import vm from 'node:vm';
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

const mockExec = vi.hoisted(() => vi.fn<(command: string | string[], options?: Record<string, unknown>) => Promise<string>>().mockResolvedValue(''));

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

vi.mock('./obsidian-config.ts', () => ({
  getAnyRegisteredVaultPath: vi.fn().mockReturnValue('/existing-vault'),
  getVaultId: vi.fn(),
  isCliEnabled: vi.fn().mockReturnValue(true),
  isVaultRegistered: vi.fn().mockReturnValue(true)
}));

let transport: DesktopCliTransport;

beforeEach(() => {
  transport = new DesktopCliTransport();
  mockExec.mockReset().mockResolvedValue('');
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
    const fakeFs = {
      writeFileSync(_path: string, data: string): void {
        writtenJson = data;
      }
    };
    const fakeExports: Record<string, () => Promise<void>> = {};
    const context = vm.createContext({
      exports: fakeExports,
      require(mod: string): unknown {
        if (mod === 'fs') {
          return fakeFs;
        }
        throw new Error(`Unexpected require: ${mod}`);
      }
    });
    vm.runInContext(scriptContent, context);
    const invokeFn = Object.values(fakeExports)[0] as () => Promise<void>;
    await invokeFn();
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
  it('should pass vaultPath as cwd to enablePluginsInLocalStorage eval', async () => {
    const vaultPath = '/tmp/test-vault';
    vi.mocked(getVaultId).mockReturnValue('abc123');
    mockReadFile.mockResolvedValue(JSON.stringify({ value: JSON.stringify(vaultPath) }));

    await transport.registerVault(vaultPath);

    // RegisterVault calls evaluate 3 times:
    //   1. vault-open IPC (cwd: existing registered vault)
    //   2. enablePluginsInLocalStorage (cwd: vaultPath)
    //   3. poll loop (cwd: vaultPath)
    const secondCall = ensureNonNullable(mockExec.mock.calls[1]);
    const options = secondCall[1] as ExecOptions;
    expect(options.cwd).toBe(vaultPath);
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

  it('should throw when no existing vault is registered', async () => {
    vi.mocked(getAnyRegisteredVaultPath).mockReturnValue(undefined);

    await expect(transport.registerVault('/tmp/test-vault')).rejects.toThrow(
      'Cannot register a vault: no existing vault is registered'
    );
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
