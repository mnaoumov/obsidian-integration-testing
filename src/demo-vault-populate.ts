/**
 * @file
 *
 * Builds a complete {@link PopulateFilesParams} map for a plugin's in-repo `demo-vault/`, ready to seed into
 * the temp vault before Obsidian opens it. Composes {@link readDemoVaultTree} (the note tree) with the two
 * pieces it deliberately omits: selected `.obsidian/*` config files, and the built binaries (+ `data.json`)
 * of any extra community plugins the demo vault depends on (e.g. `CodeScript Toolkit`, `demo-vault-helper`).
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
import { DEFAULT_CONFIG_DIRECTORY } from './config-directory.ts';
import { readDemoVaultTree } from './demo-vault-tree.ts';
import { log } from './log.ts';
import { compareVersions } from './obsidian-version.ts';
import { ensureNonNullable } from './type-guards.ts';

/*
 * Both the folder the demo vault's own committed config sits in on disk, and the destination the map
 * names for it. The two coincide by construction: the source is a repo folder Obsidian created under its
 * default, and a `configDirectory` override on the run is applied to the destination keys later, by
 * `remapConfigDirectoryKeys` in `global-setup-core`, which is where the override is actually known.
 */
const OBSIDIAN_CONFIG_DIR = DEFAULT_CONFIG_DIRECTORY;
const PLUGINS_DIR = 'plugins';
const DATA_JSON = 'data.json';
const MANIFEST_JSON = 'manifest.json';
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
   * The oldest plugin version the demo vault works with, e.g. `'13.8.0'` for a demo script that imports
   * something only that release serves. A copy already installed in the demo vault whose `manifest.json`
   * reports an older version (or none) is **stale**: the headless bootstrap re-downloads it, and the
   * synchronous {@link buildDemoVaultPopulate} refuses it rather than seeding it.
   *
   * Without it a warm checkout keeps whatever version it first downloaded for good, since the plugin folder
   * is gitignored — so a fresh clone passes while every machine with an old copy fails, under an error
   * that names the demo script rather than the plugin. Ignored for a plugin with an explicit
   * {@link InjectPluginParams.sourceDirectory}.
   */
  readonly minVersion?: string | undefined;

  /**
   * The community plugin's id (its `.obsidian/plugins/<pluginId>` folder name).
   */
  readonly pluginId: string;

  /**
   * The GitHub repository (`owner/name`) publishing this plugin, consulted **only** by the headless
   * bootstrap (`bootstrapDemoVaultPlugins` / `buildDemoVaultPopulateAsync` / the
   * `bootstrap-demo-vault` CLI) when the binaries are missing from the demo vault or stale (see
   * {@link InjectPluginParams.minVersion}). Supplying it skips the lookup in Obsidian's community plugin
   * registry, which is also the way to bootstrap a plugin that is not listed there at all. Never used
   * when an acceptable copy is already on disk.
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
   * repository's latest release — what the in-app community browser installs.
   *
   * A pin is held, not merely used for the first download: an installed copy whose `manifest.json` reports
   * a different version is **stale**, exactly as one below {@link InjectPluginParams.minVersion} is. A
   * leading `v` on the tag is ignored for that comparison. Ignored for a plugin with an explicit
   * {@link InjectPluginParams.sourceDirectory}.
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
 * Parameters for {@link resolveInjectedPluginStaleReason}.
 */
export interface ResolveInjectedPluginStaleReasonParams {
  /**
  The version the installed copy's `manifest.json` reports, or `undefined` when it reports none.
   */
  readonly installedVersion: string | undefined;

