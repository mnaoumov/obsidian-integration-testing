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
  buildDemoVaultPopulate,
  resolveMissingInjectedPlugins
} from './demo-vault-populate.ts';

describe('buildDemoVaultPopulate', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-vault-populate-'));
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

  it('should carry the note tree (excluding .obsidian) into the map', () => {
    writeFileSync(join(root, 'note.md'), 'top');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'child.md'), 'nested');
    mkdirSync(join(root, '.obsidian'));
    writeFileSync(join(root, '.obsidian', 'app.json'), '{"a":1}');

    const map = buildDemoVaultPopulate({ demoVaultPath: root });

    expect(map['note.md']?.toString()).toBe('top');
    expect(map['sub/child.md']?.toString()).toBe('nested');
  });

  it('should carry over the default .obsidian config files that exist and skip the missing ones', () => {
    mkdirSync(join(root, '.obsidian'));
    writeFileSync(join(root, '.obsidian', 'app.json'), '{"app":true}');
    writeFileSync(join(root, '.obsidian', 'appearance.json'), '{"appearance":true}');
    // The core-plugins.json file is intentionally absent.

    const map = buildDemoVaultPopulate({ demoVaultPath: root });

    expect(map['.obsidian/app.json']?.toString()).toBe('{"app":true}');
    expect(map['.obsidian/appearance.json']?.toString()).toBe('{"appearance":true}');
    expect(map['.obsidian/core-plugins.json']).toBeUndefined();
  });

  it('should honor a custom obsidianConfigFiles list', () => {
    mkdirSync(join(root, '.obsidian'));
    writeFileSync(join(root, '.obsidian', 'hotkeys.json'), '{"h":1}');
    writeFileSync(join(root, '.obsidian', 'app.json'), '{"a":1}');

    const map = buildDemoVaultPopulate({ demoVaultPath: root, obsidianConfigFiles: ['hotkeys.json'] });

    expect(map['.obsidian/hotkeys.json']?.toString()).toBe('{"h":1}');
    // The app.json file is not in the custom list, so it is not carried over.
    expect(map['.obsidian/app.json']).toBeUndefined();
  });

  it('should forward excludedNames to readDemoVaultTree', () => {
    writeFileSync(join(root, 'keep.md'), 'k');
    writeFileSync(join(root, 'skip.md'), 's');

    const map = buildDemoVaultPopulate({ demoVaultPath: root, excludedNames: ['skip.md', '.obsidian'] });

    expect(map['keep.md']?.toString()).toBe('k');
    expect(map['skip.md']).toBeUndefined();
  });

  it('should seed an injected plugin binaries from the default source dir', () => {
    writePluginBinaries('fix-require-modules');
    writeFileSync(join(root, '.obsidian', 'plugins', 'fix-require-modules', 'styles.css'), '.a{}');
    // A nested directory inside the plugin folder must be ignored (only direct files are seeded).
    mkdirSync(join(root, '.obsidian', 'plugins', 'fix-require-modules', 'nested'));

    const map = buildDemoVaultPopulate({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'fix-require-modules' }]
    });

    expect(map['.obsidian/plugins/fix-require-modules/main.js']?.toString()).toBe('// fix-require-modules main');
    expect(map['.obsidian/plugins/fix-require-modules/manifest.json']?.toString()).toBe('{"id":"fix-require-modules"}');
    expect(map['.obsidian/plugins/fix-require-modules/styles.css']?.toString()).toBe('.a{}');
    expect(map['.obsidian/plugins/fix-require-modules/nested']).toBeUndefined();
  });

  it('should read an injected plugin from an explicit sourceDirectory', () => {
    const sourceDirectory = writePluginBinaries('cst', join(root, 'external', 'cst'));

    const map = buildDemoVaultPopulate({
      demoVaultPath: root,
      excludedNames: ['.obsidian', '.git', 'external'],

      injectPlugins: [{ pluginId: 'cst', sourceDirectory }]
    });

    expect(map['.obsidian/plugins/cst/main.js']?.toString()).toBe('// cst main');
    expect(map['.obsidian/plugins/cst/manifest.json']).toBeDefined();
  });

  it('should overlay data.json from the data param and skip the on-disk data.json', () => {
    const directory = writePluginBinaries('cst');
    writeFileSync(join(directory, 'data.json'), '{"stale":true}');

    const map = buildDemoVaultPopulate({
      demoVaultPath: root,
      injectPlugins: [{ data: { fresh: true }, pluginId: 'cst' }]
    });

    expect(map['.obsidian/plugins/cst/data.json']).toBe(`${JSON.stringify({ fresh: true }, null, 2)}\n`);
  });

  it('should keep the on-disk data.json when no data param is given', () => {
    const directory = writePluginBinaries('cst');
    writeFileSync(join(directory, 'data.json'), '{"onDisk":true}');

    const map = buildDemoVaultPopulate({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'cst' }]
    });

    expect(map['.obsidian/plugins/cst/data.json']?.toString()).toBe('{"onDisk":true}');
  });

  it('should throw an actionable error when a required plugin binary is missing', () => {
    const directory = join(root, '.obsidian', 'plugins', 'cst');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), '{}');
    // The main.js file is intentionally missing.

    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'cst' }] }))
      .toThrow(/Community plugin "cst" is not installed in the demo vault/);
  });

  it('should throw when manifest.json is missing even though main.js is present', () => {
    const directory = join(root, '.obsidian', 'plugins', 'cst');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'main.js'), '// main');
    // The manifest.json file is intentionally missing.

    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'cst' }] }))
      .toThrow(/manifest\.json missing/);
  });

  it('should throw when the plugin source dir does not exist at all', () => {
    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'ghost' }] }))
      .toThrow(/main\.js missing/);
  });

  it('should name the headless remedies, not a GUI step, in the throw', () => {
    // `.obsidian/plugins/*` is gitignored, so "open it in Obsidian once" is unreachable from a clone or CI.
    // Both headless routes must therefore be named in the message.
    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'ghost' }] }))
      .toThrow(/obsidian-integration-testing bootstrap-demo-vault/);
    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'ghost' }] }))
      .toThrow(/buildDemoVaultPopulateAsync/);
  });

  it('should tell an explicit-sourceDirectory plugin that it is opted out of the bootstrap', () => {
    const sourceDirectory = join(root, 'external', 'cst');
    mkdirSync(sourceDirectory, { recursive: true });

    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'cst', sourceDirectory }] }))
      .toThrow(/opts it out of the headless bootstrap/);
  });
});

