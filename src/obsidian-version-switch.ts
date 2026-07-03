/**
 * @file
 *
 * Integration-time helpers for provisioning a specific Obsidian **asar** (the
 * app code) into an isolated user-data dir.
 *
 * Obsidian's bootstrap loads the highest of (its shell's bundled
 * `resources/obsidian.asar`, the `obsidian-<version>.asar` files in the
 * user-data dir). So placing an asar here only takes effect when its version is
 * **>= the shell's bundled version** (upgrade-only — confirmed by the Phase 0
 * spike). Running an older version requires pinning the installer/shell instead
 * (see `obsidian-installer.ts`).
 */

/* v8 ignore start -- Integration-time download/filesystem glue covered by integration tests, not unit tests. */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { DesktopReleasesManifest } from './obsidian-version.ts';

import { log } from './log.ts';
import {
  compareVersions,
  DESKTOP_RELEASES_MANIFEST_URL,
  getVersionAsarFileName,
  parseVersionSpec,
  resolveVersionFromManifest
} from './obsidian-version.ts';

/**
 * Browser User-Agent required to fetch asar packages from
 * `releases.obsidian.md` (the endpoint is Cloudflare-gated against non-browser
 * clients). Matches the UA documented in the obsidian-versions repo.
 */
const DOWNLOAD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.183 Safari/537.36';

/**
 * Base URL for **public** (stable) release asars, published as GitHub release
 * assets under `.../download/v<version>/obsidian-<version>.asar.gz`.
 */
const PUBLIC_ASAR_RELEASE_BASE_URL = 'https://github.com/obsidianmd/obsidian-releases/releases/download';

/**
 * Base URL for **catalyst** (early access / insider) release asars, served from
 * the Obsidian CDN as `.../release/obsidian-<version>.asar.gz`. Public versions
 * are NOT hosted here (the CDN returns an empty body for them).
 */
const CATALYST_ASAR_RELEASE_BASE_URL = 'https://releases.obsidian.md/release';

const CACHE_ROOT = join(tmpdir(), 'obsidian-integration-testing');
const ASAR_CACHE_DIR = join(CACHE_ROOT, 'asar-cache');
const ASAR_FILE_PATTERN = /^obsidian-(?<version>\d+\.\d+\.\d+)\.asar$/;

/**
 * A discovered `obsidian-<version>.asar` file.
 */
export interface DiscoveredAsar {
  /** Absolute path to the asar file. */
  readonly path: string;

  /** The `x.y.z` version parsed from the file name. */
  readonly version: string;
}

/**
 * Copies an asar file into a user-data dir under its canonical
 * `obsidian-<version>.asar` name.
 *
 * @param asarPath - Source asar path.
 * @param version - The asar's version (used for the destination file name).
 * @param userDataDir - Destination user-data dir.
 */
export function copyAsarIntoUserData(asarPath: string, version: string, userDataDir: string): void {
  mkdirSync(userDataDir, { recursive: true });
  const dest = join(userDataDir, getVersionAsarFileName(version));
  copyFileSync(asarPath, dest);
  log(`[version-switch] Provisioned ${getVersionAsarFileName(version)} into ${userDataDir}.`);
}

/**
 * Ensures the asar for a concrete version is present in the local cache,
 * downloading and decompressing it if necessary.
 *
 * @param version - A concrete `x.y.z` version.
 * @returns The absolute path to the cached asar.
 * @throws Error if the download fails.
 */
