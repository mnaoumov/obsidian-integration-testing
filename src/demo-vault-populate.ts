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
 */

import {
  existsSync,
  readdirSync,
  readFileSync
} from 'node:fs';
import { join } from 'node:path';

import type { PopulateFilesParams } from './temp-vault.ts';

import { readDemoVaultTree } from './demo-vault-tree.ts';
import { ensureNonNullable } from './type-guards.ts';

const OBSIDIAN_CONFIG_DIR = '.obsidian';
const PLUGINS_DIR = 'plugins';
const DATA_JSON = 'data.json';
const MANIFEST_JSON = 'manifest.json';
const MAIN_JS = 'main.js';
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
   * `data.json` (if any) already lives in {@link InjectPluginParams.sourceDir}.
   */
  readonly data?: unknown;

  /**
   * The community plugin's id (its `.obsidian/plugins/<pluginId>` folder name).
   */
  readonly pluginId: string;

  /**
   * Directory to read the plugin's built files from. Every file directly inside it is copied into
   * `.obsidian/plugins/<pluginId>/`; `main.js` and `manifest.json` are required.
   *
   * @default `<demoVaultPath>/.obsidian/plugins/<pluginId>`
   */
  readonly sourceDir?: string;
}

/**
 * Builds the full populate map for a plugin's `demo-vault/`: the note tree, the selected `.obsidian/*` config
 * files, and every injected plugin's binaries (+ optional `data.json`).
 *
 * @param params - The {@link BuildDemoVaultPopulateParams}.
 * @returns The populate map, ready to hand to a global setup's `populate` or {@link TempVault.populate}.
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
 * Seeds one injected plugin's binaries (and optional `data.json`) into the populate map.
 *
 * @param demoVaultPath - The demo vault root, used to resolve the default source directory.
 * @param plugin - The plugin to seed.
 * @param map - The populate map to write into.
 */
function seedPlugin(demoVaultPath: string, plugin: InjectPluginParams, map: PopulateFilesParams): void {
  const { data, pluginId } = plugin;
  const sourceDir = plugin.sourceDir ?? join(demoVaultPath, OBSIDIAN_CONFIG_DIR, PLUGINS_DIR, pluginId);
  const pluginPrefix = `${OBSIDIAN_CONFIG_DIR}/${PLUGINS_DIR}/${pluginId}`;

  const fileNames = existsSync(sourceDir)
    ? readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    : [];

  for (const requiredFile of [MAIN_JS, MANIFEST_JSON]) {
    if (!fileNames.includes(requiredFile)) {
      throw new Error(
        `Community plugin "${pluginId}" is not installed in the demo vault (${join(sourceDir, requiredFile)} missing). `
          + 'Open demo-vault/ in Obsidian once so demo-vault-helper installs it, then re-run.'
      );
    }
  }

  for (const fileName of fileNames) {
    // `data.json` is regenerated from `data` below (when provided); skip the on-disk copy to avoid seeding it twice.
    if (fileName === DATA_JSON && data !== undefined) {
      continue;
    }
    map[`${pluginPrefix}/${fileName}`] = readFileSync(join(sourceDir, fileName));
  }

  if (data !== undefined) {
    const dataJson: string = ensureNonNullable(JSON.stringify(data, null, DATA_JSON_INDENT));
    map[`${pluginPrefix}/${DATA_JSON}`] = `${dataJson}\n`;
  }
}
