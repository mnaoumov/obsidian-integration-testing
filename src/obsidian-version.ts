/**
 * @file
 *
 * Pure helpers for resolving Obsidian desktop version specifiers.
 *
 * A version specifier is either an explicit `x.y.z` string or one of the
 * channel aliases {@link PUBLIC_LATEST} / {@link CATALYST_LATEST}, which resolve
 * against Obsidian's published desktop releases manifest.
 *
 * The network call that fetches the manifest lives in the integration-time
 * version-switch module; everything here is pure and unit-tested.
 */

/**
 * Version specifier alias resolving to the latest **public** desktop release
 * (the manifest's `latestVersion`).
 */
export const PUBLIC_LATEST = 'public-latest';

/**
 * Version specifier alias resolving to the latest **catalyst** (early access /
 * insider) desktop release (the manifest's `beta.latestVersion`).
 */
export const CATALYST_LATEST = 'catalyst-latest';

/**
 * URL of Obsidian's desktop releases manifest (raw JSON).
 */
export const DESKTOP_RELEASES_MANIFEST_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json';

const EXPLICIT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const VERSION_SEGMENT_COUNT = 3;

/**
 * A version specifier resolved against a release channel.
 */
export interface ChannelVersionSpec {
  /** The channel to resolve against the manifest. */
  readonly channel: ReleaseChannel;

  /** Discriminant. */
  readonly kind: 'channel';
}

/**
 * The `beta` (catalyst) entry of {@link DesktopReleasesManifest}.
 */
export interface DesktopReleasesBeta {
  /** The latest catalyst version, e.g. `'1.13.1'`. */
  readonly latestVersion: string;
}

/**
 * The subset of Obsidian's `desktop-releases.json` this library reads.
 */
export interface DesktopReleasesManifest {
  /**
   * The latest catalyst (early access / insider) release, when present.
   */
  readonly beta?: DesktopReleasesBeta;

  /**
   * The latest public (stable) version, e.g. `'1.12.7'`.
   */
  readonly latestVersion: string;
}

/**
 * A version specifier naming a concrete `x.y.z` version.
 */
export interface ExplicitVersionSpec {
  /** Discriminant. */
  readonly kind: 'explicit';

  /** The concrete `x.y.z` version. */
  readonly version: string;
}

/**
 * A release channel resolved from a channel-alias specifier.
 *
 * - `public` — the latest stable release.
 * - `catalyst` — the latest early access / insider release.
 */
export type ReleaseChannel = 'catalyst' | 'public';

/**
 * The parsed form of a version specifier.
 *
 * - `explicit` — a concrete `x.y.z` version.
 * - `channel` — a channel alias to be resolved against the manifest.
 */
export type VersionSpec = ChannelVersionSpec | ExplicitVersionSpec;

/**
 * Compares two `x.y.z` version strings numerically, segment by segment.
 *
 * @param a - The first version.
 * @param b - The second version.
 * @returns A negative number if `a < b`, `0` if equal, a positive number if `a > b`.
 */
export function compareVersions(a: string, b: string): number {
  const aSegments = parseVersionSegments(a);
  const bSegments = parseVersionSegments(b);

  for (let i = 0; i < VERSION_SEGMENT_COUNT; i++) {
    const diff = (aSegments[i] ?? 0) - (bSegments[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

/**
 * Returns the user-data asar file name for a given version, matching the name
 * Obsidian itself uses when it downloads an update (`obsidian-<version>.asar`).
 *
 * @param version - A concrete `x.y.z` version.
 * @returns The asar file name.
 */
export function getVersionAsarFileName(version: string): string {
  return `obsidian-${version}.asar`;
}

/**
 * Parses a version specifier into either an explicit version or a channel alias.
 *
 * @param spec - The specifier: an `x.y.z` string, {@link PUBLIC_LATEST}, or {@link CATALYST_LATEST}.
 * @returns The parsed {@link VersionSpec}.
 * @throws Error if the specifier is neither a valid `x.y.z` version nor a known alias.
 */
export function parseVersionSpec(spec: string): VersionSpec {
  if (spec === PUBLIC_LATEST) {
    return { channel: 'public', kind: 'channel' };
  }

  if (spec === CATALYST_LATEST) {
    return { channel: 'catalyst', kind: 'channel' };
  }

  if (EXPLICIT_VERSION_PATTERN.test(spec)) {
    return { kind: 'explicit', version: spec };
  }

  throw new Error(
    `Invalid Obsidian version "${spec}". Expected an "x.y.z" version, "${PUBLIC_LATEST}", or "${CATALYST_LATEST}".`
  );
}

/**
 * Resolves a channel to a concrete version using a desktop releases manifest.
 *
 * @param manifest - The parsed manifest.
 * @param channel - The channel to resolve.
 * @returns The concrete `x.y.z` version for the channel.
 * @throws Error if the catalyst channel is requested but the manifest has no `beta` entry.
 */
export function resolveVersionFromManifest(manifest: DesktopReleasesManifest, channel: ReleaseChannel): string {
  if (channel === 'public') {
    return manifest.latestVersion;
  }

  if (!manifest.beta) {
    throw new Error('Desktop releases manifest has no catalyst (beta) release.');
  }

  return manifest.beta.latestVersion;
}

/**
 * Splits an `x.y.z` version into its numeric segments.
 *
 * @param version - The version string.
 * @returns The numeric segments.
 */
function parseVersionSegments(version: string): number[] {
  return version.split('.').map((segment) => Number.parseInt(segment, 10));
}
