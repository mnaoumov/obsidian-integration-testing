/**
 * @file
 *
 * Builds a complete {@link PopulateFilesParams} map for a plugin's in-repo `demo-vault/`, ready to seed into
 * the temp vault before Obsidian opens it. Composes {@link readDemoVaultTree} (the note tree) with the two
 * pieces it deliberately omits: selected `.obsidian/*` config files, and the built binaries (+ `data.json`)
 * of any extra community plugins the demo vault depends on (e.g. CodeScript Toolkit, `demo-vault-helper`).
 *
 * Pairs with the `enableCommunityPlugins` option of the global-setup `createSetup`: this seeds the binaries,
 * that turns them on. It intentionally does NOT write `community-plugins.json` — the harness owns that file
 * (it lists the plugin-under-test), and enabling the extras persists them.
 *
 * Stays **synchronous**, so an injected plugin whose binaries are absent is a throw rather than a download.
 * `demo-vault-bootstrap.ts` owns the headless install the throw's message points at — including
 * `buildDemoVaultPopulateAsync`, the self-healing sibling of {@link buildDemoVaultPopulate}. The
 * missing-plugin detection ({@link resolveMissingInjectedPlugins}) lives here and is shared with it, so the
 * two paths cannot disagree about what "not installed" means.
 */

import {
  existsSync,
  readdirSync,
  readFileSync
} from 'node:fs';
import { join } from 'node:path';

import type { PopulateFilesParams } from './temporary-vault.ts';

import { REQUIRED_PLUGIN_ASSET_NAMES } from './community-plugin-registry.ts';
import { readDemoVaultTree } from './demo-vault-tree.ts';
import { ensureNonNullable } from './type-guards.ts';

const OBSIDIAN_CONFIG_DIR = '.obsidian';
const PLUGINS_DIR = 'plugins';
const DATA_JSON = 'data.json';
const DATA_JSON_INDENT = 2;

const DEFAULT_OBSIDIAN_CONFIG_FILES = ['app.json', 'appearance.json', 'core-plugins.json'];

/**
 * Parameters for {@link buildDemoVaultPopulate}.
 */
export interface BuildDemoVaultPopulateParams {
  /**
   * Absolute path to the plugin repo's `demo-vault/` directory.
   */
  readonly demoVaultPath: string;

  /**
   * Names (of files or directories, matched at any depth) to skip while reading the note tree — forwarded to
   * {@link readDemoVaultTree}.
   *
   * @default `['.git', '.obsidian']`
   */
  readonly excludedNames?: Iterable<string>;

  /**
   * Community plugins to seed into `.obsidian/plugins/<pluginId>/` (binaries + optional `data.json`). Turn
   * them on with the global-setup `createSetup({ enableCommunityPlugins })` option.
   */
  readonly injectPlugins?: readonly InjectPluginParams[];

  /**
   * `.obsidian/*` config files to carry over from the demo vault. {@link readDemoVaultTree} excludes the whole
   * `.obsidian` directory, so config the vault relies on (preview-mode default, core plugins, appearance) must
   * be re-added explicitly. Files that do not exist are skipped.
   *
   * @default `['app.json', 'appearance.json', 'core-plugins.json']`
   */
  readonly obsidianConfigFiles?: readonly string[];
}

/**
 * A community plugin to seed into the demo vault alongside the note tree.
 */
export interface InjectPluginParams {
  /**
   * Overlay written as `.obsidian/plugins/<pluginId>/data.json` (JSON, 2-space indent). Omit to keep whatever
   * `data.json` (if any) already lives in {@link InjectPluginParams.sourceDirectory}.
   */
  readonly data?: unknown;

  /**
   * The community plugin's id (its `.obsidian/plugins/<pluginId>` folder name).
   */
  readonly pluginId: string;

  /**
   * The GitHub repository (`owner/name`) publishing this plugin, consulted **only** by the headless
   * bootstrap (`bootstrapDemoVaultPlugins` / `buildDemoVaultPopulateAsync` / the
   * `bootstrap-demo-vault` CLI) when the binaries are missing from the demo vault. Supplying it skips
   * the lookup in Obsidian's community plugin registry, which is also the way to bootstrap a plugin
   * that is not listed there at all. Never used when the files are already on disk.
   */
  readonly repo?: string | undefined;

