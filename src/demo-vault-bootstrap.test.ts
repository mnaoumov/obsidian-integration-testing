import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  it,
  vi
} from 'vitest';

import {
  bootstrapDemoVaultPlugins,
  buildDemoVaultPopulateAsync
} from './demo-vault-bootstrap.ts';

// No case here reaches the network. Most are NO-DOWNLOAD cases outright: the bootstrap must not fetch when
// The binaries are on disk already, or the plugin opted out. The one case that DOES walk the install loop
// Stubs `fetch` and passes an explicit `repo`, so neither the asset download nor the memoised community
// Registry lookup leaves the process — a real GitHub round-trip would be slow and flaky here, and the
// Genuine end-to-end download stays an integration test.
const HTTP_NOT_FOUND = 404;
const PLUGIN_ASSET_BODIES = new Map<string, string>([
  ['main.js', '// installed main'],
  ['manifest.json', '{"id":"installed-plugin"}']
]);

describe('bootstrapDemoVaultPlugins', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-vault-bootstrap-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
    vi.unstubAllGlobals();
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

  it('should download and write the binaries of a plugin that is missing', async () => {
    vi.stubGlobal('fetch', servePluginAssets);

    const result = await bootstrapDemoVaultPlugins({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'installed-plugin', repo: 'demo-owner/obsidian-installed-plugin' }]
    });

    expect(result.installed).toEqual([{
      assetNames: ['main.js', 'manifest.json'],
      pluginId: 'installed-plugin',
      repo: 'demo-owner/obsidian-installed-plugin',
      version: undefined
    }]);
    expect(result.skippedPluginIds).toEqual([]);

    const installedDirectory = join(root, '.obsidian', 'plugins', 'installed-plugin');
    expect(readFileSync(join(installedDirectory, 'main.js'), 'utf-8')).toBe('// installed main');
    expect(readFileSync(join(installedDirectory, 'manifest.json'), 'utf-8')).toBe('{"id":"installed-plugin"}');
    expect(existsSync(join(installedDirectory, 'styles.css'))).toBe(false);
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

/**
 * A `fetch` that serves a plugin's release assets from memory, so the install loop can be exercised without
 * a GitHub round-trip. The optional stylesheet answers 404 — what GitHub returns for a plugin that
 * publishes none — so the "skip an absent optional asset" path is walked too.
 *
 * @param input - The asset URL the bootstrap asked for.
 * @returns The asset's response.
 */
function servePluginAssets(input: RequestInfo | URL): Promise<Response> {
  const url = new Request(input).url;

  for (const [assetName, body] of PLUGIN_ASSET_BODIES) {
    if (url.endsWith(`/${assetName}`)) {
      return Promise.resolve(new Response(body));
    }
  }

  return Promise.resolve(new Response('', { status: HTTP_NOT_FOUND, statusText: 'Not Found' }));
}
