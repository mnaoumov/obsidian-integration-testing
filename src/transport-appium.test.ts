import type { Browser } from 'webdriverio';

import { tmpdir } from 'node:os';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { StartupProbeResult } from './app-startup-progress.ts';

import { log } from './log.ts';
import { strictProxy } from './strict-proxy.ts';
import { AppiumTransport } from './transport-appium.ts';
import { ensureNonNullable } from './type-guards.ts';

const mockExec = vi.hoisted(() => vi.fn<(command: string | string[], options?: Record<string, unknown>) => Promise<string>>().mockResolvedValue(''));

vi.mock('./exec.ts', () => ({
  exec: mockExec
}));

vi.mock('node:fs/promises', () => ({
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./log.ts', () => ({
  log: vi.fn()
}));

interface ExecOptions extends Record<string, unknown> {
  readonly cwd: string;
}

/**
 * What the WebView startup probe reports once Obsidian is fully up.
 */
const STARTED_PROBE: StartupProbeResult = {
  hasApp: true,
  hasWorkspace: true,
  isLayoutReady: true
};

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
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android'
    });
    mockExec.mockReset().mockResolvedValue('');
  });

  it('should use tmpdir() as cwd for tar to avoid drive-letter path issues', async () => {
    await transport.pushFiles(String.raw`C:\Users\test\vault`, {});

    const tarCall = ensureNonNullable(mockExec.mock.calls[0]);
    const command = tarCall[0] as string[];
    const options = tarCall[1] as ExecOptions;

    expect(command[0]).toBe('tar');
    expect(command).toContain('czf');
    expect(options.cwd).toBe(tmpdir());
  });

  it('should use relative archive name in tar command to avoid drive-letter issues', async () => {
    await transport.pushFiles(String.raw`C:\Users\test\vault`, {});

    const tarCall = ensureNonNullable(mockExec.mock.calls[0]);
    const command = tarCall[0] as string[];

    // The archive name (2nd positional arg after 'czf') should be just a filename, not an absolute path.
    const archiveArgument = ensureNonNullable(command[2]);
    expect(archiveArgument).not.toContain('/');
    expect(archiveArgument).not.toContain('\\');
    expect(archiveArgument).toMatch(/^vault-.*\.tar\.gz$/);
  });

  it('should not include --force-local flag for cross-platform tar compatibility', async () => {
    await transport.pushFiles('/tmp/vault', {});

    const tarCall = ensureNonNullable(mockExec.mock.calls[0]);
    const command = tarCall[0] as string[];

    expect(command).not.toContain('--force-local');
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
      const command = call[0] as string[];
      return Array.isArray(command) && command[0] === 'adb' && command.includes('push');
    });

    expect(adbPushCall).toBeDefined();
    const command = ensureNonNullable(adbPushCall)[0] as string[];
    expect(command).toContain('-s');
    expect(command).toContain('emulator-5554');
  });

  it('should extract archive on device at correct vault path', async () => {
    await transport.pushFiles('/tmp/my-vault', {});

    const adbExtractCall = mockExec.mock.calls.find((call) => {
      const command = call[0] as string[];
      return Array.isArray(command) && command[0] === 'adb' && command.includes('tar');
    });

    expect(adbExtractCall).toBeDefined();
    const command = ensureNonNullable(adbExtractCall)[0] as string[];
    // Should extract to /sdcard/Documents/<vault-name>/
    expect(command).toContain('-C');
    const cIndex = command.indexOf('-C');
    expect(command[cIndex + 1]).toBe('/sdcard/Documents/my-vault');
  });
});

