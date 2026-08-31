import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from 'vitest';

import {
  bootstrapDemoVaultPlugins,
  buildDemoVaultPopulateAsync
} from './demo-vault-bootstrap.ts';

// Every case here is deliberately a NO-DOWNLOAD case.
// The bootstrap must not touch the network when the binaries are on disk already, or the plugin opted out.
// A unit test that did reach GitHub would be slow and flaky; the download path is covered by integration.
describe('bootstrapDemoVaultPlugins', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-vault-bootstrap-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  function writePluginBinaries(pluginId: string, sourceDirectory?: string): string {
    const directory = sourceDirectory ?? join(root, '.obsidian', 'plugins', pluginId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'main.js'), `// ${pluginId} main`);
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ id: pluginId }));
    return directory;
  }

  it('should skip a plugin whose binaries are already installed', async () => {
    writePluginBinaries('fix-require-modules');

    const result = await bootstrapDemoVaultPlugins({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'fix-require-modules' }]
    });

    expect(result.installed).toEqual([]);
    expect(result.skippedPluginIds).toEqual(['fix-require-modules']);
  });

  it('should skip a plugin that opted out with an explicit sourceDirectory, even when it is incomplete', async () => {
    const sourceDirectory = join(root, 'dist');
    mkdirSync(sourceDirectory, { recursive: true });

    const result = await bootstrapDemoVaultPlugins({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'some-plugin', sourceDirectory }]
    });

    expect(result.installed).toEqual([]);
    expect(result.skippedPluginIds).toEqual(['some-plugin']);
  });

  it('should skip an opted-out plugin even under force, so a local build output is never overwritten', async () => {
    const sourceDirectory = writePluginBinaries('some-plugin', join(root, 'dist'));

    const result = await bootstrapDemoVaultPlugins({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'some-plugin', sourceDirectory }],
      shouldForce: true
    });

    expect(result.installed).toEqual([]);
    expect(result.skippedPluginIds).toEqual(['some-plugin']);
  });

  it('should report every plugin as skipped when nothing needs installing', async () => {
    writePluginBinaries('fix-require-modules');
    writePluginBinaries('backlink-cache');

    const result = await bootstrapDemoVaultPlugins({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'fix-require-modules' }, { pluginId: 'backlink-cache' }]
    });

    expect(result.installed).toEqual([]);
    expect(result.skippedPluginIds).toEqual(['fix-require-modules', 'backlink-cache']);
  });

  it('should do nothing for an empty plugin list', async () => {
    const result = await bootstrapDemoVaultPlugins({ demoVaultPath: root, injectPlugins: [] });

    expect(result.installed).toEqual([]);
    expect(result.skippedPluginIds).toEqual([]);
  });
});

describe('buildDemoVaultPopulateAsync', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-vault-bootstrap-populate-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('should build the same map as the synchronous builder when nothing needs installing', async () => {
    writeFileSync(join(root, 'note.md'), 'top');
    const pluginDirectory = join(root, '.obsidian', 'plugins', 'fix-require-modules');
    mkdirSync(pluginDirectory, { recursive: true });
    writeFileSync(join(pluginDirectory, 'main.js'), '// main');
    writeFileSync(join(pluginDirectory, 'manifest.json'), '{"id":"fix-require-modules"}');

    const map = await buildDemoVaultPopulateAsync({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'fix-require-modules' }]
    });

    expect(map['note.md']?.toString()).toBe('top');
    expect(map['.obsidian/plugins/fix-require-modules/main.js']?.toString()).toBe('// main');
    expect(map['.obsidian/plugins/fix-require-modules/manifest.json']?.toString()).toBe('{"id":"fix-require-modules"}');
  });

  it('should build the map without touching the network when no plugins are injected', async () => {
    writeFileSync(join(root, 'note.md'), 'top');

    const map = await buildDemoVaultPopulateAsync({ demoVaultPath: root });

    expect(map['note.md']?.toString()).toBe('top');
  });
});
