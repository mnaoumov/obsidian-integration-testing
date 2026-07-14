/**
 * @file
 *
 * Typed access to the repo-root `metadata.json` — the per-Obsidian-app-version
 * data table precomputed in this repo (installer-floor / recommended-installer /
 * recommended-Electron thresholds; see the `metadata.json` section in
 * `CLAUDE.md`). This is the single module that reads the raw table; everything
 * else consumes it through {@link getVersionMetadata} against the
 * {@link ObsidianVersionMetadata} shape, so the raw table stays internal and the
 * public surface is a typed lookup.
 *
 * The table is injected at build time by esbuild's `define` (and at test time by
 * Vitest's `define`) — the `OBSIDIAN_METADATA` global is replaced with the parsed
 * contents of `metadata.json`. This mirrors how `OBSIDIAN_INTEGRATION_TESTING_VERSION`
 * is injected, and keeps the built library self-contained (the table is inlined
 * into the output, with no runtime file read and no `bundle`-time JSON import that
 * `bundle: false` cannot inline).
 */

/**
 * The subset of a `metadata.json` per-version entry this library reads.
 *
 * Every field is optional — an entry carries only the thresholds that apply to
 * that version (e.g. only old versions carry {@link minRecommendedInstallerVersion}).
 */
export interface ObsidianVersionMetadata {
  /** Whether the version's assets are available (present only when `false`). */
  readonly available?: boolean;

  /** URL of the version's changelog. */
  readonly changelogUrl?: string;

  /** The release channel: `'public'`, `'catalyst'`, or `'public+catalyst'`. */
  readonly channel?: string;

  /**
   * The app's hardcoded required-minimum Electron version (e.g. `'28.2.3'`). An
   * Electron version, not an installer version — comparing against it needs the
   * installer's bundled Electron, which is not derivable offline.
   */
  readonly minRecommendedElectronVersion?: string;

  /**
   * The recommended-minimum installer version (Obsidian's own "installer too old,
   * reinstall" guidance). Present only on older versions.
   */
  readonly minRecommendedInstallerVersion?: string;

  /**
   * The empirically-measured run floor: the oldest installer version whose
   * Electron shell can actually boot this app version's asar. Below it the
   * renderer dead-boots.
   */
  readonly minRunnableInstallerVersion?: string;
}

/**
 * The `metadata.json` table, keyed by concrete `x.y.z` app version.
 */
type ObsidianMetadataTable = Readonly<Record<string, ObsidianVersionMetadata>>;

const METADATA_TABLE: ObsidianMetadataTable = OBSIDIAN_METADATA;

/**
 * Looks up the metadata entry for a concrete Obsidian app version.
 *
 * @param version - A concrete `x.y.z` app version.
 * @returns The entry, or `undefined` when the version is absent from the table.
 */
export function getVersionMetadata(version: string): ObsidianVersionMetadata | undefined {
  return METADATA_TABLE[version];
}

declare const OBSIDIAN_METADATA: ObsidianMetadataTable;
