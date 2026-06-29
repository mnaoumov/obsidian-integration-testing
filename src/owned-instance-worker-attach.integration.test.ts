/**
 * @file
 *
 * Regression test for the global-setup → test-worker attach path of the
 * harness-owned desktop CDP instance.
 *
 * Unlike the other harness integration suites (which call `TempVault.register()`
 * in-worker and thus own the instance inside the worker), this suite owns the
 * instance in the **global setup** process and evals from the **worker**. The
 * worker must therefore:
 *
 * 1. read the transport options the global setup published via `provide`
 *    (registered by the `vitest-setup` resolver in `setupFiles`), and
 * 2. **attach** to the owned instance on the injected CDP `port` — rather than
 *    rebuilding an owned transport that never launches.
 *
 * Before the fix, the worker got no port (owned-CDP options were not augmented)
 * and no resolver (registered only in the main process), so the first eval threw
 * `Failed to parse URL from /json`. These cases pass `neither` a `transport` nor
 * a `vaultPath`, so they exercise both worker resolvers end-to-end.
 */

import type { FileSystemAdapter } from 'obsidian';

import {
  describe,
  expect,
  inject,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';

describe('owned instance worker attach', () => {
  it('evals from a worker by attaching to the global-setup-owned instance', async () => {
    // No `transport` and no `vaultPath`: the worker resolves both from the
    // Context the global setup published (transport options incl. the owned CDP
    // Port, and the temp vault path).
    const basePath = await evalInObsidian({
      fn({ app }): string {
        return (app.vault.adapter as FileSystemAdapter).getBasePath();
      }
    });

    expect(basePath).toBe(inject('tempVaultPath'));
  });

  it('reuses the attached instance across multiple worker evals', async () => {
    const first = await evalInObsidian({
      fn(): number {
        return 1;
      }
    });
    const second = await evalInObsidian({
      fn(): number {
        return 2;
      }
    });

    expect(first).toBe(1);
    expect(second).toBe(2);
  });
});