  /**
   * Directory to read the plugin's built files from. Every file directly inside it is copied into
   * `.obsidian/plugins/<pluginId>/`; `main.js` and `manifest.json` are required.
   *
   * Setting this also opts the plugin **out** of the headless bootstrap: an explicit source directory
   * names a local build output, not somewhere to download a published release into.
   *
   * @default `<demoVaultPath>/.obsidian/plugins/<pluginId>`
   */

  readonly sourceDirectory?: string;

  /**
   * The release tag the headless bootstrap downloads from, pinning the installed version. Omit for the
   * repository's latest release — what the in-app community browser installs. Like
   * {@link InjectPluginParams.repo}, consulted only while bootstrapping missing binaries.
   */
  readonly version?: string | undefined;
}

/**
 * Parameters for {@link resolveInjectedPluginSourceDirectory}.
 */
export interface ResolveInjectedPluginSourceDirectoryParams {
  /**
  Absolute path to the plugin repo's `demo-vault/` directory.
   */
  readonly demoVaultPath: string;

  /**
  The injected plugin whose source directory to resolve.
   */
  readonly plugin: InjectPluginParams;
}

/**
 * Parameters for {@link resolveMissingInjectedPlugins}.
 */
export interface ResolveMissingInjectedPluginsParams {
  /**
  Absolute path to the plugin repo's `demo-vault/` directory.
   */
  readonly demoVaultPath: string;

  /**
  The injected plugins to check.
   */
  readonly injectPlugins: readonly InjectPluginParams[];
}

/**
 * Builds the full populate map for a plugin's `demo-vault/`: the note tree, the selected `.obsidian/*` config
 * files, and every injected plugin's binaries (+ optional `data.json`).
 *
 * @param params - The {@link BuildDemoVaultPopulateParams}.
 * @returns The populate map, ready to hand to a global setup's `populate` or {@link TemporaryVault.populate}.
 */
export function buildDemoVaultPopulate(params: BuildDemoVaultPopulateParams): PopulateFilesParams {
  const { demoVaultPath, excludedNames, injectPlugins = [], obsidianConfigFiles = DEFAULT_OBSIDIAN_CONFIG_FILES } = params;

  const map = readDemoVaultTree(excludedNames === undefined ? { demoVaultPath } : { demoVaultPath, excludedNames });

  for (const configFile of obsidianConfigFiles) {
    const configPath = join(demoVaultPath, OBSIDIAN_CONFIG_DIR, configFile);
    if (existsSync(configPath)) {
      map[`${OBSIDIAN_CONFIG_DIR}/${configFile}`] = readFileSync(configPath);
    }
  }

  for (const plugin of injectPlugins) {
    seedPlugin(demoVaultPath, plugin, map);
  }

  return map;
}

/**
 * Resolves the directory an injected plugin's built files are read from.
 *
 * @param params - The {@link ResolveInjectedPluginSourceDirectoryParams}.
 * @returns The explicit {@link InjectPluginParams.sourceDirectory} when set, otherwise the plugin's folder
 *   inside the demo vault.
 */
export function resolveInjectedPluginSourceDirectory(params: ResolveInjectedPluginSourceDirectoryParams): string {
  const { demoVaultPath, plugin } = params;
  return plugin.sourceDirectory ?? join(demoVaultPath, OBSIDIAN_CONFIG_DIR, PLUGINS_DIR, plugin.pluginId);
}

/**
 * Selects the injected plugins whose binaries are missing from the demo vault and can therefore be
 * installed headlessly — the exact set {@link buildDemoVaultPopulate} would otherwise throw on.
 *
 * Plugins carrying an explicit {@link InjectPluginParams.sourceDirectory} are excluded: that names a local
 * build output, not somewhere to download a published release into.
 *
 * Shared with the bootstrap so "missing" has one definition rather than two that can drift apart.
 *
 * @param params - The {@link ResolveMissingInjectedPluginsParams}.
 * @returns The plugins to bootstrap, in the order given.
 */
