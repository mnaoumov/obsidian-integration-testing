import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'node:fs';
import {
  readFile,
  writeFile
} from 'node:fs/promises';
import {
  dirname,
  join
} from 'node:path';

import { execFromRoot } from './helpers/root.ts';

interface AugmentationTarget {
  indexPath: string;
  refPath: string;
}

const ESM_DIR = 'dist/lib/esm';
const CJS_DIR = 'dist/lib/cjs';

function collectFiles(dir: string, ext: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...collectFiles(full, ext));
    } else if (full.endsWith(ext)) {
      result.push(full);
    }
  }
  return result;
}

/**
 * Injects `/// <reference path="..." />` directives into the index declaration
 * files so that consumers who `import` this package also pick up the ambient
 * `declare module 'vitest'` augmentation from transport-options.
 *
 * TypeScript strips `/// <reference path>` during declaration emit, and
 * `export type` re-exports don't cause TypeScript to process the source
 * module's ambient augmentations. This post-build injection bridges the gap.
 */
async function injectAugmentationReferences(): Promise<void> {
  const targets: AugmentationTarget[] = [
    { indexPath: `${ESM_DIR}/index.d.mts`, refPath: './transport-options.d.mts' },
    { indexPath: `${CJS_DIR}/index.d.cts`, refPath: './transport-options.d.cts' }
  ];

  for (const { indexPath, refPath } of targets) {
    const content = await readFile(indexPath, 'utf8');
    const directive = `/// <reference path="${refPath}" />\n`;
    if (!content.includes(directive.trim())) {
      await writeFile(indexPath, directive + content, 'utf8');
    }
  }
}

async function main(): Promise<void> {
  await execFromRoot('tsc --project tsconfig.build.json');

  const dtsFiles = collectFiles(ESM_DIR, '.d.ts');

  for (const filePath of dtsFiles) {
    const normalized = toForwardSlash(filePath);
    const content = await readFile(filePath, 'utf8');

    // Write .d.mts with .mjs import extensions (TypeScript resolves .mjs → .d.mts automatically,
    // Avoiding TS2846 "declaration file imported without import type" errors).
    const esmPath = normalized.replace(/\.d\.ts$/, '.d.mts');
    await writeFile(esmPath, rewriteImportExtensions(content, '.mjs'), 'utf8');

    // Write .d.cts with .cjs import extensions (TypeScript resolves .cjs → .d.cts automatically).
    const cjsPath = normalized.replace(ESM_DIR, CJS_DIR).replace(/\.d\.ts$/, '.d.cts');
    mkdirSync(dirname(cjsPath), { recursive: true });
    await writeFile(cjsPath, rewriteImportExtensions(content, '.cjs'), 'utf8');

    unlinkSync(filePath);
  }

  await injectAugmentationReferences();
}

function rewriteImportExtensions(content: string, targetExt: string): string {
  return content.replace(
    /(?<prefix>from\s+['"])(?<path>[^'"]*?)\.ts(?<quote>['"])/g,
    `$<prefix>$<path>${targetExt}$<quote>`
  );
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

await main();
