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
  afterAll,
  beforeAll,
  describe,
  expect,
  inject,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { TempVault } from './temp-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60000;

/** What the T116 routing probe reads back from the window it ran against. */
interface VaultProbe {
  basePath: string;
  hasFreshManifest: boolean;
  vaultName: string;
}

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

/*
 * T116 regression: with the global-setup-owned SHARED vault already open, a
 * SECOND vault registered in-worker (attach mode) must route its own evals to its
 * OWN window. Before the fix, `openVaultInRunningInstance` bootstrapped the helper
 * namespace against the not-yet-open fresh vault, poisoning the connection cache
 * so every `evalInObsidian({ vaultPath: fresh })` mis-routed to the shared window
 * (the closure saw the shared vault's name and none of the fresh vault's plugins).
 */
describe('second registered vault routes to its own window', () => {
  const FRESH_PLUGIN_ID = 'second-vault-fixture';
  const vault = new TempVault();

  beforeAll(async () => {
    vault.populate({
      '.obsidian/community-plugins.json': JSON.stringify([]),
      [`.obsidian/plugins/${FRESH_PLUGIN_ID}/main.js`]: 'const { Plugin } = require(\'obsidian\'); class P extends Plugin { onload() {} } module.exports = P; exports.default = P;',
      [`.obsidian/plugins/${FRESH_PLUGIN_ID}/manifest.json`]: JSON.stringify({
        author: 'test',
        description: 'test',
        id: FRESH_PLUGIN_ID,
        isDesktopOnly: false,
        minAppVersion: '1.0.0',
        name: FRESH_PLUGIN_ID,
        version: '1.0.0'
      })
    });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  it('evals against the freshly-registered vault, not the shared setup vault', async () => {
    const view = await evalInObsidian({
      args: { pluginId: FRESH_PLUGIN_ID },
      fn({ app, pluginId }): VaultProbe {
        return {
          basePath: (app.vault.adapter as FileSystemAdapter).getBasePath(),
          hasFreshManifest: Boolean(app.plugins.manifests[pluginId]),
          vaultName: app.vault.getName()
        };
      },
      vaultPath: vault.path
    });

    // The eval ran against the FRESH vault's window...
    expect(view.basePath).toBe(vault.path);
    expect(view.hasFreshManifest).toBe(true);
    // ...and the shared setup vault is a genuinely different window.
    expect(view.basePath).not.toBe(inject('tempVaultPath'));
  });
});
