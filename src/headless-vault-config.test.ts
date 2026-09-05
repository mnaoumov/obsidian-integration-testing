import { join } from 'node:path';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { ensureHeadlessVaultConfig } from './headless-vault-config.ts';

const LABEL = 'obsidian-cdp';
const VAULT_PATH = join('/tmp', 'harness-vault');
const DEFAULT_APP_JSON_PATH = join(VAULT_PATH, '.obsidian', 'app.json');

const mockMkdir = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => Promise<void>>());
const mockReadFile = vi.hoisted(() => vi.fn<(path: string, encoding: string) => Promise<string>>());
const mockWriteFile = vi.hoisted(() => vi.fn<(path: string, content: string) => Promise<void>>());

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  writeFile: mockWriteFile
}));

vi.mock('./log.ts', () => ({
  log: vi.fn()
}));

/**
 * Reads back the config the writer serialized, so assertions are made against the JSON Obsidian will
 * actually parse rather than against an in-memory object the writer never wrote.
 *
 * @returns The parsed contents of the single `writeFile` call.
 */
function readWrittenConfig(): Record<string, unknown> {
  const call = mockWriteFile.mock.calls[0];
  if (!call) {
    throw new Error('nothing was written');
  }

  return JSON.parse(call[1]) as Record<string, unknown>;
}

/**
 * Makes `readFile` reject the way a missing file does.
 */
function rejectAsMissing(): void {
  mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMkdir.mockResolvedValue();
  mockWriteFile.mockResolvedValue();
  rejectAsMissing();
});

describe('ensureHeadlessVaultConfig', () => {
  it('writes both headless defaults into a vault that has no app.json yet', async () => {
    await ensureHeadlessVaultConfig({ label: LABEL, vaultPath: VAULT_PATH });

    expect(readWrittenConfig()).toEqual({ alwaysUpdateLinks: true, settingsPopoutWindow: false });
  });

  it('turns the settings popout OFF rather than merely writing the key', async () => {
    // Obsidian ships this `true`, and its `shouldUsePopout()` returns the value directly -- so writing
    // `true` here would be the shipped bug rather than the fix.
    await ensureHeadlessVaultConfig({ label: LABEL, vaultPath: VAULT_PATH });

    expect(readWrittenConfig()['settingsPopoutWindow']).toBe(false);
  });

  it('creates the config folder before writing into it', async () => {
    await ensureHeadlessVaultConfig({ label: LABEL, vaultPath: VAULT_PATH });

    expect(mockMkdir).toHaveBeenCalledWith(join(VAULT_PATH, '.obsidian'), { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(DEFAULT_APP_JSON_PATH, expect.any(String));
  });

  it('merges into an existing app.json instead of replacing it', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ attachmentFolderPath: 'attachments', settingsPopoutWindow: true }));

    await ensureHeadlessVaultConfig({ label: LABEL, vaultPath: VAULT_PATH });

    expect(readWrittenConfig()).toEqual({
      alwaysUpdateLinks: true,
      attachmentFolderPath: 'attachments',
      settingsPopoutWindow: false
    });
  });

  it('overrides a popout preference carried in by populate, because the harness default is not a suggestion', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ alwaysUpdateLinks: false, settingsPopoutWindow: true }));

    await ensureHeadlessVaultConfig({ label: LABEL, vaultPath: VAULT_PATH });

    expect(readWrittenConfig()).toEqual({ alwaysUpdateLinks: true, settingsPopoutWindow: false });
  });

  it('starts from an empty config when the existing app.json is unreadable', async () => {
    mockReadFile.mockResolvedValue('} not json {');

    await ensureHeadlessVaultConfig({ label: LABEL, vaultPath: VAULT_PATH });

    expect(readWrittenConfig()).toEqual({ alwaysUpdateLinks: true, settingsPopoutWindow: false });
  });

  it('honours a configDirectory override, which the vault is the one reading', async () => {
    // Writing into `.obsidian` while the vault reads `.obsidian-desktop` drops both defaults with no
    // Error to say so -- the failure the override path had before this parameter existed.
    await ensureHeadlessVaultConfig({ configDirectory: '.obsidian-desktop', label: LABEL, vaultPath: VAULT_PATH });

    expect(mockMkdir).toHaveBeenCalledWith(join(VAULT_PATH, '.obsidian-desktop'), { recursive: true });
    expect(mockReadFile).toHaveBeenCalledWith(join(VAULT_PATH, '.obsidian-desktop', 'app.json'), 'utf-8');
    expect(mockWriteFile).toHaveBeenCalledWith(join(VAULT_PATH, '.obsidian-desktop', 'app.json'), expect.any(String));
  });

  it('falls back to .obsidian when the override is explicitly undefined', async () => {
    await ensureHeadlessVaultConfig({ configDirectory: undefined, label: LABEL, vaultPath: VAULT_PATH });

    expect(mockWriteFile).toHaveBeenCalledWith(DEFAULT_APP_JSON_PATH, expect.any(String));
  });
});
