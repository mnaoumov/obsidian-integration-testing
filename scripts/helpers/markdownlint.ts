import { glob } from 'node:fs/promises';
import { relative } from 'node:path';
import process from 'node:process';

import {
  execFromRoot,
  toPosixPath
} from './root.ts';

interface LintParams {
  readonly paths?: string[] | undefined;
  readonly shouldFix?: boolean | undefined;
}

export async function lint(params?: LintParams): Promise<void> {
  const { paths, shouldFix = false } = params ?? {};
  const targets = paths?.length ? paths : ['.'];
  await execFromRoot(['npx', 'markdownlint-cli2', ...(shouldFix ? ['--fix'] : []), { batchedArguments: targets }]);

  const mdFiles = paths?.length
    ? paths.map((p) => toPosixPath(relative(process.cwd(), p)) || p)
    : await toArray(glob(['**/*.md'], {
      exclude: [
        '.git/**',
        // The docs site's pages link by SITE path (`/obsidian-integration-testing/guides/…`), which only
        // Resolves once Astro has built them; `scripts/docs-link-check.ts` validates those against the
        // Built output instead. Checking them as filesystem-relative paths here would 404 every one.
        'docs/**',
        'dist/**',
        'node_modules/**'
      ]
    }));
  await execFromRoot([
    'npx',
    'linkinator',
    '--retry',
    '--retry-errors',
    '--retry-errors-count',
    '3',
    '--retry-errors-jitter',
    '5',
    '--url-rewrite-search',
    String.raw`https://www\.npmjs\.com/package/`,
    '--url-rewrite-replace',
    'https://registry.npmjs.org/',
    { batchedArguments: mdFiles }
  ]);
}

async function toArray<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const array: T[] = [];
  for await (const item of iter) {
    array.push(item);
  }
  return array;
}
