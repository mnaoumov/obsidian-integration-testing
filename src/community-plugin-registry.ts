/**
 * @file
 *
 * Pure helpers for resolving a community plugin's **GitHub release assets** from
 * nothing but its plugin id — the id → repo lookup and the asset URL shapes.
 *
 * A plugin's built files never live in git: `.obsidian/plugins/*` is gitignored in
 * every fleet plugin repo, so a demo vault's injected community plugins exist on
 * exactly the machine that once opened that vault in Obsidian. To install them
 * headlessly (see `demo-vault-bootstrap.ts`) two things must be derivable:
 *
 * - **Which repo publishes the id.** Obsidian's own registry —
 *   {@link COMMUNITY_PLUGINS_REGISTRY_URL}, served from the same
 *   `obsidianmd/obsidian-releases` repository the installer downloader already
 *   uses — maps every community plugin's `id` to its `owner/name` repo. That is
 *   the same table the in-app community browser installs from, so no
 *   plugin-specific mapping has to be hardcoded here.
 * - **Where that repo's assets live.** A plugin release publishes `manifest.json`,
 *   `main.js` and (optionally) `styles.css` as release assets;
 *   {@link buildPluginAssetUrl} builds the URL for one, for either the latest
 *   release or a pinned tag.
 *
 * Everything decidable without the network lives here so it stays unit-tested; the
 * fetching and writing sit in `demo-vault-bootstrap.ts`, mirroring the
 * `installer-asset.ts` / `obsidian-installer.ts` split.
 */

/**
 * Obsidian's own community plugin registry: the `id` → `repo` table the in-app
 * community browser installs from, served from the `obsidianmd/obsidian-releases`
 * repository.
 */
export const COMMUNITY_PLUGINS_REGISTRY_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';

/**
 * The `main.js` / `manifest.json` pair every plugin release must publish for the
 * plugin to be loadable — the same two files `buildDemoVaultPopulate` requires on
 * disk.
 */
export const REQUIRED_PLUGIN_ASSET_NAMES = ['main.js', 'manifest.json'] as const;

/**
 * `styles.css` is published only by plugins that ship CSS, so a download of it is
 * allowed to 404 without failing the install.
 */
export const OPTIONAL_PLUGIN_ASSET_NAMES = ['styles.css'] as const;

/**
 * Parameters for {@link buildPluginAssetUrl}.
 */
export interface BuildPluginAssetUrlParams {
  /**
  The release asset's file name, e.g. `main.js`.
   */
  readonly assetName: string;

  /**
  The publishing GitHub repository, as `owner/name`.
   */
  readonly repo: string;

  /**
   * The release tag to download from. Omit for the repository's latest release —
   * which is what the in-app community browser installs.
   */
  readonly version?: string | undefined;
}

/**
 * One row of Obsidian's `community-plugins.json`, reduced to the fields the
 * bootstrap needs. The published rows carry `name`, `author` and `description`
 * too; they are deliberately not modelled.
 */
export interface CommunityPluginRegistryEntry {
  /**
  The plugin's id — its `.obsidian/plugins/<id>` folder name.
   */
  readonly id: string;

  /**
  The publishing GitHub repository, as `owner/name`.
   */
  readonly repo: string;
}

/**
 * Parameters for {@link selectPluginRepo}.
 */
export interface SelectPluginRepoParams {
  /**
  The registry rows, as published by {@link COMMUNITY_PLUGINS_REGISTRY_URL}.
   */
  readonly entries: readonly CommunityPluginRegistryEntry[];

  /**
  The plugin id to look up.
   */
  readonly pluginId: string;
}

/**
 * Builds the download URL for one asset of a plugin's GitHub release.
 *
 * GitHub serves two forms — a pinned `releases/download/<tag>/<asset>` and the
 * moving `releases/latest/download/<asset>` — so a pinned version and the default
 * "whatever is current" share one builder.
 *
 * @param params - The {@link BuildPluginAssetUrlParams}.
 * @returns The asset's download URL.
 */
export function buildPluginAssetUrl(params: BuildPluginAssetUrlParams): string {
  const { assetName, repo, version } = params;
  const releasePath = version === undefined ? 'latest/download' : `download/${version}`;
  return `https://github.com/${repo}/releases/${releasePath}/${assetName}`;
}

/**
 * Checks that a string has the `owner/name` shape a GitHub repository reference
 * needs, so a malformed override is rejected before it is spliced into a URL.
 *
 * @param repo - The candidate repository reference.
 * @returns Whether it is a well-formed `owner/name` pair.
 */
export function isValidRepoReference(repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo);
}

/**
 * Looks a plugin id up in Obsidian's community plugin registry.
 *
 * @param params - The {@link SelectPluginRepoParams}.
 * @returns The publishing `owner/name` repo, or `undefined` when the id is not a
 *   registered community plugin (a private or unlisted plugin, or a typo).
 */
export function selectPluginRepo(params: SelectPluginRepoParams): string | undefined {
  return params.entries.find((entry) => entry.id === params.pluginId)?.repo;
}