  /**
  The injected plugin whose installed copy is being judged.
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
 * Judges whether an installed copy of an injected plugin is too old to use, against its pinned
 * {@link InjectPluginParams.version} and its {@link InjectPluginParams.minVersion}.
 *
 * @param params - The {@link ResolveInjectedPluginStaleReasonParams}.
 * @returns Why the copy is stale, or `undefined` when it is acceptable (including when the plugin declares
 *   neither a pin nor a minimum, or opted out with an explicit `sourceDirectory`).
 */
export function resolveInjectedPluginStaleReason(params: ResolveInjectedPluginStaleReasonParams): string | undefined {
  const { installedVersion, plugin } = params;
  if (plugin.sourceDirectory !== undefined) {
    return undefined;
  }

  const installedLabel = installedVersion ?? 'no version';

  if (plugin.version !== undefined) {
    const pinnedVersion = stripVersionTagPrefix(plugin.version);
    if (installedVersion !== pinnedVersion) {
      return `the installed copy reports ${installedLabel}, but \`version\` pins ${pinnedVersion}`;
    }
  }

  return plugin.minVersion !== undefined && (installedVersion === undefined || compareVersions(installedVersion, plugin.minVersion) < 0) ? `the installed copy reports ${installedLabel}, older than \`minVersion\` ${plugin.minVersion}` : undefined;
}

/**
 * Selects the injected plugins that the headless bootstrap has to (re-)install — the exact set
 * {@link buildDemoVaultPopulate} would otherwise throw on: those whose binaries are missing from the demo
 * vault, and those whose installed copy is stale (see {@link resolveInjectedPluginStaleReason}).
 *
 * Plugins carrying an explicit {@link InjectPluginParams.sourceDirectory} are excluded: that names a local
 * build output, not somewhere to download a published release into.
 *
 * Shared with the bootstrap so "missing" and "stale" each have one definition rather than two that can drift
 * apart.
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
    const sourceDirectory = resolveInjectedPluginSourceDirectory({ demoVaultPath, plugin });
    const fileNames = readPluginFileNames(sourceDirectory);
    return REQUIRED_PLUGIN_ASSET_NAMES.some((assetName) => !fileNames.includes(assetName)) || resolveInjectedPluginStaleReason({ installedVersion: readInstalledPluginVersion(sourceDirectory), plugin }) !== undefined;
  });
}

/**
 * Builds the copy-pasteable `bootstrap-demo-vault` command that repairs exactly one injected plugin.
 *
 * It names the plugin and carries every setting the setup judged it by (`repo`, `version`, `minVersion`).
 * The bare `--demo-vault` form installs only the plugins already present in the folder and cannot know the
 * setup's `minVersion`, so it reported a stale copy as `Nothing to install`, and missed a plugin whose
 * folder had been deleted.
 *
 * @param demoVaultPath - The demo vault root.
 * @param plugin - The plugin to repair.
 * @returns The command line.
 */
function buildBootstrapCommand(demoVaultPath: string, plugin: InjectPluginParams): string {
  return [
    'npx obsidian-integration-testing bootstrap-demo-vault',
    `--demo-vault "${demoVaultPath}"`,
    `--plugin ${plugin.pluginId}`,
    plugin.repo === undefined ? '' : `--repo ${plugin.repo}`,
    plugin.version === undefined ? '' : `--version ${plugin.version}`,
    plugin.minVersion === undefined ? '' : `--min-version ${plugin.minVersion}`
  ].filter(Boolean).join(' ');
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
  return plugin.sourceDirectory === undefined
    ? `Install it headlessly with \`${buildBootstrapCommand(demoVaultPath, plugin)}\`, `
      + 'or switch this setup to `buildDemoVaultPopulateAsync`, which installs missing plugins itself. '
      + 'Opening demo-vault/ in Obsidian once so demo-vault-helper installs it also works.'
    : 'It was read from an explicit `sourceDirectory`, which opts it out of the headless bootstrap — '
      + 'build it into that directory, or drop `sourceDirectory` to install it from its published release.';
}

/**
 * Reads the `version` an installed plugin's `manifest.json` reports.
 *
 * @param sourceDirectory - The plugin's directory.
 * @returns The version, or `undefined` when the manifest is absent, unreadable, or carries no string
 *   `version`.
 */
function readInstalledPluginVersion(sourceDirectory: string): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(sourceDirectory, MANIFEST_JSON), 'utf-8'));
  } catch {
    return undefined;
  }

  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    return undefined;
  }

  return typeof manifest.version === 'string' ? manifest.version : undefined;
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

  const installedVersion = readInstalledPluginVersion(sourceDirectory);
  const staleReason = resolveInjectedPluginStaleReason({ installedVersion, plugin });
  if (staleReason !== undefined) {
    throw new Error(
      `Community plugin "${pluginId}" in the demo vault (${sourceDirectory}) is stale: ${staleReason}. `
        + `Re-install it headlessly with \`${buildBootstrapCommand(demoVaultPath, plugin)}\`, `
        + 'or switch this setup to `buildDemoVaultPopulateAsync`, which re-downloads stale plugins itself.'
    );
  }

  log(`[demo-vault-populate] Injecting "${pluginId}" ${installedVersion ?? '(no version in manifest.json)'} from ${sourceDirectory}.`);

  for (const fileName of fileNames) {
    // `data.json` is regenerated from `data` below (when provided); skip the on-disk copy to avoid seeding it twice.
    if (fileName === DATA_JSON && data !== undefined) {
      continue;
    }
    map[`${pluginPrefix}/${fileName}`] = readFileSync(join(sourceDirectory, fileName));
  }

  if (data === undefined) {
    return;
  }

  const dataJson: string = ensureNonNullable(JSON.stringify(data, null, DATA_JSON_INDENT));
  map[`${pluginPrefix}/${DATA_JSON}`] = `${dataJson}\n`;
}

/**
 * Strips the `v` some repositories prefix their release tags with, so a tag compares with a manifest version.
 *
 * @param version - A release tag or version.
 * @returns The version without a leading `v`.
 */
function stripVersionTagPrefix(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}
