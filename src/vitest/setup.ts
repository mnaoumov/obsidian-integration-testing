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
 *
 * The setup-error resolver is the same channel used in reverse: when the global setup
 * FAILED it publishes nothing but the failure, and this registration is what lets
 * `getOrCreateTransport` throw it instead of quietly building that same un-prepared
 * desktop transport in a project configured for another platform.
 */
/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import { inject } from 'vitest';

import {
  setSetupErrorResolver,
  setTransportOptionsResolver,
  setVaultPathResolver
} from '../context-provider.ts';

setSetupErrorResolver(() => inject('setupError'));
setTransportOptionsResolver(() => inject('obsidianTransport'));
setVaultPathResolver(() => inject('temporaryVaultPath'));

/* v8 ignore stop */
