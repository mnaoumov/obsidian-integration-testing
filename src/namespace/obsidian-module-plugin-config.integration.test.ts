import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { CdpConnection } from '../desktop/connect-to-cdp.ts';

import { connectToCdp } from '../desktop/connect-to-cdp.ts';
import { getFunctionExpressionString } from '../eval/function-expression.ts';

const LAUNCH_TIMEOUT_IN_MILLISECONDS = 120_000;
const PROBE_TIMEOUT_IN_MILLISECONDS = 30_000;

/**
 * What resolving the `obsidian` module did to the vault's plugin configuration, sampled inside Obsidian.
 */
interface PluginConfigProbe {
  /**
  `community-plugins.json` as it reads on disk after the save debounce has expired.
  */
  readonly communityPluginsOnDisk: string;

  /**
  Whether both concurrent calls resolved the same module object.
  */
  readonly isSameModule: boolean;

  /**
  Temporary plugin folders left under the plugins folder.
  */
  readonly leftoverFolders: readonly string[];

  /**
  Temporary plugin manifests left in `app.plugins.manifests`.
  */
  readonly leftoverManifests: readonly string[];

  /**
  `typeof` the resolved module's `Plugin` export.
  */
  readonly pluginType: string;

  /**
  How many times `app.plugins.requestSaveConfig` was called while resolving.
  */
  readonly saveRequestCount: number;
}

/**
 * Resolves the `obsidian` module twice at once, from the state a vault is in while it is still opening:
 * `community-plugins.json` lists plugins, but `app.plugins.enabledPlugins` is still the empty set the
 * plugin manager starts with, because `plugins.initialize` has not read the file yet. A config save
 * requested in that window writes `[]` over the list. Serialized and run via {@link CdpConnection.invoke}.
 *
 * @param isRestricted - Whether to put the vault in restricted mode (community plugins off) first.
 * @returns A promise resolving to the JSON-serialized {@link PluginConfigProbe}.
 */
async function probePluginConfigWrites(isRestricted: boolean): Promise<string> {
  // The probe swaps these members out and back, so they are mutable on purpose.
  interface PluginManagerLike {
    // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Swapped for the probe and restored after it.
    enabledPlugins: Set<string>;
    readonly manifests: Record<string, unknown>;
    // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Wrapped for the probe and restored after it.
    requestSaveConfig: (...saveArguments: unknown[]) => unknown;
  }
  interface ObsidianModuleLike {
    readonly Plugin: unknown;
  }
  interface NamespaceLike {
    readonly getObsidianModule: () => Promise<ObsidianModuleLike>;
    // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Cleared so the probe resolves the module afresh.
    obsidianModule: unknown;
  }
  interface NamespaceHolder {
    readonly __obsidianIntegrationTesting: NamespaceLike;
  }

  const SAVE_DEBOUNCE_MARGIN_IN_MILLISECONDS = 2500;
  const SEEDED_PLUGIN_IDS = ['seeded-plugin-a', 'seeded-plugin-b'];
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Runs serialized inside Obsidian, where `app` is the global.
  const obsidianApp = app;
  // eslint-disable-next-line no-restricted-syntax -- Approved double cast: probe the plugin manager's internal members.
  const plugins = obsidianApp.plugins as unknown as PluginManagerLike;
  // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the harness namespace is a local Window augmentation.
  const ns = (globalThis as unknown as NamespaceHolder).__obsidianIntegrationTesting;
  const configDirectory = obsidianApp.vault.configDir;
  const communityPluginsPath = `${configDirectory}/community-plugins.json`;
  const seeded = JSON.stringify(SEEDED_PLUGIN_IDS);
  await obsidianApp.vault.adapter.write(communityPluginsPath, seeded);

  const enabledPlugins = plugins.enabledPlugins;
  const requestSaveConfig = plugins.requestSaveConfig;
  let saveRequestCount = 0;
  plugins.enabledPlugins = new Set<string>();
  plugins.requestSaveConfig = (...saveArguments: unknown[]): unknown => {
    saveRequestCount++;
    return requestSaveConfig.apply(plugins, saveArguments);
  };
  ns.obsidianModule = undefined;
  if (isRestricted) {
    localStorage.setItem(`enable-plugin-${obsidianApp.appId}`, 'false');
  }

  try {
    const [first, second] = await Promise.all([ns.getObsidianModule(), ns.getObsidianModule()]);
    await sleep(SAVE_DEBOUNCE_MARGIN_IN_MILLISECONDS);
    const listed = await obsidianApp.vault.adapter.list(`${configDirectory}/plugins`);
    return JSON.stringify({
      communityPluginsOnDisk: await obsidianApp.vault.adapter.read(communityPluginsPath),
      isSameModule: first === second,
      leftoverFolders: listed.folders.filter((folder) => folder.includes('get-obsidian-module-')),
      leftoverManifests: Object.keys(plugins.manifests).filter((id) => id.startsWith('get-obsidian-module-')),
      pluginType: typeof first.Plugin,
      saveRequestCount
    });
  } finally {
    plugins.requestSaveConfig = requestSaveConfig;
    plugins.enabledPlugins = enabledPlugins;
  }
}

let connection: CdpConnection;

beforeAll(async () => {
  connection = await connectToCdp();
}, LAUNCH_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await connection.dispose();
});

describe('resolving the obsidian module while the vault is opening', () => {
  it.each([
    { isRestricted: false, mode: 'community plugins on' },
    { isRestricted: true, mode: 'restricted mode' }
  ])('leaves community-plugins.json alone ($mode)', async ({ isRestricted }) => {
    const probe = JSON.parse(
      await connection.invoke(`(${getFunctionExpressionString(probePluginConfigWrites)})(${JSON.stringify(isRestricted)})`)
    ) as PluginConfigProbe;
    expect(probe.pluginType).toBe('function');
    expect(probe.isSameModule).toBe(true);
    expect(probe.communityPluginsOnDisk).toBe(JSON.stringify(['seeded-plugin-a', 'seeded-plugin-b']));
    expect(probe.saveRequestCount).toBe(0);
    expect(probe.leftoverFolders).toStrictEqual([]);
    expect(probe.leftoverManifests).toStrictEqual([]);
  }, PROBE_TIMEOUT_IN_MILLISECONDS);
});
