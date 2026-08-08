import {
  copyFileSync,
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
  join,
  relative
} from 'node:path';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import { execFromRoot } from './helpers/root.ts';

exitIfScriptDisabled();

const SRC_DIR = 'src';
const ESM_DIR = 'dist/lib/esm';
const CJS_DIR = 'dist/lib/cjs';

function collectFiles(directory: string, extension: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      result.push(...collectFiles(full, extension));
    } else if (full.endsWith(extension)) {
      result.push(full);
    }
  }
  return result;
}

function copySourceDeclarationFiles(): void {
  const dtsSourceFiles = collectFiles(SRC_DIR, '.d.ts');
  for (const srcFile of dtsSourceFiles) {
    const relativePath = relative(SRC_DIR, srcFile);
    const destinationPath = join(ESM_DIR, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(srcFile, destinationPath);
  }
}

async function main(): Promise<void> {
  await execFromRoot('tsc --project tsconfig.build.json');
  copySourceDeclarationFiles();

  const dtsFiles = collectFiles(ESM_DIR, '.d.ts');

  for (const filePath of dtsFiles) {
    const normalized = toForwardSlash(filePath);
    const content = await readFile(filePath, 'utf-8');

    // Write .d.mts with .mjs import extensions (TypeScript resolves .mjs → .d.mts automatically,
    // Avoiding TS2846 "declaration file imported without import type" errors).
    const esmPath = normalized.replace(/\.d\.ts$/, '.d.mts');
    await writeFile(esmPath, rewriteImportExtensions(content, '.mjs'), 'utf-8');

    // Write .d.cts with .cjs import extensions (TypeScript resolves .cjs → .d.cts automatically).
    const cjsPath = normalized.replace(ESM_DIR, () => CJS_DIR).replace(/\.d\.ts$/, '.d.cts');
    mkdirSync(dirname(cjsPath), { recursive: true });
    await writeFile(cjsPath, rewriteImportExtensions(content, '.cjs'), 'utf-8');

    unlinkSync(filePath);
  }
}

function rewriteImportExtensions(content: string, targetExtension: string): string {
  return content.replaceAll(
    /(?<prefix>(?:from|import)\s+['"])(?<path>[^'"]*?)\.ts(?<quote>['"])/g,
    (_match: string, prefix: number | string, path: number | string, quote: number | string) => `${String(prefix)}${String(path)}${targetExtension}${String(quote)}`
  );
}

function toForwardSlash(p: string): string {
  return p.replaceAll('\\', '/');
}

await main();
