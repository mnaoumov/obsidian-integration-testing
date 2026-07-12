/**
 * @file
 *
 * Pure helpers for resolving which GitHub release asset is the desktop
 * **installer** for a given Obsidian version and platform.
 *
 * Obsidian changed its installer asset naming convention partway through its
 * history, so a version cannot be turned into an asset name by string
 * templating alone:
 *
 * - **Dot** separator on older releases: `Obsidian.<ver>.exe` (verified 0.14.5
 *   through 1.5.12), with a `-universal` infix on the macOS dmg
 *   (`Obsidian-<ver>-universal.dmg`).
 * - **Hyphen** separator on newer releases: `Obsidian-<ver>.exe`,
 *   `Obsidian-<ver>.dmg` (verified 1.6.7 onward; the transition is around 1.6.0).
 *
 * The integration-time downloader (`obsidian-installer.ts`) queries the
 * release's real asset list and picks the platform-correct one with
 * {@link selectInstallerAssetName}; if that network call is unavailable it
 * falls back to trying every {@link buildInstallerAssetNameCandidates} form.
 * Both helpers are pure so the separator/arch matrix stays unit-tested (the
 * downloader itself needs the network and is excluded from unit tests).
 *
 * Only the x64 installer is resolved — the extraction path is x64-only — so the
 * 32-bit / arm64 / all-users sibling assets are deliberately rejected.
 */

/**
 * The platform-specific shape of an Obsidian installer asset name.
 */
interface PlatformInstallerAssetShape {
  /** Leading token of the asset name: `Obsidian` (Windows/macOS) or `obsidian` (Linux). */
  readonly baseName: string;

  /** File extension without the leading dot, e.g. `exe`, `dmg`, `tar.gz`. */
  readonly extension: string;

  /**
   * Infixes permitted between the version and the extension for the primary
   * (non-arch) asset, e.g. `-universal` on the older macOS dmg. An empty array
   * means the version is immediately followed by the extension.
   */
  readonly optionalInfixes: readonly string[];
}

const WINDOWS_ASSET_SHAPE: PlatformInstallerAssetShape = {
  baseName: 'Obsidian',
  extension: 'exe',
  optionalInfixes: []
};

const MAC_ASSET_SHAPE: PlatformInstallerAssetShape = {
  baseName: 'Obsidian',
  extension: 'dmg',
  optionalInfixes: ['-universal']
};

const LINUX_ASSET_SHAPE: PlatformInstallerAssetShape = {
  baseName: 'obsidian',
  extension: 'tar.gz',
  optionalInfixes: []
};

/** Separator forms tried, hyphen (newer) first, when falling back to templated names. */
const ASSET_NAME_SEPARATORS = ['-', '.'] as const;

/**
 * Parameters for {@link buildInstallerAssetNameCandidates}.
 */
export interface BuildInstallerAssetNameCandidatesParams {
  /** The platform to build candidate names for. */
  readonly platform: NodeJS.Platform;

  /** The concrete `x.y.z` version. */
  readonly version: string;
}

/**
 * Parameters for {@link selectInstallerAssetName}.
 */
export interface SelectInstallerAssetNameParams {
  /** The release's asset names (e.g. from the GitHub release API). */
  readonly assetNames: readonly string[];

  /** The platform whose installer asset to select. */
  readonly platform: NodeJS.Platform;

  /** The concrete `x.y.z` version. */
  readonly version: string;
}

/**
 * Builds the fallback list of installer asset names to try when the release's
 * real asset list cannot be fetched, covering both separator forms (and, on
 * macOS, the `-universal` infix).
 *
 * @param params - The platform and version.
 * @returns Candidate asset names, hyphen-separated forms first.
 */
export function buildInstallerAssetNameCandidates(params: BuildInstallerAssetNameCandidatesParams): string[] {
  const shape = getPlatformAssetShape(params.platform);
  const infixes = shape.optionalInfixes.length > 0 ? ['', ...shape.optionalInfixes] : [''];
  const candidates: string[] = [];
  for (const separator of ASSET_NAME_SEPARATORS) {
    for (const infix of infixes) {
      candidates.push(`${shape.baseName}${separator}${params.version}${infix}.${shape.extension}`);
    }
  }
  return candidates;
}

/**
 * Selects the platform-correct x64 installer asset name from a release's asset
 * list, tolerating both the dot- and hyphen-separated naming conventions and
 * rejecting the 32-bit / arm64 / all-users sibling assets.
 *
 * @param params - The asset list, platform, and version.
 * @returns The matching asset name, or `undefined` if none matches (e.g. a
 *   catalyst release that ships no installer).
 */
export function selectInstallerAssetName(params: SelectInstallerAssetNameParams): string | undefined {
  const pattern = buildAssetNamePattern(getPlatformAssetShape(params.platform), params.version);
  return params.assetNames.find((name) => pattern.test(name));
}

/**
 * Builds an anchored regular expression matching the primary installer asset
 * for a platform shape and version, across both separator conventions.
 *
 * @param shape - The platform asset shape.
 * @param version - The concrete `x.y.z` version.
 * @returns The matching pattern.
 */
function buildAssetNamePattern(shape: PlatformInstallerAssetShape, version: string): RegExp {
  const infixGroup = shape.optionalInfixes.length > 0
    ? `(?:${shape.optionalInfixes.map(escapeRegExp).join('|')})?`
    : '';
  return new RegExp(
    `^${escapeRegExp(shape.baseName)}[.-]${escapeRegExp(version)}${infixGroup}\\.${escapeRegExp(shape.extension)}$`
  );
}

/**
 * Escapes a string for literal use inside a regular expression.
 *
 * @param value - The raw string.
 * @returns The escaped string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves the installer asset shape for a platform.
 *
 * @param platform - The Node.js platform identifier.
 * @returns The asset shape (Linux `.tar.gz` for any non-Windows/macOS platform).
 */
function getPlatformAssetShape(platform: NodeJS.Platform): PlatformInstallerAssetShape {
  if (platform === 'win32') {
    return WINDOWS_ASSET_SHAPE;
  }

  if (platform === 'darwin') {
    return MAC_ASSET_SHAPE;
  }

  return LINUX_ASSET_SHAPE;
}
