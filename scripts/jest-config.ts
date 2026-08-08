import type { Config } from 'jest';

import { join } from 'node:path';

export const jestConfig: Config = {
  extensionsToTreatAsEsm: ['.ts'],
  // eslint-disable-next-line unicorn/name-replacements -- `rootDir` is Jest's own config option name.
  rootDir: join(import.meta.dirname, '..'),
  // The harness chain reads the `OBSIDIAN_METADATA` global at module scope, and
  // Jest has no `define` to inline it — publish it per worker from the same
  // Setup file the Vitest integration projects use (L6, L20).
  setupFiles: [join(import.meta.dirname, 'metadata-global-setup.ts')],
  testMatch: ['**/jest/*.jest.test.ts'],
  transform: {
    // `ts-jest` resolves a relative `tsconfig` against the cwd, not `rootDir` —
    // Pass it absolute so the config works from any working directory.
    '^.+\\.ts$': ['ts-jest', { tsconfig: join(import.meta.dirname, '..', 'tsconfig.json'), useESM: true }]
  }
};
