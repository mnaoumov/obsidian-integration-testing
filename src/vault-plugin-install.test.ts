import { join } from 'node:path';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { installPluginIntoVault } from './vault-plugin-install.ts';

const DIST_PATH = join('/repo', 'dist', 'build');
const PLUGIN_ID = 'plugin-under-test';
const VAULT_PATH = join('/tmp', 'harness-vault');
const OVERRIDE = '.obsidian-desktop';

const mockCp = vi.hoisted(() => vi.fn<(source: string, destination: string, options?: unknown) => Promise<void>>());
const mockMkdir = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => Promise<void>>());
const mockWriteFile = vi.hoisted(() => vi.fn<(path: string, content: string) => Promise<void>>());

vi.mock('node:fs/promises', () => ({
  cp: mockCp,
  mkdir: mockMkdir,
  writeFile: mockWriteFile
}));

/**
 * Reads back the `community-plugins.json` the installer serialized, so the enable list is asserted as the
 * JSON Obsidian will actually parse rather than as an in-memory value nothing wrote.
 *
 * @returns The parsed contents of the single `writeFile` call.
 */
function readWrittenEnableList(): unknown {
  const call = mockWriteFile.mock.calls[0];
  if (!call) {
    throw new Error('nothing was written');
  }

  return JSON.parse(call[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCp.mockResolvedValue();
  mockMkdir.mockResolvedValue();
  mockWriteFile.mockResolvedValue();
});

describe('installPluginIntoVault', () => {
  it('copies the build into .obsidian/plugins/<id> when nothing overrides the config folder', async () => {
    await installPluginIntoVault({ distPath: DIST_PATH, pluginId: PLUGIN_ID, vaultPath: VAULT_PATH });

    const pluginDirectory = join(VAULT_PATH, '.obsidian', 'plugins', PLUGIN_ID);
    expect(mockMkdir).toHaveBeenCalledWith(pluginDirectory, { recursive: true });
    expect(mockCp).toHaveBeenCalledWith(DIST_PATH, pluginDirectory, { recursive: true });
  });

  it('creates the plugin directory before copying into it', async () => {
    await installPluginIntoVault({ distPath: DIST_PATH, pluginId: PLUGIN_ID, vaultPath: VAULT_PATH });

    expect(mockMkdir.mock.invocationCallOrder[0]).toBeLessThan(mockCp.mock.invocationCallOrder[0] ?? 0);
  });

  it('writes the plugin id into community-plugins.json, which is what enables it on load', async () => {
    await installPluginIntoVault({ distPath: DIST_PATH, pluginId: PLUGIN_ID, vaultPath: VAULT_PATH });

    expect(mockWriteFile).toHaveBeenCalledWith(join(VAULT_PATH, '.obsidian', 'community-plugins.json'), expect.any(String));
    expect(readWrittenEnableList()).toEqual([PLUGIN_ID]);
  });

  it('honours a configDirectory override, which the vault is the one reading', async () => {
    // Installing into `.obsidian` while the vault reads `.obsidian-desktop` puts the plugin where nothing
    // Looks for it, and the enable that follows reports only the generic "enabled but not loaded" -- the
    // Failure the override path had before this parameter existed.
    await installPluginIntoVault({ configDirectory: OVERRIDE, distPath: DIST_PATH, pluginId: PLUGIN_ID, vaultPath: VAULT_PATH });

    expect(mockMkdir).toHaveBeenCalledWith(join(VAULT_PATH, OVERRIDE, 'plugins', PLUGIN_ID), { recursive: true });
    expect(mockCp).toHaveBeenCalledWith(DIST_PATH, join(VAULT_PATH, OVERRIDE, 'plugins', PLUGIN_ID), { recursive: true });
  });

  it('puts community-plugins.json in the overridden folder too, not beside it in .obsidian', async () => {
    // The enable list is the half that decides whether Obsidian loads the plugin at all, so a copy that
    // Reached the right folder still loads nothing if this one did not.
    await installPluginIntoVault({ configDirectory: OVERRIDE, distPath: DIST_PATH, pluginId: PLUGIN_ID, vaultPath: VAULT_PATH });

    expect(mockWriteFile).toHaveBeenCalledWith(join(VAULT_PATH, OVERRIDE, 'community-plugins.json'), expect.any(String));
    expect(mockWriteFile).not.toHaveBeenCalledWith(join(VAULT_PATH, '.obsidian', 'community-plugins.json'), expect.any(String));
  });

  it('falls back to .obsidian when the override is explicitly undefined', async () => {
    // `resolveOwnedConfigDirectory` returns `undefined` in attach mode and on Android, and the caller
    // Passes that through rather than branching -- so the property is present and unset on those runs.
    await installPluginIntoVault({ configDirectory: undefined, distPath: DIST_PATH, pluginId: PLUGIN_ID, vaultPath: VAULT_PATH });

    expect(mockMkdir).toHaveBeenCalledWith(join(VAULT_PATH, '.obsidian', 'plugins', PLUGIN_ID), { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(join(VAULT_PATH, '.obsidian', 'community-plugins.json'), expect.any(String));
  });
});
