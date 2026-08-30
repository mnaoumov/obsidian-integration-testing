/**
 * @file
 *
 * Vitest module augmentation for `obsidian-integration-testing`.
 *
 * Automatically included via a side-effect import in the main entry
 * point, so consumers get these augmentations when importing from
 * `obsidian-integration-testing`.
 *
 * Provides IntelliSense for `environmentOptions.obsidianTransport`
 * and `inject('obsidianTransport')` / `inject('temporaryVaultPath')`.
 */

import type { IntegrationSetupFailedErrorConstructorParams } from '../integration-setup-failed-error.ts';
import type { ObsidianTransportOptions } from '../transport-options.ts';

// eslint-disable-next-line import-x/no-unassigned-import -- Forces module resolution so declare module augmentations merge correctly.
import 'vitest';
// eslint-disable-next-line import-x/no-unassigned-import -- Forces module resolution so declare module augmentations merge correctly.
import 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    /**
     * Transport options provided by the global setup, consumed by
     * `evalInObsidian` and other library functions via `inject()`.
     */
    obsidianTransport?: ObsidianTransportOptions;

    /**
     * The global setup's failure, serialized for the workers. Present only when
     * setup failed; the per-worker setup file registers it as the setup-error
     * resolver, and `getOrCreateTransport` throws it rather than let a worker
     * build a transport the project never asked for.
     */
    setupError?: IntegrationSetupFailedErrorConstructorParams;

    /**
     * Path to the temporary vault created by the global setup.
     */
    temporaryVaultPath: string;
  }
}

declare module 'vitest/node' {
  interface EnvironmentOptions {
    /**
     * Configures the transport used by `obsidian-integration-testing` to
     * communicate with a running Obsidian instance.
     *
     * When omitted, defaults to a harness-owned isolated CDP instance (`obsidian-cdp`).
     */
    readonly obsidianTransport?: ObsidianTransportOptions;
  }
}
