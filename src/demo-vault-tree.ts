/**
 * @file
 *
 * Reads a plugin's in-repo `demo-vault/` tree into a populate map so a Vitest/Jest global setup can
 * seed it into the temp vault BEFORE Obsidian opens it. Seeding pre-launch lets Obsidian's startup scan
 * index every note in one pass, avoiding the file-watcher race that silently drops events under a bulk
 * post-launch {@link TempVault.populate}.
 */

import {
  readdirSync,
  readFileSync
} from 'node:fs';
import {
  join,
  relative,
  sep
} from 'node:path';

import type { PopulateFilesParams } from './temp-vault.ts';

/**
 * Parameters for {@link readDemoVaultTree}.
 */
export interface ReadDemoVaultTreeParams {
  /**
   * Absolute path to the demo vault directory to read.
   */
  readonly demoVaultPath: string;

  /**
   * Names (of files or directories, matched at any depth) to skip. Defaults to `.git` and `.obsidian`:
   * the harness provisions `.obsidian/plugins/<id>` itself, so the vault's own `.obsidian` must not be
   * copied over it.
   *
   * @default `['.git', '.obsidian']`
   */
  readonly excludedNames?: Iterable<string>;
}

const DEFAULT_EXCLUDED_NAMES = ['.git', '.obsidian'];

/**
 * Reads a demo vault directory tree recursively into a {@link PopulateFilesParams} map (vault-relative
 * POSIX path to file bytes), skipping {@link ReadDemoVaultTreeParams.excludedNames}.
 *
 * @param params - The {@link ReadDemoVaultTreeParams}.
 * @returns The populate map, ready to hand to {@link TempVault.populate} or a global setup's `populate`.
 */
export function readDemoVaultTree(params: ReadDemoVaultTreeParams): PopulateFilesParams {
  const { demoVaultPath } = params;
  const excludedNames = new Set(params.excludedNames ?? DEFAULT_EXCLUDED_NAMES);
  const map: PopulateFilesParams = {};
  collect(demoVaultPath, demoVaultPath, excludedNames, map);
  return map;
}

function collect(root: string, dir: string, excludedNames: Set<string>, map: PopulateFilesParams): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) {
      continue;
    }

    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(root, absolutePath, excludedNames, map);
      continue;
    }

    const relativePath = relative(root, absolutePath).split(sep).join('/');
    map[relativePath] = readFileSync(absolutePath);
  }
}
