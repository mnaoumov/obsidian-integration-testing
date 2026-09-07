/**
 * @file
 *
 * Installs a built plugin into a **harness-owned** vault's config folder, before
 * that vault is ever opened: the build output into
 * `<configDirectory>/plugins/<pluginId>/`, and the id into
 * `<configDirectory>/community-plugins.json` so Obsidian enables it on load.
 *
 * Carved out of `global-setup-core`'s `copyPluginIntoVault` for the same reason
 * `ensureHeadlessVaultConfig` was carved out of the `app.json` write: the write
 * has to go where the vault will actually look, and a `configDirectory` override
 * moves that. `copyPluginIntoVault` still owns the parts around it — resolving
 * `dist/dev` vs `dist/build`, reading the manifest, and refusing a desktop-only
 * plugin on a mobile transport — and delegates only the write here, which is
 * what makes the override path reachable from a unit test.
 *
 * Writing into `.obsidian` while the vault reads `.obsidian-desktop` installs the
 * plugin into a folder nothing looks at, and the enable that follows fails with
 * the generic "enabled but not loaded" shape, naming nothing about a config
 * folder. `resolveOwnedConfigDirectory` (`transport-options.ts`) is the one
 * answer to "which folder will this vault read"; every caller here takes its
 * result.
 */

import {
  cp,
  mkdir,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_CONFIG_DIRECTORY } from './config-directory.ts';

const PLUGINS_DIR = 'plugins';
const COMMUNITY_PLUGINS_JSON = 'community-plugins.json';

/**
 * Parameters for {@link installPluginIntoVault}.
 */
export interface InstallPluginIntoVaultParams {
  /**
   * The vault's config folder name, when it is overridden away from
   * {@link DEFAULT_CONFIG_DIRECTORY}. Installing into `.obsidian` while the vault
   * reads `.obsidian-desktop` leaves the plugin where nothing looks for it, so
   * the override has to reach this far.
   *
   * @default `'.obsidian'`
   */
  readonly configDirectory?: string | undefined;

  /**
   * The directory holding the built plugin (`main.js`, `manifest.json`, …) —
   * the resolved `dist/dev` or `dist/build`.
   */
  readonly distPath: string;

  /**
   * The plugin's id, which names both its folder and its
   * `community-plugins.json` entry.
   */
  readonly pluginId: string;

  /**
   * The absolute path of the harness-owned vault to install into.
   */
  readonly vaultPath: string;
}

/**
 * Copies the built plugin into the vault's config folder and marks it as an
 * enabled community plugin.
 *
 * Only ever call this on a vault the harness owns: it overwrites
 * `community-plugins.json` outright, because the harness is the one that decides
 * what a throwaway vault has enabled. Extra community plugins are seeded through
 * `populate` and enabled after open instead, so they do not need to survive this
 * write.
 *
 * @param params - The vault to install into, its config folder, and the build to install.
 */
export async function installPluginIntoVault(params: InstallPluginIntoVaultParams): Promise<void> {
  const { configDirectory = DEFAULT_CONFIG_DIRECTORY, distPath, pluginId, vaultPath } = params;

  const pluginDirectory = join(vaultPath, configDirectory, PLUGINS_DIR, pluginId);
  await mkdir(pluginDirectory, { recursive: true });
  await cp(distPath, pluginDirectory, { recursive: true });
  await writeFile(join(vaultPath, configDirectory, COMMUNITY_PLUGINS_JSON), JSON.stringify([pluginId]));
}
