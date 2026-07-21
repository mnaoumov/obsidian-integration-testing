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

import { buildDemoVaultPopulate } from './demo-vault-populate.ts';

describe('buildDemoVaultPopulate', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-vault-populate-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  function writePluginBinaries(pluginId: string, sourceDir?: string): string {
    const dir = sourceDir ?? join(root, '.obsidian', 'plugins', pluginId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'main.js'), `// ${pluginId} main`);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: pluginId }));
    return dir;
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

  it('should read an injected plugin from an explicit sourceDir', () => {
    const sourceDir = writePluginBinaries('cst', join(root, 'external', 'cst'));

    const map = buildDemoVaultPopulate({
      demoVaultPath: root,
      excludedNames: ['.obsidian', '.git', 'external'],
      injectPlugins: [{ pluginId: 'cst', sourceDir }]
    });

    expect(map['.obsidian/plugins/cst/main.js']?.toString()).toBe('// cst main');
    expect(map['.obsidian/plugins/cst/manifest.json']).toBeDefined();
  });

  it('should overlay data.json from the data param and skip the on-disk data.json', () => {
    const dir = writePluginBinaries('cst');
    writeFileSync(join(dir, 'data.json'), '{"stale":true}');

    const map = buildDemoVaultPopulate({
      demoVaultPath: root,
      injectPlugins: [{ data: { fresh: true }, pluginId: 'cst' }]
    });

    expect(map['.obsidian/plugins/cst/data.json']).toBe(`${JSON.stringify({ fresh: true }, null, 2)}\n`);
  });

  it('should keep the on-disk data.json when no data param is given', () => {
    const dir = writePluginBinaries('cst');
    writeFileSync(join(dir, 'data.json'), '{"onDisk":true}');

    const map = buildDemoVaultPopulate({
      demoVaultPath: root,
      injectPlugins: [{ pluginId: 'cst' }]
    });

    expect(map['.obsidian/plugins/cst/data.json']?.toString()).toBe('{"onDisk":true}');
  });

  it('should throw an actionable error when a required plugin binary is missing', () => {
    const dir = join(root, '.obsidian', 'plugins', 'cst');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{}');
    // The main.js file is intentionally missing.

    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'cst' }] }))
      .toThrow(/Community plugin "cst" is not installed in the demo vault/);
  });

  it('should throw when manifest.json is missing even though main.js is present', () => {
    const dir = join(root, '.obsidian', 'plugins', 'cst');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'main.js'), '// main');
    // The manifest.json file is intentionally missing.

    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'cst' }] }))
      .toThrow(/manifest\.json missing/);
  });

  it('should throw when the plugin source dir does not exist at all', () => {
    expect(() => buildDemoVaultPopulate({ demoVaultPath: root, injectPlugins: [{ pluginId: 'ghost' }] }))
      .toThrow(/main\.js missing/);
  });
});
