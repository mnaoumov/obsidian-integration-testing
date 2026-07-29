/**
 * @file
 *
 * Test-runner setup file that publishes the `metadata.json` table as the
 * `OBSIDIAN_METADATA` global, for the runtimes that get no `define`: the Vitest
 * integration projects (`setupFiles`, see `vitest-config.ts`) and every Jest
 * worker (`setupFiles`, see `jest-config.ts`). The Vitest `unit-tests` project
 * inlines the table via `define` instead, so it stays filesystem-free.
 *
 * Framework-neutral by design — both runners load this same file, so the shim
 * exists once (see `helpers/metadata-global.ts` for the mechanism).
 */

import { defineObsidianMetadataGlobal } from './helpers/metadata-global.ts';

defineObsidianMetadataGlobal();
