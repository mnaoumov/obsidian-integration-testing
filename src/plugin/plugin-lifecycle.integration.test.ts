import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { GenericObject } from '../eval/eval-in-obsidian.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import {
  detectPluginUnloadLeak,
  reloadPlugin
} from './plugin-lifecycle.ts';

interface PluginIdInput extends GenericObject {
  readonly pluginId: string;
}

/**
 * What the probe plugin saw in its last `onload`, published on a `window` property (a plain object, so the record
 * itself keeps no plugin instance alive).
 */
interface ProbeRecord extends GenericObject {
  readonly data: unknown;
  readonly isDataUndefined: boolean;
  readonly isLayoutReady: boolean;
}

const PROBE_PLUGIN_ID = 'oit-lifecycle-probe';
const STRICT_PLUGIN_ID = 'oit-lifecycle-strict';
const CLEAN_PLUGIN_ID = 'oit-leak-clean';
const LEAKY_PLUGIN_ID = 'oit-leak-leaky';
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;

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

const temporaryVault = new TemporaryVault();
let vaultPath: string;

async function readProbe(): Promise<null | ProbeRecord> {
  return await evalInObsidian<Record<string, never>, null | ProbeRecord>({
    callback(): null | ProbeRecord {
      return (Reflect.get(globalThis, '__oitLifecycleProbe') as ProbeRecord | undefined) ?? null;
    },
    vaultPath
  });
}

beforeAll(async () => {
  temporaryVault.populate({
    ...pluginFiles(
      PROBE_PLUGIN_ID,
      `  async onload() {
    const data = await this.loadData();
    window.__oitLifecycleProbe = { data: data === undefined ? null : data, isDataUndefined: data === undefined, isLayoutReady: this.app.workspace.layoutReady };
  }`
    ),
    ...pluginFiles(
      STRICT_PLUGIN_ID,
      `  async onload() {
    this.answer = (await this.loadData()).answer;
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
  await temporaryVault.register();
  vaultPath = temporaryVault.path;
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

describe('reloadPlugin', () => {
  it('should enable a plugin after the layout is ready, the way settings does', async () => {
    const result = await reloadPlugin({ pluginId: PROBE_PLUGIN_ID, vaultPath });

    expect(result).toStrictEqual({ errorMessage: undefined, isLoaded: true });
    const probe = await readProbe();
    expect(probe?.isLayoutReady).toBe(true);
  });

  it('should write a data.json the plugin then loads', async () => {
    await reloadPlugin({ dataJsonText: JSON.stringify({ answer: 42 }), pluginId: PROBE_PLUGIN_ID, vaultPath });

    const probe = await readProbe();
    expect(probe?.data).toStrictEqual({ answer: 42 });
  });

  it('should remove data.json, so the plugin loads as on a fresh install', async () => {
    await reloadPlugin({ dataJsonText: JSON.stringify({ answer: 42 }), pluginId: PROBE_PLUGIN_ID, vaultPath });
    const result = await reloadPlugin({ pluginId: PROBE_PLUGIN_ID, shouldRemoveDataJson: true, vaultPath });

    expect(result.isLoaded).toBe(true);
    expect(await readProbe()).toMatchObject({ data: null, isDataUndefined: false });
  });

  it('should hand a corrupt data.json to the plugin, and report a plugin that fails on it', async () => {
    const tolerant = await reloadPlugin({ dataJsonText: '{ not json', pluginId: PROBE_PLUGIN_ID, vaultPath });
    const probe = await readProbe();

    // Obsidian's `readJson` logs the parse error and resolves `undefined`, where a missing file resolves `null`.
    expect(tolerant.isLoaded).toBe(true);
    expect(probe).toMatchObject({ isDataUndefined: true });

    const strict = await reloadPlugin({ dataJsonText: '{ not json', pluginId: STRICT_PLUGIN_ID, vaultPath });

    // Obsidian stores the instance before it calls load(), so a throwing onload still leaves one: the error is the signal.
    expect(strict.errorMessage).toContain('Cannot read properties of undefined (reading \'answer\')');
    expect(strict.isLoaded).toBe(true);
  });

  it('should refuse both a data.json text and its removal', async () => {
    await expect(reloadPlugin({ dataJsonText: '{}', pluginId: PROBE_PLUGIN_ID, shouldRemoveDataJson: true, vaultPath }))
      .rejects.toThrow('not both');
  });

  it('should refuse a plugin with no manifest in the vault', async () => {
    await expect(reloadPlugin({ pluginId: 'oit-no-such-plugin', vaultPath })).rejects.toThrow('has no manifest');
  });
});

describe('detectPluginUnloadLeak', () => {
  it('should find no leak in a plugin that cleans up after itself, and enable it again', async () => {
    await reloadPlugin({ pluginId: CLEAN_PLUGIN_ID, vaultPath });
    const result = await detectPluginUnloadLeak({ pluginId: CLEAN_PLUGIN_ID, vaultPath });

    expect(result.isLeaked).toBe(false);
    const isLoaded = await evalInObsidian<PluginIdInput, boolean>({
      callback({ app, pluginId }): boolean {
        return app.plugins.plugins[pluginId] !== undefined;
      },
      input: { pluginId: CLEAN_PLUGIN_ID },
      vaultPath
    });
    expect(isLoaded).toBe(true);
  });

  it('should find a leak in a plugin that leaves a listener behind', async () => {
    await reloadPlugin({ pluginId: LEAKY_PLUGIN_ID, vaultPath });
    const result = await detectPluginUnloadLeak({ pluginId: LEAKY_PLUGIN_ID, shouldReenable: false, vaultPath });

    expect(result).toStrictEqual({ collectionCount: 3, isLeaked: true });
  });

  it('should refuse a plugin that is not loaded', async () => {
    await expect(detectPluginUnloadLeak({ pluginId: LEAKY_PLUGIN_ID, vaultPath })).rejects.toThrow('is not loaded');
  });
});
