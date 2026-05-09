/**
 * @file
 *
 * Library metadata constants. The `OBSIDIAN_INTEGRATION_TESTING_VERSION` global
 * is replaced at build time by esbuild's `define` option with the version
 * from `package.json`.
 */

/**
 * The version of the `obsidian-integration-testing` library.
 * At build time, `OBSIDIAN_INTEGRATION_TESTING_VERSION` is replaced by esbuild's
 * `define` option. At test time (Vitest), it falls back to `'dev'`.
 */
/* v8 ignore start -- Build-time constant; the else branch is only reachable when esbuild's define replaces the global. */
export const LIBRARY_VERSION: string = typeof OBSIDIAN_INTEGRATION_TESTING_VERSION === 'undefined'
  ? 'dev'
  : OBSIDIAN_INTEGRATION_TESTING_VERSION;
/* v8 ignore stop */

declare const OBSIDIAN_INTEGRATION_TESTING_VERSION: string | undefined;
