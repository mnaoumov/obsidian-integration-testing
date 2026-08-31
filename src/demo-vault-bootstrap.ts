/**
 * @file
 *
 * Installs a demo vault's **injected community plugins** headlessly, by downloading
 * their published GitHub release assets straight into
 * `demo-vault/.obsidian/plugins/<id>/`.
 *
 * `buildDemoVaultPopulate` requires each injected plugin's `main.js` /
 * `manifest.json` to already be on disk, and throws when they are not. Until this
 * module existed the only documented remedy was a **GUI step** — open `demo-vault/`
 * in Obsidian once and let `demo-vault-helper` install the plugin at runtime.
 * `.obsidian/plugins/*` is gitignored in every fleet plugin repo, so that state
 * exists on exactly the one machine that did it and is invisible to a fresh clone,
 * a new machine, or CI. Since a plugin repo's release preflight runs its
 * integration tests, that made *cutting a release from a clean clone* impossible
 * without a human opening a GUI.
 *
 * Downloading the release assets is the exact headless equivalent: the resulting
 * folder is what Obsidian itself would have installed, so the shipped
 * `*-demo-vault-<version>.zip` stays the fleet-standard artifact.
 *
 * Two entry points, plus the `bootstrap-demo-vault` CLI subcommand:
 *
 * - {@link bootstrapDemoVaultPlugins} — install the missing ones, explicitly.
 * - {@link buildDemoVaultPopulateAsync} — do that and then build the populate map,
 *   so a global setup self-heals with no manual step at all.
 *
 * The sync `buildDemoVaultPopulate` deliberately keeps throwing: `fetch` has no
 * synchronous form, so auto-healing can only live on an async sibling. Its message
 * now names both remedies above instead of the GUI step.
 */

