/**
 * @file
 *
 * Jest **per-worker** setup file.
 *
 * Jest runs `globalSetup` only in the main process, so the transport-options and
 * vault-path resolvers registered there never exist in the test workers that
 * actually call {@link evalInObsidian}. Add this module to the integration
 * config's `setupFiles` so each worker registers the resolvers and reads the
 * context from `globalThis.__obsidianIntegrationTesting` (the transport options
 * a consumer sets via Jest `globals`, plus the vault path).
 *
 * Note: unlike Vitest's `provide`/`inject`, Jest has no channel from
 * `globalSetup` to worker sandboxes for *dynamically* computed values, so the
 * owned-CDP default's auto-chosen port cannot reach Jest workers — under Jest,
 * attach to a fixed `port` via the transport options in `globals`.
 */
/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import type { ObsidianTransportOptions } from '../transport-options.ts';

import {
  setTransportOptionsResolver,
  setVaultPathResolver
} from '../context-provider.ts';

interface ObsidianIntegrationTestingGlobal {
  tempVaultPath?: string | undefined;
  transportOptions?: ObsidianTransportOptions | undefined;
}

/* eslint-disable vars-on-top -- Required for `declare global` augmentation. */
declare global {
  var __obsidianIntegrationTesting: ObsidianIntegrationTestingGlobal | undefined;
}
/* eslint-enable vars-on-top -- End of `declare global` block. */

setTransportOptionsResolver(() => globalThis.__obsidianIntegrationTesting?.transportOptions);
setVaultPathResolver(() => globalThis.__obsidianIntegrationTesting?.tempVaultPath);

/* v8 ignore stop */
