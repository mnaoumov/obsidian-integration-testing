/**
 * @file
 *
 * Vitest **per-worker** setup file.
 *
 * Vitest runs `globalSetup` only in the main process, so the transport-options
 * and vault-path resolvers registered there never exist in the test workers that
 * actually call {@link evalInObsidian}. Add this module to the integration
 * project's `setupFiles` so each worker registers the resolvers and reads the
 * context the global setup published via `provide` (e.g. the owned instance's
 * CDP `port`). Without it, a worker falls back to launching its own un-prepared
 * transport — which, for the owned-CDP default, has no CDP endpoint.
 */
/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import { inject } from 'vitest';

import {
  setTransportOptionsResolver,
  setVaultPathResolver
} from '../context-provider.ts';

setTransportOptionsResolver(() => inject('obsidianTransport'));
setVaultPathResolver(() => inject('tempVaultPath'));

/* v8 ignore stop */