import {
  mkdirSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import type { CommunityPluginRegistryEntry } from './community-plugin-registry.ts';
import type {
  BuildDemoVaultPopulateParams,
  InjectPluginParams
} from './demo-vault-populate.ts';
import type { PopulateFilesParams } from './temporary-vault.ts';

import {
  buildPluginAssetUrl,
  COMMUNITY_PLUGINS_REGISTRY_URL,
  isValidRepoReference,
  OPTIONAL_PLUGIN_ASSET_NAMES,
  REQUIRED_PLUGIN_ASSET_NAMES,
  selectPluginRepo
} from './community-plugin-registry.ts';
import {
  buildDemoVaultPopulate,
  resolveInjectedPluginSourceDirectory,
  resolveMissingInjectedPlugins
} from './demo-vault-populate.ts';
import { log } from './log.ts';

/**
 * Browser `User-Agent` for the asset downloads, matching `obsidian-installer.ts` —
 * a plain Node fetch is rejected by some CDN edges.
 */
const DOWNLOAD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTTP_NOT_FOUND = 404;

/**
 * The community plugin registry, fetched at most once per process. Every injected
 * plugin of every demo-vault project in a run resolves against the same table, and
 * it is a multi-megabyte document.
 */
let registryPromise: Promise<readonly CommunityPluginRegistryEntry[]> | undefined;

/**
 * Parameters for {@link bootstrapDemoVaultPlugins}.
 */
export interface BootstrapDemoVaultPluginsParams {
  /**
  Absolute path to the plugin repo's `demo-vault/` directory.
   */
  readonly demoVaultPath: string;

  /**
   * The injected plugins to install — the same list passed to `buildDemoVaultPopulate`. Plugins whose
   * binaries are already present are skipped (unless {@link BootstrapDemoVaultPluginsParams.shouldForce}),
   * as are plugins carrying an explicit `sourceDirectory`.
   */
  readonly injectPlugins: readonly InjectPluginParams[];

  /**
   * Whether to re-download plugins that are already installed, replacing them with the current release.
   * Defaults to `false` — the normal path installs only what is missing, so a warm checkout does no
   * network I/O at all.
   */
  readonly shouldForce?: boolean | undefined;
}

/**
 * The outcome of a {@link bootstrapDemoVaultPlugins} run.
 */
export interface BootstrapDemoVaultPluginsResult {
  /**
  The plugins that were downloaded and written, in the order they were installed.
   */
  readonly installed: readonly InstalledPluginInfo[];

  /**
  The ids of plugins left untouched — already installed, or opted out via an explicit `sourceDirectory`.
   */
  readonly skippedPluginIds: readonly string[];
}

/**
 * One plugin installed by {@link bootstrapDemoVaultPlugins}.
 */
export interface InstalledPluginInfo {
  /**
  The asset file names actually written, e.g. `['main.js', 'manifest.json', 'styles.css']`.
   */
  readonly assetNames: readonly string[];

  /**
  The plugin's id.
   */
  readonly pluginId: string;

  /**
  The GitHub repository the assets came from, as `owner/name`.
   */
  readonly repo: string;

  /**
  The release tag downloaded from, or `undefined` when the repository's latest release was used.
   */
  readonly version: string | undefined;
}

/**
 * Installs every injected community plugin whose built files are missing from the demo vault, by
 * downloading its published release assets into `demo-vault/.obsidian/plugins/<id>/`.
 *
 * Each plugin's repository comes from its {@link InjectPluginParams.repo} when given, otherwise from
 * Obsidian's own community plugin registry — the same `id` → `repo` table the in-app community browser
 * installs from, so no plugin-specific mapping is hardcoded.
 *
 * @param params - The {@link BootstrapDemoVaultPluginsParams}.
 * @returns What was installed and what was skipped.
 * @throws Error if a plugin's repository cannot be resolved, or a required asset cannot be downloaded.
 */
export async function bootstrapDemoVaultPlugins(params: BootstrapDemoVaultPluginsParams): Promise<BootstrapDemoVaultPluginsResult> {
  const { demoVaultPath, injectPlugins, shouldForce = false } = params;

  const bootstrappable = injectPlugins.filter((plugin) => plugin.sourceDirectory === undefined);
  const targets = shouldForce ? bootstrappable : resolveMissingInjectedPlugins({ demoVaultPath, injectPlugins });
  const targetPluginIds = new Set(targets.map((plugin) => plugin.pluginId));

  const installed: InstalledPluginInfo[] = [];
  for (const plugin of targets) {
    // Sequential on purpose: the installs share one memoised registry fetch.
    // Parallelism would buy nothing but interleaved logs for the handful of plugins a demo vault injects.
    installed.push(await installPlugin(demoVaultPath, plugin));
  }

  return {
    installed,
    skippedPluginIds: injectPlugins.map((plugin) => plugin.pluginId).filter((pluginId) => !targetPluginIds.has(pluginId))
  };
}

/**
 * The self-healing counterpart of `buildDemoVaultPopulate`: installs any injected community plugin whose
 * binaries are missing (see {@link bootstrapDemoVaultPlugins}), then builds the populate map exactly as the
 * synchronous builder does.
 *
 * Use this from a global setup's `populate` thunk — both the Vitest and Jest adapters accept a thunk
 * returning a promise — so a fresh clone, a new machine, or CI needs no manual install step.
 *
 * @param params - The same `BuildDemoVaultPopulateParams` the synchronous builder takes.
 * @returns The populate map, ready to hand to a global setup's `populate` or `TemporaryVault.populate`.
 */
export async function buildDemoVaultPopulateAsync(params: BuildDemoVaultPopulateParams): Promise<PopulateFilesParams> {
  if (params.injectPlugins !== undefined) {
    await bootstrapDemoVaultPlugins({ demoVaultPath: params.demoVaultPath, injectPlugins: params.injectPlugins });
  }

  return buildDemoVaultPopulate(params);
}

/* v8 ignore start -- Network download glue, covered by integration tests, not unit tests. */

/**
 * Builds the request headers for a GitHub download, sending a `GITHUB_TOKEN` / `GH_TOKEN` bearer when one
 * is in the environment — without it the anonymous quota returns HTTP 403 on shared CI runner IPs.
 *
 * @returns The headers to send.
 */
function buildGitHubHeaders(): Headers {
  const headers = new Headers({ 'User-Agent': DOWNLOAD_USER_AGENT });
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
}

/**
 * Downloads one release asset.
 *
 * @param url - The asset's download URL.
 * @param isRequired - Whether a missing asset (HTTP 404) is an error rather than an absent optional file.
 * @returns The asset's bytes, or `undefined` when an optional asset is not published.
 * @throws Error if the download fails and the asset is required.
 */
async function downloadAsset(url: string, isRequired: boolean): Promise<Buffer | undefined> {
  const response = await fetch(url, { headers: buildGitHubHeaders() });
  if (!response.ok) {
    if (!isRequired && response.status === HTTP_NOT_FOUND) {
      return undefined;
    }
    throw new Error(`Failed to download ${url}: HTTP ${String(response.status)} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fetches Obsidian's community plugin registry, memoised for the lifetime of the process.
 *
 * @returns The registry rows.
 * @throws Error if the registry cannot be fetched or parsed.
 */
async function fetchCommunityPluginRegistry(): Promise<readonly CommunityPluginRegistryEntry[]> {
  registryPromise ??= (async (): Promise<readonly CommunityPluginRegistryEntry[]> => {
    log(`[demo-vault-bootstrap] Fetching Obsidian's community plugin registry from ${COMMUNITY_PLUGINS_REGISTRY_URL}...`);
    const response = await fetch(COMMUNITY_PLUGINS_REGISTRY_URL, { headers: buildGitHubHeaders() });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Obsidian's community plugin registry (${COMMUNITY_PLUGINS_REGISTRY_URL}): `
          + `HTTP ${String(response.status)} ${response.statusText}. `
          + 'Pass an explicit `repo` on the injected plugin to skip the registry lookup.'
      );
    }
    return await response.json() as readonly CommunityPluginRegistryEntry[];
  })();

  try {
    return await registryPromise;
  } catch (error: unknown) {
    // Do not memoise a failure: a transient network error must not poison every later lookup.
    registryPromise = undefined;
    throw error;
  }
}

