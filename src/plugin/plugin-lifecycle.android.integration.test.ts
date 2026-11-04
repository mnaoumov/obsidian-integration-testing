/**
 * @file
 *
 * The Android leg of the plugin-lifecycle helpers (**L85**). `detectPluginUnloadLeak` asks the transport for a
 * garbage collection, and on Android that is `AppiumTransport.collectGarbage`: CDP `HeapProfiler.collectGarbage` on
 * the WebView debugger connection the trusted-input channel opens (**L39**). The desktop suite
 * (`plugin-lifecycle.integration.test.ts`) never reaches that path, so this one asserts both directions of the leak
 * check on a device, plus one `reloadPlugin` `data.json` case, which writes through the vault adapter the
 * write-loss guard wraps (**L74**).
 *
 * Both directions matter: a collection that silently did nothing would pass the leaky case and fail the clean one,
 * and one that collected too eagerly could not tell the two apart.
 *
 * Runs in its own Vitest project (`integration-tests:android`) against a real emulator via Appium.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import {
  detectPluginUnloadLeak,
  reloadPlugin
} from './plugin-lifecycle.ts';

const PROBE_PLUGIN_ID = 'oit-lifecycle-probe';
const CLEAN_PLUGIN_ID = 'oit-leak-clean';
const LEAKY_PLUGIN_ID = 'oit-leak-leaky';

/*
 * The same budget the other Android suites carry: emulator boot, the Appium session and the network-ready gate
 * (L45) all land in the first registration.
 */
// Raised by 300s more when a one-core emulator boot got a 600s budget (L19).
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 840_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

function pluginFiles(id: string, body: string): Record<string, string> {
  return {
    [`.obsidian/plugins/${id}/main.js`]: `const { Plugin } = require('obsidian');\nclass P extends Plugin {\n${body}\n}\nmodule.exports = P; exports.default = P;\n`,
    [`.obsidian/plugins/${id}/manifest.json`]: JSON.stringify({
      author: 'obsidian-integration-testing',
      description: `Dummy plugin ${id} for the plugin-lifecycle helpers.`,
      id,
      isDesktopOnly: false,
      minAppVersion: '1.0.0',
      name: id,
      version: '1.0.0'
    })
  };
}

describe('plugin lifecycle on Android', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    vault.populate({
      ...pluginFiles(
        PROBE_PLUGIN_ID,
        `  async onload() {
    const data = await this.loadData();
    window.__oitLifecycleProbe = { data: data === undefined ? null : data, isDataUndefined: data === undefined };
  }`
      ),
      ...pluginFiles(
        CLEAN_PLUGIN_ID,
        `  onload() {
    this.registerEvent(this.app.workspace.on('file-open', () => this.toString()));
    this.registerInterval(window.setInterval(() => this.toString(), 60000));
  }`
      ),
      ...pluginFiles(
        LEAKY_PLUGIN_ID,
        `  onload() {
    this.app.workspace.on('file-open', () => this.toString());
  }`
      )
    });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  // Guard: without a registered Android transport the harness falls back to desktop, where this file would pass
  // without ever reaching the WebView collection it exists for.
  it('should actually be running on mobile', async () => {
    const isMobile = await evalInObsidian({
      callback({ obsidianModule }): boolean {
        return obsidianModule.Platform.isMobile;
      },
      vaultPath: vault.path
    });

    expect(isMobile).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should write a data.json the plugin then loads', async () => {
    const result = await reloadPlugin({ dataJsonText: JSON.stringify({ answer: 42 }), pluginId: PROBE_PLUGIN_ID, vaultPath: vault.path });

    expect(result).toStrictEqual({ errorMessage: undefined, isLoaded: true });
    const probe = await evalInObsidian({
      callback(): unknown {
        return Reflect.get(globalThis, '__oitLifecycleProbe');
      },
      vaultPath: vault.path
    });
    expect(probe).toStrictEqual({ data: { answer: 42 }, isDataUndefined: false });
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should find no leak in a plugin that cleans up after itself', async () => {
    await reloadPlugin({ pluginId: CLEAN_PLUGIN_ID, vaultPath: vault.path });
    const result = await detectPluginUnloadLeak({ pluginId: CLEAN_PLUGIN_ID, vaultPath: vault.path });

    expect(result.isLeaked).toBe(false);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should find a leak in a plugin that leaves a listener behind', async () => {
    await reloadPlugin({ pluginId: LEAKY_PLUGIN_ID, vaultPath: vault.path });
    const result = await detectPluginUnloadLeak({ pluginId: LEAKY_PLUGIN_ID, shouldReenable: false, vaultPath: vault.path });

    expect(result).toStrictEqual({ collectionCount: 3, isLeaked: true });
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