describe('AppiumTransport.registerVault', () => {
  let transport: AppiumTransport;
  let mockBrowser: MockBrowser;

  beforeEach(() => {
    mockBrowser = createMockBrowser();
    // Report a fully started, laid-out app so both startup phases resolve on the first probe.
    mockBrowser.execute.mockResolvedValue(STARTED_PROBE);
    mockExec.mockReset().mockResolvedValue('');
    transport = new AppiumTransport({
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android'
    });
  });

  it('should push .obsidian/app.json marker to device vault path via adb', async () => {
    await transport.registerVault('/tmp/my-vault');

    const pushCall = mockExec.mock.calls.find((call) => {
      const command = call[0];
      return Array.isArray(command) && command[0] === 'adb' && command.includes('push');
    });

    expect(pushCall).toBeDefined();
    const command = ensureNonNullable(pushCall)[0] as string[];
    expect(command).toContain('-s');
    expect(command).toContain('emulator-5554');
    expect(command.at(-1)).toBe('/sdcard/Documents/my-vault/.obsidian/app.json');
  });

  it('should create the .obsidian directory on the device before pushing the marker', async () => {
    await transport.registerVault('/tmp/my-vault');

    const mkdirCall = mockExec.mock.calls.find((call) => {
      const command = call[0];
      return Array.isArray(command) && command[0] === 'adb' && command.includes('mkdir');
    });

    expect(mkdirCall).toBeDefined();
    const command = ensureNonNullable(mkdirCall)[0] as string[];
    expect(command).toContain('-p');
    expect(command.at(-1)).toBe('/sdcard/Documents/my-vault/.obsidian');
  });

  it('should switch to WebView context before configuring localStorage', async () => {
    await transport.registerVault('/tmp/my-vault');

    expect(mockBrowser.switchContext).toHaveBeenCalledWith('WEBVIEW_md.obsidian');
  });

  it('should execute localStorage configuration with device vault path', async () => {
    await transport.registerVault('/tmp/my-vault');

    // The execute call sets localStorage entries, and prunes earlier runs' temp-vault registrations.
    expect(mockBrowser.execute).toHaveBeenCalledWith(
      expect.any(Function),
      '/sdcard/Documents/my-vault',
      '/sdcard/Documents/temp-vault-'
    );
  });

  it('should not pass a prune prefix when leftover sweeping is disabled', async () => {
    const noSweepTransport = new AppiumTransport({
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android',
      shouldSweepLeftovers: false
    });

    await noSweepTransport.registerVault('/tmp/my-vault');

    expect(mockBrowser.execute).toHaveBeenCalledWith(
      expect.any(Function),
      '/sdcard/Documents/my-vault',
      ''
    );
  });
});

describe('AppiumTransport.unregisterVault', () => {
  let transport: AppiumTransport;
  let mockBrowser: MockBrowser;

  beforeEach(() => {
    mockBrowser = createMockBrowser();
    mockBrowser.execute.mockResolvedValue(true);
    mockExec.mockReset().mockResolvedValue('');
    transport = new AppiumTransport({
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android'
    });
  });

  it('should remove the vault directory from the device', async () => {
    await transport.unregisterVault('/tmp/my-vault');

    const rmCall = mockExec.mock.calls.find((call) => {
      const command = call[0];
      return Array.isArray(command) && command[0] === 'adb' && command.includes('rm');
    });

    expect(rmCall).toBeDefined();
    const command = ensureNonNullable(rmCall)[0] as string[];
    expect(command).toContain('-rf');
    expect(command.at(-1)).toBe('/sdcard/Documents/my-vault');
  });

  it('should still remove the vault directory when the WebView is gone', async () => {
    mockBrowser.execute.mockRejectedValue(new Error('no such window: target window already closed'));

    await transport.unregisterVault('/tmp/my-vault');

    const rmCall = mockExec.mock.calls.find((call) => {
      const command = call[0];
      return Array.isArray(command) && command[0] === 'adb' && command.includes('rm');
    });

    expect(rmCall).toBeDefined();
    const command = ensureNonNullable(rmCall)[0] as string[];
    expect(command.at(-1)).toBe('/sdcard/Documents/my-vault');
  });
});