describe('resolveMissingInjectedPlugins', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-vault-missing-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  function writePluginBinaries(pluginId: string): void {
    const directory = join(root, '.obsidian', 'plugins', pluginId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'main.js'), `// ${pluginId} main`);
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ id: pluginId }));
  }

  it('should select only the plugins whose binaries are absent', () => {
    writePluginBinaries('installed');

    const missing = resolveMissingInjectedPlugins({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'installed' }, { pluginId: 'absent' }]
    });

    expect(missing.map((plugin) => plugin.pluginId)).toEqual(['absent']);
  });

  it('should select a plugin whose folder exists but is incomplete', () => {
    const directory = join(root, '.obsidian', 'plugins', 'half');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), '{}');

    const missing = resolveMissingInjectedPlugins({ demoVaultPath: root, injectPlugins: [{ pluginId: 'half' }] });

    expect(missing.map((plugin) => plugin.pluginId)).toEqual(['half']);
  });

  it('should never select a plugin that names an explicit sourceDirectory', () => {
    const missing = resolveMissingInjectedPlugins({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'local-build', sourceDirectory: join(root, 'dist') }]
    });

    expect(missing).toEqual([]);
  });

  it('should preserve the given order and carry the repo/version overrides through', () => {
    const missing = resolveMissingInjectedPlugins({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'first', repo: 'owner/first' }, { pluginId: 'second', version: '1.2.3' }]
    });

    expect(missing).toEqual([{ pluginId: 'first', repo: 'owner/first' }, { pluginId: 'second', version: '1.2.3' }]);
  });
});
