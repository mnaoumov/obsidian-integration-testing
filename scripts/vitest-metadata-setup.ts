import { readFileSync } from 'node:fs';

// The integration-test projects (unlike the unit-test project) do not get the
// Vitest `define` that inlines the per-version compatibility table into
// `obsidian-metadata.ts`, so publish it as a global here — read from the repo-root
// `metadata.json` — and the module's `OBSIDIAN_METADATA` reference resolves to it.
// The esbuild build injects the same table via `define`; this only covers the
// Integration-test runtime (the unit-test project stays filesystem-free).
Object.defineProperty(globalThis, 'OBSIDIAN_METADATA', {
  configurable: true,
  value: JSON.parse(readFileSync('metadata.json', 'utf-8'))
});
