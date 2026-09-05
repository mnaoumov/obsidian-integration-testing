/**
 * @file
 *
 * Regression test for the global-setup → test-worker attach path of the
 * harness-owned desktop CDP instance.
 *
 * Unlike the other harness integration suites (which call `TemporaryVault.register()`
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
import { TemporaryVault } from './temporary-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;

/**
What the T116 routing probe reads back from the window it ran against.
*/
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
      callback({ app }): string {
        return (app.vault.adapter as FileSystemAdapter).getBasePath();
      }
    });

    expect(basePath).toBe(inject('temporaryVaultPath'));
  });

  it('reuses the attached instance across multiple worker evals', async () => {
    const first = await evalInObsidian({
      callback(): number {
        return 1;
      }
    });
    const second = await evalInObsidian({
      callback(): number {
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
  const vault = new TemporaryVault();

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
      callback({ app, pluginId }): VaultProbe {
        return {
          basePath: (app.vault.adapter as FileSystemAdapter).getBasePath(),
          hasFreshManifest: Object.hasOwn(app.plugins.manifests, pluginId),
          vaultName: app.vault.getName()
        };
      },
      input: { pluginId: FRESH_PLUGIN_ID },
      vaultPath: vault.path
    });

    // The eval ran against the FRESH vault's window...
    expect(view.basePath).toBe(vault.path);
    expect(view.hasFreshManifest).toBe(true);
    // ...and the shared setup vault is a genuinely different window.
    expect(view.basePath).not.toBe(inject('temporaryVaultPath'));
  });
});

/**
What a raw `app.setting.open()` -- deliberately NOT the `openSettingsTab` helper -- does to the window
The harness is actually driving.
*/
interface HeadlessDefaultsProbe {
  configuredAlwaysUpdateLinks: unknown;
  configuredSettingsPopoutWindow: unknown;
  isActiveDocumentMain: boolean;
  isContainerAttachedByOpenAlone: boolean;
  isContainerInMainDocument: boolean;
}

/*
 * Every callback below re-derives its own `getConfig` rather than sharing a helper: the callback is
 * Serialized and run in the renderer, so anything it closes over here is simply not there.
 */

describe('headless vault defaults in the global-setup-owned vault', () => {
  it('writes both headless defaults into the vault the global setup provisioned', async () => {
    const config = await evalInObsidian({
      callback({ app }): Record<string, unknown> {
        // `obsidian-typings`' `ConfigItem` union does not list `settingsPopoutWindow`, so the key cannot
        // Be passed as typed. Widening the bound function keeps it to one assertion.
        const getConfig = app.vault.getConfig.bind(app.vault) as (configKey: string) => unknown;
        return {
          alwaysUpdateLinks: getConfig('alwaysUpdateLinks'),
          settingsPopoutWindow: getConfig('settingsPopoutWindow')
        };
      }
    });

    // Obsidian ships `settingsPopoutWindow` as `true`, so `false` here can only have come from the
    // Harness -- reading back the default proves the `app.json` write reached the opened vault, which
    // Is the thing a `configDirectory` override used to break silently.
    expect(config['alwaysUpdateLinks']).toBe(true);
    expect(config['settingsPopoutWindow']).toBe(false);
  });

  it('keeps the settings modal in the driven window, so a screenshot of it is possible at all', async () => {
    const probe = await evalInObsidian({
      callback({ app }): HeadlessDefaultsProbe {
        const setting = app.setting;
        const getConfig = app.vault.getConfig.bind(app.vault) as (configKey: string) => unknown;

        // No helper, no pre-append: this measures `open()` alone, which is what the popout branch
        // Hijacks. With the popout on, `open()` appends `modalEl` into a SECOND Electron window and
        // Reassigns the `activeDocument` global to it, leaving this document with none of the modal.
        setting.open();
        const result = {
          configuredAlwaysUpdateLinks: getConfig('alwaysUpdateLinks'),
          configuredSettingsPopoutWindow: getConfig('settingsPopoutWindow'),
          isActiveDocumentMain: activeDocument === document,
          isContainerAttachedByOpenAlone: document.body.contains(setting.containerEl),
          isContainerInMainDocument: setting.containerEl.ownerDocument === document
        };
        setting.close();
        return result;
      }
    });

    expect(probe.configuredAlwaysUpdateLinks).toBe(true);
    expect(probe.configuredSettingsPopoutWindow).toBe(false);
    // The globals stay this window's, so `captureObsidianScreenshot` photographs the window the modal
    // Is in rather than one it left behind.
    expect(probe.isActiveDocumentMain).toBe(true);
    expect(probe.isContainerInMainDocument).toBe(true);
    // `open()` attaches the container itself once the popout is off -- the fact AGENTS.md L38 got
    // Wrong, and the reason the helper's own append is a fallback rather than the load-bearing step.
    expect(probe.isContainerAttachedByOpenAlone).toBe(true);
  });
});
