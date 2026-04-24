/**
 * @file
 *
 * Vitest module augmentation for `obsidian-integration-testing`.
 *
 * Add `"obsidian-integration-testing/vitest"` to `compilerOptions.types`
 * in your `tsconfig.json` to get intellisense for `environmentOptions.obsidianTransport`
 * and `inject('obsidianTransport')` / `inject('tempVaultPath')`.
 */

import type { ObsidianTransportOptions } from './transport-options.ts';

declare module 'vitest' {
  interface ProvidedContext {
    /**
     * Transport options provided by the global setup, consumed by
     * `evalInObsidian` and other library functions via `inject()`.
     */
    obsidianTransport?: ObsidianTransportOptions;

    /**
     * Path to the temporary vault created by the global setup.
     */
    tempVaultPath: string;
  }
}

declare module 'vitest/node' {
  interface EnvironmentOptions {
    /**
     * Configures the transport used by `obsidian-integration-testing` to
     * communicate with a running Obsidian instance.
     *
     * When omitted, defaults to the CLI transport (`obsidian-cli`).
     */
    obsidianTransport?: ObsidianTransportOptions;
  }
}