export async function ensureAsarCached(version: string): Promise<string> {
  mkdirSync(ASAR_CACHE_DIR, { recursive: true });
  const cachedPath = getCachedAsarPath(version);
  if (existsSync(cachedPath)) {
    log(`[version-switch] Using cached asar for ${version}.`);
    return cachedPath;
  }

  // A version's asar.gz lives on exactly one host depending on its channel
  // (public → GitHub release assets, catalyst → the Obsidian CDN). The concrete
  // Version alone does not tell us which, so try both and use the first that
  // Returns a valid archive.
  const errors: string[] = [];
  for (const url of getAsarDownloadUrls(version)) {
    try {
      const asar = await downloadAndDecompressAsar(url);
      writeFileSync(cachedPath, asar);
      log(`[version-switch] Cached asar ${version} (${String(asar.length)} bytes) -> ${cachedPath}`);
      return cachedPath;
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Failed to download Obsidian asar ${version}. Attempts: ${errors.join('; ')}`);
}

/**
 * Fetches and parses Obsidian's desktop releases manifest.
 *
 * @returns The parsed manifest.
 * @throws Error if the manifest cannot be fetched.
 */
export async function fetchDesktopReleasesManifest(): Promise<DesktopReleasesManifest> {
  const response = await fetch(DESKTOP_RELEASES_MANIFEST_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch desktop releases manifest: HTTP ${String(response.status)}`);
  }
  return await response.json() as DesktopReleasesManifest;
}

/**
 * Finds the newest `obsidian-<version>.asar` in a directory.
 *
 * @param dir - The directory to scan (e.g. the user's Obsidian config dir).
 * @returns The newest discovered asar, or `undefined` if none / the dir is unreadable.
 */
export function findNewestAsar(dir: string): DiscoveredAsar | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }

  let newest: DiscoveredAsar | undefined;
  for (const entry of entries) {
    const match = ASAR_FILE_PATTERN.exec(entry);
    if (!match) {
      continue;
    }
    const version = match.groups?.['version'] ?? '';
    if (!newest || compareVersions(version, newest.version) > 0) {
      newest = { path: join(dir, entry), version };
    }
  }
  return newest;
}

/**
 * Returns the local cache path for a concrete version's asar (the file may not
 * yet exist).
 *
 * @param version - A concrete `x.y.z` version.
 * @returns The absolute path the asar is cached at.
 */
export function getCachedAsarPath(version: string): string {
  return join(ASAR_CACHE_DIR, getVersionAsarFileName(version));
}

/**
 * Resolves a version specifier (explicit or channel alias) to a concrete
 * `x.y.z` version, fetching the manifest only when a channel alias is used.
 *
 * @param spec - The version specifier.
 * @returns The concrete version.
 */
export async function resolveConcreteVersion(spec: string): Promise<string> {
  const parsed = parseVersionSpec(spec);
  if (parsed.kind === 'explicit') {
    return parsed.version;
  }
  const manifest = await fetchDesktopReleasesManifest();
  return resolveVersionFromManifest(manifest, parsed.channel);
}

/**
 * Downloads a gzip-compressed asar from a URL and decompresses it.
 *
 * @param url - The `.asar.gz` URL.
 * @returns The decompressed asar bytes.
 * @throws Error if the request fails, the body is empty, or decompression fails.
 */
async function downloadAndDecompressAsar(url: string): Promise<Buffer> {
  log(`[version-switch] Downloading asar from ${url} ...`);
  const response = await fetch(url, { headers: { 'User-Agent': DOWNLOAD_USER_AGENT } });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }

  const gz = Buffer.from(await response.arrayBuffer());
  if (gz.length === 0) {
    throw new Error('empty response body');
  }
  return gunzipSync(gz);
}

/**
 * Returns the candidate `.asar.gz` download URLs for a concrete version, public
 * (GitHub) first, then catalyst (CDN).
 *
 * @param version - A concrete `x.y.z` version.
 * @returns The URLs to try, in order.
 */
function getAsarDownloadUrls(version: string): string[] {
  const asarGzFileName = `${getVersionAsarFileName(version)}.gz`;
  return [
    `${PUBLIC_ASAR_RELEASE_BASE_URL}/v${version}/${asarGzFileName}`,
    `${CATALYST_ASAR_RELEASE_BASE_URL}/${asarGzFileName}`
  ];
}

/* v8 ignore stop */
