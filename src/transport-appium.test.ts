import { tmpdir } from 'node:os';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { AppiumTransport } from './transport-appium.ts';
import { ensureNonNullable } from './type-guards.ts';

const mockExec = vi.hoisted(() => vi.fn<(command: string | string[], options?: Record<string, unknown>) => Promise<string>>().mockResolvedValue(''));

vi.mock('./exec.ts', () => ({
  exec: mockExec
}));

vi.mock('node:fs/promises', () => ({
  rm: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./log.ts', () => ({
  log: vi.fn()
}));

interface ExecOptions extends Record<string, unknown> {
  cwd: string;
}

interface MockBrowser {
  activateApp: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  getContexts: ReturnType<typeof vi.fn>;
  pushFile: ReturnType<typeof vi.fn>;
  queryAppState: ReturnType<typeof vi.fn>;
  switchContext: ReturnType<typeof vi.fn>;
}

function createMockBrowser(): MockBrowser {
  return {
    activateApp: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(null),
    getContexts: vi.fn().mockResolvedValue(['WEBVIEW_md.obsidian']),
    pushFile: vi.fn().mockResolvedValue(undefined),
    queryAppState: vi.fn().mockResolvedValue(4),
    switchContext: vi.fn().mockResolvedValue(undefined)
  };
}

describe('AppiumTransport.pushFiles', () => {
  let transport: AppiumTransport;
  let mockBrowser: MockBrowser;

  beforeEach(() => {
    mockBrowser = createMockBrowser();
    transport = new AppiumTransport({
      browser: mockBrowser as never,
      deviceId: 'emulator-5554',
      platform: 'android'
    });
    mockExec.mockReset().mockResolvedValue('');
  });

  it('should use tmpdir() as cwd for tar to avoid drive-letter path issues', async () => {
    await transport.pushFiles('C:\\Users\\test\\vault', {});

    const tarCall = ensureNonNullable(mockExec.mock.calls[0]);
    const command = tarCall[0] as string[];
    const options = tarCall[1] as ExecOptions;

    expect(command[0]).toBe('tar');
    expect(command).toContain('czf');
    expect(options.cwd).toBe(tmpdir());
  });

  it('should use relative archive name in tar command to avoid drive-letter issues', async () => {
    await transport.pushFiles('C:\\Users\\test\\vault', {});

    const tarCall = ensureNonNullable(mockExec.mock.calls[0]);
    const command = tarCall[0] as string[];

    // The archive name (2nd positional arg after 'czf') should be just a filename, not an absolute path.
    const archiveArg = ensureNonNullable(command[2]);
    expect(archiveArg).not.toContain('/');
    expect(archiveArg).not.toContain('\\');
    expect(archiveArg).toMatch(/^vault-.*\.tar\.gz$/);
  });

  it('should include --force-local flag for Windows tar compatibility', async () => {
    await transport.pushFiles('/tmp/vault', {});

    const tarCall = ensureNonNullable(mockExec.mock.calls[0]);
    const command = tarCall[0] as string[];

    expect(command).toContain('--force-local');
  });

  it('should use -C with vaultPath to archive vault contents', async () => {
    const vaultPath = '/tmp/my-vault';
    await transport.pushFiles(vaultPath, {});

    const tarCall = ensureNonNullable(mockExec.mock.calls[0]);
    const command = tarCall[0] as string[];

    const cIndex = command.indexOf('-C');
    expect(cIndex).toBeGreaterThan(-1);
    expect(command[cIndex + 1]).toBe(vaultPath);
  });

  it('should push archive to device via adb', async () => {
    await transport.pushFiles('/tmp/vault', {});

    const adbPushCall = mockExec.mock.calls.find((call) => {
      const cmd = call[0] as string[];
      return Array.isArray(cmd) && cmd[0] === 'adb' && cmd.includes('push');
    });

    expect(adbPushCall).toBeDefined();
    const cmd = ensureNonNullable(adbPushCall)[0] as string[];
    expect(cmd).toContain('-s');
    expect(cmd).toContain('emulator-5554');
  });

  it('should extract archive on device at correct vault path', async () => {
    await transport.pushFiles('/tmp/my-vault', {});

    const adbExtractCall = mockExec.mock.calls.find((call) => {
      const cmd = call[0] as string[];
      return Array.isArray(cmd) && cmd[0] === 'adb' && cmd.includes('tar');
    });

    expect(adbExtractCall).toBeDefined();
    const cmd = ensureNonNullable(adbExtractCall)[0] as string[];
    // Should extract to /sdcard/Documents/<vault-name>/
    expect(cmd).toContain('-C');
    const cIndex = cmd.indexOf('-C');
    expect(cmd[cIndex + 1]).toBe('/sdcard/Documents/my-vault');
  });
});

describe('AppiumTransport.registerVault', () => {
  let transport: AppiumTransport;
  let mockBrowser: MockBrowser;

  beforeEach(() => {
    mockBrowser = createMockBrowser();
    mockBrowser.execute.mockResolvedValue(true);
    transport = new AppiumTransport({
      browser: mockBrowser as never,
      deviceId: 'emulator-5554',
      platform: 'android'
    });
  });

  it('should push .obsidian/app.json marker to device vault path', async () => {
    await transport.registerVault('/tmp/my-vault');

    expect(mockBrowser.pushFile).toHaveBeenCalledWith(
      '/sdcard/Documents/my-vault/.obsidian/app.json',
      expect.any(String)
    );
  });

  it('should switch to WebView context before configuring localStorage', async () => {
    await transport.registerVault('/tmp/my-vault');

    expect(mockBrowser.switchContext).toHaveBeenCalledWith('WEBVIEW_md.obsidian');
  });

  it('should execute localStorage configuration with device vault path', async () => {
    await transport.registerVault('/tmp/my-vault');

    // The execute call sets localStorage entries.
    expect(mockBrowser.execute).toHaveBeenCalledWith(
      expect.any(Function),
      '/sdcard/Documents/my-vault'
    );
  });
});

describe('AppiumTransport.evaluate', () => {
  let transport: AppiumTransport;
  let mockBrowser: MockBrowser;

  beforeEach(() => {
    mockBrowser = createMockBrowser();
    transport = new AppiumTransport({
      browser: mockBrowser as never,
      deviceId: 'emulator-5554',
      platform: 'android'
    });
  });

  it('should not use cwd for targeting (mobile uses WebView context)', async () => {
    mockBrowser.execute.mockResolvedValue('"result"');

    // CWD is ignored on mobile — the test verifies it doesn't throw
    // Regardless of what cwd is passed.
    const result = await transport.evaluate('"hello"', { cwd: '/nonexistent/path' });
    expect(result).toBe('"result"');
  });

  it('should return (no output) for null results', async () => {
    mockBrowser.execute.mockResolvedValue(null);

    const result = await transport.evaluate('"hello"', { cwd: '/tmp' });
    expect(result).toBe('(no output)');
  });

  it('should return (no output) for undefined results', async () => {
    mockBrowser.execute.mockResolvedValue(undefined);

    const result = await transport.evaluate('"hello"', { cwd: '/tmp' });
    expect(result).toBe('(no output)');
  });
});
