import type { Plugin } from 'esbuild';

import { build } from 'esbuild';
import {
  readdirSync,
  readFileSync,
  statSync
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import { readMetadataJsonText } from './helpers/metadata-global.ts';

exitIfScriptDisabled();

interface PackageJson {
  version: string;
}

const packageVersion = (JSON.parse(readFileSync('package.json', 'utf-8')) as PackageJson).version;

// The whole per-version compatibility table, injected as a value so the built
// Library is self-contained (inlined into the output, no runtime file read). The
// Raw JSON text is a valid expression, so esbuild substitutes it as an object
// Literal — matching how OBSIDIAN_INTEGRATION_TESTING_VERSION is injected.
const obsidianMetadataJson = readMetadataJsonText();

function getEntryPoints(directory: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      entries.push(...getEntryPoints(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      entries.push(full);
    }
  }
  return entries;
}

async function main(): Promise<void> {
  const entryPoints = getEntryPoints('src');

  const commonOptions = {
    bundle: false,
    define: {
      OBSIDIAN_INTEGRATION_TESTING_VERSION: JSON.stringify(packageVersion),
      OBSIDIAN_METADATA: obsidianMetadataJson
    },
    entryPoints,
    platform: 'node' as const,
    sourcemap: 'inline' as const,
    target: 'es2024'
  };

  await Promise.all([
    build({
      ...commonOptions,
      format: 'esm',
      outdir: 'dist/lib/esm',
      outExtension: { '.js': '.mjs' },
      plugins: [rewriteExtensionsPlugin('.mjs')]
    }),
    build({
      ...commonOptions,
      format: 'cjs',
      outdir: 'dist/lib/cjs',
      outExtension: { '.js': '.cjs' },
      plugins: [rewriteExtensionsPlugin('.cjs')]
    })
  ]);
}

function rewriteExtensionsPlugin(extension: string): Plugin {
  return {
    name: 'rewrite-ts-extensions',
    setup(pluginBuild): void {
      pluginBuild.onLoad({ filter: /\.ts$/ }, async (onLoadArguments) => {
        const contents = await readFile(onLoadArguments.path, 'utf-8');
        return {
          contents: contents.replaceAll(
            /(?<prefix>(?:from|import)\s+['"])(?<path>[^'"]*?)\.ts(?<quote>['"])/g,
            (_match: string, prefix: number | string, path: number | string, quote: number | string) => `${String(prefix)}${String(path)}${extension}${String(quote)}`
          ),
          loader: 'ts'
        };
      });
    }
  };
}

await main();
