/**
 * @file
 *
 * The single place that knows where the repo-root `metadata.json` lives and how
 * its table reaches `src/obsidian-metadata.ts` (the sole reader, see L20/L21),
 * which resolves the whole table from a bare `OBSIDIAN_METADATA` global.
 *
 * Two mechanisms supply that global, and both source the table from here:
 *
 * - **`define`** — esbuild (`build-lib.ts`) and the Vitest `unit-tests` project
 *   (`vitest-config.ts`) substitute the raw JSON *text* as a literal expression,
 *   so the table is inlined and the built library stays self-contained (no
 *   runtime file read). Those callers want {@link readMetadataJsonText}.
 * - **A real global** — runtimes with no `define` (the Vitest main process, the
 *   Vitest integration workers and the Jest workers via
 *   `scripts/metadata-global-setup.ts`, and the jiti-run
 *   `collect-runtime-versions.ts`) publish the parsed table on `globalThis` with
 *   {@link defineObsidianMetadataGlobal}.
 *
 * The path is resolved from `import.meta.dirname`, not the cwd, so a shim loaded
 * from a test runner's own working directory still finds the table.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
Absolute path to the repo-root `metadata.json` catalog.
*/
export const METADATA_JSON_PATH = join(import.meta.dirname, '..', '..', 'metadata.json');

/**
 * Publishes the parsed catalog as the `OBSIDIAN_METADATA` global, for runtimes
 * that cannot inline it through a `define`.
 *
 * `configurable` so a later caller (a setup file re-running per worker, say) can
 * redefine it rather than throwing.
 */
export function defineObsidianMetadataGlobal(): void {
  Object.defineProperty(globalThis, 'OBSIDIAN_METADATA', {
    configurable: true,
    value: JSON.parse(readMetadataJsonText())
  });
}

/**
 * Reads the catalog as raw JSON text — a valid expression, which is what a
 * `define` substitutes verbatim.
 *
 * @returns The contents of `metadata.json`.
 */
export function readMetadataJsonText(): string {
  return readFileSync(METADATA_JSON_PATH, 'utf-8');
}
