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

import { readDemoVaultTree } from './demo-vault-tree.ts';

describe('readDemoVaultTree', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'demo-vault-tree-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('should read files recursively into a vault-relative POSIX populate map', () => {
    writeFileSync(join(root, 'note.md'), 'top');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'child.md'), 'nested');

    const map = readDemoVaultTree({ demoVaultPath: root });

    expect(Object.keys(map).sort()).toEqual(['note.md', 'sub/child.md']);
    expect(map['note.md']?.toString()).toBe('top');
    expect(map['sub/child.md']?.toString()).toBe('nested');
  });

  it('should skip the default excluded names (.git and .obsidian)', () => {
    writeFileSync(join(root, 'note.md'), 'x');
    mkdirSync(join(root, '.obsidian'));
    writeFileSync(join(root, '.obsidian', 'app.json'), '{}');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '');

    const map = readDemoVaultTree({ demoVaultPath: root });

    expect(Object.keys(map)).toEqual(['note.md']);
  });

  it('should skip custom excluded names', () => {
    writeFileSync(join(root, 'keep.md'), 'k');
    writeFileSync(join(root, 'skip.md'), 's');

    const map = readDemoVaultTree({ demoVaultPath: root, excludedNames: ['skip.md'] });

    expect(Object.keys(map)).toEqual(['keep.md']);
  });
});
