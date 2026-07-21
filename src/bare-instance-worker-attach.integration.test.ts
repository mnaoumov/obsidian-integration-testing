/**
 * @file
 *
 * Regression test for the **plugin-less** global-setup → test-worker attach path
 * of the harness-owned desktop CDP instance.
 *
 * The global setup (`bare-attach-regression-global-setup.ts`) runs
 * `createSetup({ installPlugin: false })`: it owns the instance and registers an
 * **empty** vault (no plugin copied or enabled), then publishes the owned CDP
 * endpoint to workers via `provide`. Like the plugin variant
 * (`owned-instance-worker-attach.integration.test.ts`), this suite evals from a
 * worker WITHOUT registering a vault in-worker, so it passes only if the worker
 * reads the provided options (through the `vitest-setup` resolvers) and
 * **attaches** to the owned instance rather than rebuilding an owned transport
 * that never launches (which threw `Failed to parse URL from /json`).
 *
 * It additionally asserts the plugin-less contract: the registered vault has no
 * enabled community plugins.
 */

import type { FileSystemAdapter } from 'obsidian';

import {
  describe,
  expect,
  inject,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';

describe('bare (plugin-less) instance worker attach', () => {
  it('evals from a worker by attaching to the global-setup-owned instance', async () => {
    // No `transport` and no `vaultPath`: the worker resolves both from the
    // Context the plugin-less global setup published (transport options incl. the
    // Owned CDP port, and the temp vault path).
    const basePath = await evalInObsidian({
      fn({ app }): string {
        return (app.vault.adapter as FileSystemAdapter).getBasePath();
      }
    });

    expect(basePath).toBe(inject('tempVaultPath'));
  });

  it('registers an empty vault with no enabled community plugins', async () => {
    const enabledPluginCount = await evalInObsidian({
      fn({ app }): number {
        return app.plugins.enabledPlugins.size;
      }
    });

    expect(enabledPluginCount).toBe(0);
  });
});