describe('AppiumTransport startup budgets', () => {
  let mockBrowser: MockBrowser;

  beforeEach(() => {
    mockBrowser = createMockBrowser();
    // Report a fully started, laid-out app so registerVault resolves without waiting.
    mockBrowser.execute.mockResolvedValue(STARTED_PROBE);
    vi.mocked(log).mockClear();
  });

  it('should default the app-start timeout to 180000ms', async () => {
    const transport = new AppiumTransport({
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android'
    });

    await transport.registerVault('/tmp/my-vault');

    expect(vi.mocked(log)).toHaveBeenCalledWith(expect.stringContaining('Waiting for the app to start (timeout=180000ms)'));
  });

  it('should use the configured appStartTimeoutInMilliseconds', async () => {
    const CUSTOM_TIMEOUT_IN_MILLISECONDS = 23_456;
    const transport = new AppiumTransport({
      appStartTimeoutInMilliseconds: CUSTOM_TIMEOUT_IN_MILLISECONDS,
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android'
    });

    await transport.registerVault('/tmp/my-vault');

    expect(vi.mocked(log)).toHaveBeenCalledWith(expect.stringContaining('Waiting for the app to start (timeout=23456ms)'));
  });

  it('should default the layout-ready timeout to 90000ms', async () => {
    const transport = new AppiumTransport({
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android'
    });

    await transport.registerVault('/tmp/my-vault');

    expect(vi.mocked(log)).toHaveBeenCalledWith(expect.stringContaining('Waiting for layout ready (timeout=90000ms)'));
  });

  it('should use the configured layoutReadyTimeoutInMilliseconds', async () => {
    const CUSTOM_TIMEOUT_IN_MILLISECONDS = 12_345;
    const transport = new AppiumTransport({
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      layoutReadyTimeoutInMilliseconds: CUSTOM_TIMEOUT_IN_MILLISECONDS,
      platform: 'android'
    });

    await transport.registerVault('/tmp/my-vault');

    expect(vi.mocked(log)).toHaveBeenCalledWith(expect.stringContaining('Waiting for layout ready (timeout=12345ms)'));
  });

  it('should not start the layout-ready clock until the app has started', async () => {
    mockBrowser.execute
      // The localStorage write that triggers the reload.
      .mockResolvedValueOnce(undefined)
      // The app is still cold-starting: the WebView answers, but there is no `app` yet.
      .mockResolvedValueOnce({ hasApp: false, hasWorkspace: false, isLayoutReady: false })
      .mockResolvedValue(STARTED_PROBE);

    const transport = new AppiumTransport({
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android'
    });

    await transport.registerVault('/tmp/my-vault');

    const messages = vi.mocked(log).mock.calls.map(([message]) => message);
    const appStartNotSatisfiedIndex = messages.findIndex((message) => message.includes('Phase "app-start" not satisfied yet: no-app'));
    const layoutClockStartedIndex = messages.findIndex((message) => message.includes('Waiting for layout ready'));

    expect(appStartNotSatisfiedIndex).toBeGreaterThanOrEqual(0);
    // The tight budget's clock is announced only after the generous one is satisfied.
    expect(layoutClockStartedIndex).toBeGreaterThan(appStartNotSatisfiedIndex);
  });

  it('should report the furthest milestone and the probe timings when a budget runs out', async () => {
    const SHORT_TIMEOUT_IN_MILLISECONDS = 600;
    mockBrowser.execute
      // The localStorage write that triggers the reload.
      .mockResolvedValueOnce(undefined)
      // The WebView never comes back.
      .mockRejectedValue(new Error('no such window: target window already closed'));

    const transport = new AppiumTransport({
      appStartTimeoutInMilliseconds: SHORT_TIMEOUT_IN_MILLISECONDS,
      browser: strictProxy<Browser>(mockBrowser),
      deviceId: 'emulator-5554',
      platform: 'android'
    });

    await expect(transport.registerVault('/tmp/my-vault')).rejects.toThrow(
      /Obsidian Mobile did not finish starting within 600ms[\s\S]*never answered a single probe[\s\S]*slowest round-trip/
    );
  });
});

describe('AppiumTransport.evaluate', () => {
  let transport: AppiumTransport;
  let mockBrowser: MockBrowser;

  beforeEach(() => {
    mockBrowser = createMockBrowser();
    transport = new AppiumTransport({
      browser: strictProxy<Browser>(mockBrowser),
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
