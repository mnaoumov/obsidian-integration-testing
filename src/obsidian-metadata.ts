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
 * The concrete JS runtime versions an installer's Electron shell ships, read
 * empirically from `process.versions` by booting that installer over CDP (see
 * `scripts/collect-runtime-versions.ts`). Absent for versions not yet collected
 * (or that could not be booted). Electron bundles the same Node/V8/Chromium on
 * every OS for a given Electron version, so these are platform-invariant.
 */
export interface ObsidianRuntimeVersions {
  /** The bundled Chromium version, e.g. `'114.0.5735.289'`. */
  readonly chrome?: string;

  /** The bundled Electron version, e.g. `'25.8.1'`. */
  readonly electron?: string;

  /** The bundled Node.js version, e.g. `'18.15.0'`. */
  readonly node?: string;

  /** The bundled V8 version, e.g. `'11.4.183.23'`. */
  readonly v8?: string;
}

/**
 * The pre-resolved asset download URLs for a version, baked into `metadata.json`
 * from the upstream `obsidian-versions.json` catalog (see the `metadata.json`
 * section in `CLAUDE.md`).
 *
 * These are the exact URLs the version's assets are published at, so the
 * integration-time download paths can skip the GitHub release-API lookup and the
 * historical dot-vs-hyphen asset-name guessing. Only the assets this library
 * actually downloads are carried: the app `asar` and the x64 desktop installers.
 * A field is absent when the version publishes no such asset (e.g. a catalyst
 * build ships only the `asar`), in which case the caller falls back to its
 * hand-rolled resolution.
 */
export interface ObsidianVersionDownloads {
  /** The `obsidian-<version>.asar.gz` package URL. */
  readonly asar?: string;

  /** The macOS (universal) `.dmg` installer URL. */
  readonly dmg?: string;

  /** The Windows x64 `.exe` installer URL. */
  readonly exe?: string;

  /** The Linux x64 `.tar.gz` portable-build URL. */
  readonly tar?: string;
}

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
   * The pre-resolved asset download URLs for the version, baked from the
   * upstream `obsidian-versions.json` catalog. Absent for versions not present
   * in the catalog (the caller then falls back to hand-rolled resolution).
   */
  readonly downloads?: ObsidianVersionDownloads;

  /**
   * The highest ECMAScript edition (e.g. `'ES2022'`) fully supported by this
   * version's bundled Chromium, derived from {@link ObsidianRuntimeVersions.chrome}
   * (see `deriveEcmaScriptVersion`). Baked alongside {@link runtimeVersions}, so a
   * consumer pinning this installer knows offline which ES level a serialized
   * `evalInObsidian` closure may safely use. Absent when the version has no
   * collected runtime versions.
   */
  readonly ecmaScriptVersion?: string;

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

  /**
   * The concrete JS runtime versions this version's Electron shell ships, read
   * empirically from `process.versions`. Absent until collected (see
   * {@link ObsidianRuntimeVersions} and `scripts/collect-runtime-versions.ts`).
   */
  readonly runtimeVersions?: ObsidianRuntimeVersions;
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