export function resolveMissingInjectedPlugins(params: ResolveMissingInjectedPluginsParams): InjectPluginParams[] {
  const { demoVaultPath } = params;
  return params.injectPlugins.filter((plugin) => {
    if (plugin.sourceDirectory !== undefined) {
      return false;
    }
    const fileNames = readPluginFileNames(resolveInjectedPluginSourceDirectory({ demoVaultPath, plugin }));
    return REQUIRED_PLUGIN_ASSET_NAMES.some((assetName) => !fileNames.includes(assetName));
  });
}

/**
 * Builds the "how to fix this" half of the missing-binaries error.
 *
 * The remedy differs by opt-out: a plugin read from the demo vault can be installed headlessly, while one
 * read from an explicit `sourceDirectory` names a local build output the bootstrap must never overwrite.
 *
 * @param demoVaultPath - The demo vault root, named in the CLI hint so the command is copy-pasteable.
 * @param plugin - The plugin whose binaries are missing.
 * @returns The remedy sentence(s).
 */
function buildMissingPluginRemedy(demoVaultPath: string, plugin: InjectPluginParams): string {
  if (plugin.sourceDirectory !== undefined) {
    return 'It was read from an explicit `sourceDirectory`, which opts it out of the headless bootstrap — '
      + 'build it into that directory, or drop `sourceDirectory` to install it from its published release.';
  }

  return `Install it headlessly with \`npx obsidian-integration-testing bootstrap-demo-vault --demo-vault "${demoVaultPath}"\`, `
    + 'or switch this setup to `buildDemoVaultPopulateAsync`, which installs missing plugins itself. '
    + 'Opening demo-vault/ in Obsidian once so demo-vault-helper installs it also works.';
}

/**
 * Lists the file names directly inside a plugin's source directory.
 *
 * @param sourceDirectory - The directory to list.
 * @returns The file names, or an empty array when the directory does not exist.
 */
function readPluginFileNames(sourceDirectory: string): string[] {
  return existsSync(sourceDirectory)
    ? readdirSync(sourceDirectory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    : [];
}

/**
 * Seeds one injected plugin's binaries (and optional `data.json`) into the populate map.
 *
 * @param demoVaultPath - The demo vault root, used to resolve the default source directory.
 * @param plugin - The plugin to seed.
 * @param map - The populate map to write into.
 * @throws Error if the plugin's `main.js` / `manifest.json` are not on disk, naming the headless remedies.
 */
function seedPlugin(demoVaultPath: string, plugin: InjectPluginParams, map: PopulateFilesParams): void {
  const { data, pluginId } = plugin;
  const sourceDirectory = resolveInjectedPluginSourceDirectory({ demoVaultPath, plugin });
  const pluginPrefix = `${OBSIDIAN_CONFIG_DIR}/${PLUGINS_DIR}/${pluginId}`;

  const fileNames = readPluginFileNames(sourceDirectory);

  for (const requiredFile of REQUIRED_PLUGIN_ASSET_NAMES) {
    if (!fileNames.includes(requiredFile)) {
      const remedy = buildMissingPluginRemedy(demoVaultPath, plugin);
      throw new Error(
        `Community plugin "${pluginId}" is not installed in the demo vault (${join(sourceDirectory, requiredFile)} missing). ${remedy}`
      );
    }
  }

  for (const fileName of fileNames) {
    // `data.json` is regenerated from `data` below (when provided); skip the on-disk copy to avoid seeding it twice.
    if (fileName === DATA_JSON && data !== undefined) {
      continue;
    }
    map[`${pluginPrefix}/${fileName}`] = readFileSync(join(sourceDirectory, fileName));
  }

  if (data !== undefined) {
    const dataJson: string = ensureNonNullable(JSON.stringify(data, null, DATA_JSON_INDENT));
    map[`${pluginPrefix}/${DATA_JSON}`] = `${dataJson}\n`;
  }
}