/**
 * Downloads one plugin's release assets and writes them into the demo vault.
 *
 * @param demoVaultPath - The demo vault root.
 * @param plugin - The plugin to install.
 * @returns What was installed.
 * @throws Error if the repository cannot be resolved or a required asset cannot be downloaded.
 */
async function installPlugin(demoVaultPath: string, plugin: InjectPluginParams): Promise<InstalledPluginInfo> {
  const { pluginId, version } = plugin;
  const repo = await resolvePluginRepo(plugin);
  const targetDirectory = resolveInjectedPluginSourceDirectory({ demoVaultPath, plugin });

  log(`[demo-vault-bootstrap] Installing "${pluginId}" from ${repo}@${version ?? 'latest'} into ${targetDirectory}...`);

  const downloads = await Promise.all([
    ...REQUIRED_PLUGIN_ASSET_NAMES.map(async (assetName) => ({
      assetName,
      content: await downloadAsset(buildPluginAssetUrl({ assetName, repo, version }), true)
    })),
    ...OPTIONAL_PLUGIN_ASSET_NAMES.map(async (assetName) => ({
      assetName,
      content: await downloadAsset(buildPluginAssetUrl({ assetName, repo, version }), false)
    }))
  ]);

  mkdirSync(targetDirectory, { recursive: true });

  const assetNames: string[] = [];
  for (const { assetName, content } of downloads) {
    if (content === undefined) {
      continue;
    }
    writeFileSync(join(targetDirectory, assetName), content);
    assetNames.push(assetName);
  }

  log(`[demo-vault-bootstrap] Installed "${pluginId}": ${assetNames.join(', ')}.`);

  return { assetNames, pluginId, repo, version };
}

/**
 * Resolves the GitHub repository publishing a plugin — the explicit override when given, otherwise
 * Obsidian's community plugin registry.
 *
 * @param plugin - The plugin to resolve.
 * @returns The `owner/name` repository reference.
 * @throws Error if an explicit override is malformed, or the id is not a registered community plugin.
 */
async function resolvePluginRepo(plugin: InjectPluginParams): Promise<string> {
  const { pluginId, repo } = plugin;

  if (repo !== undefined) {
    if (!isValidRepoReference(repo)) {
      throw new Error(`Invalid \`repo\` for community plugin "${pluginId}": ${repo}. Expected an \`owner/name\` reference.`);
    }
    return repo;
  }

  const registryRepo = selectPluginRepo({ entries: await fetchCommunityPluginRegistry(), pluginId });
  if (registryRepo === undefined) {
    throw new Error(
      `Community plugin "${pluginId}" is not listed in Obsidian's community plugin registry, so its GitHub `
        + 'repository cannot be resolved. Pass an explicit `repo` (`owner/name`) on the injected plugin.'
    );
  }

  return registryRepo;
}

/* v8 ignore stop */
