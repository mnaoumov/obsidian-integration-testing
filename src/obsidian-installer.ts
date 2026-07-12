/**
 * @file
 *
 * Integration-time helpers for resolving the Obsidian **shell** (the Electron
 * runtime / installer build) to launch.
 *
 * By default the harness uses the installed shell. When a specific installer
 * version is requested, it downloads that version's GitHub release asset and
 * extracts a portable shell into a cache, returning the executable to launch.
 *
 * GitHub release assets exist for **public** releases only; catalyst (beta)
 * builds publish only the asar, so installer-pinning supports public versions.
 * The extracted shell's bundled `resources/obsidian.asar` is that version, so
 * pinning the installer is how you run a version **older** than the installed
 * shell (asar-swap is upgrade-only — see `obsidian-version-switch.ts`).
 */

/* v8 ignore start -- Integration-time download/extraction glue covered by integration tests, not unit tests. */

import {
  execFileSync,
  spawnSync
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join
} from 'node:path';
import process from 'node:process';

import {
  buildInstallerAssetNameCandidates,
  selectInstallerAssetName
} from './installer-asset.ts';
import { log } from './log.ts';

/**
 * Browser User-Agent for downloading release assets (Cloudflare-gated).
 */
const DOWNLOAD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.183 Safari/537.36';

/** Base URL for `obsidian-releases` release assets (`.../download/v<ver>/<asset>`). */
const RELEASE_DOWNLOAD_BASE_URL = 'https://github.com/obsidianmd/obsidian-releases/releases/download';

/** GitHub REST endpoint listing a release's assets by tag (`.../releases/tags/v<ver>`). */
const RELEASE_API_TAG_URL = 'https://api.github.com/repos/obsidianmd/obsidian-releases/releases/tags';

/** The subset of the GitHub release API response this module reads. */
interface GitHubRelease {
  /** The release's downloadable assets. */
  readonly assets: readonly GitHubReleaseAsset[];
}

/** The subset of a GitHub release's asset object this module reads. */
interface GitHubReleaseAsset {
  /** The asset file name, e.g. `Obsidian.0.14.5.exe`. */
  readonly name: string;
}

const CACHE_ROOT = join(tmpdir(), 'obsidian-integration-testing');
const SHELL_CACHE_DIR = join(CACHE_ROOT, 'shell-cache');
const MAC_PLIST_VERSION_PATTERN = /<key>CFBundleShortVersionString<\/key>\s*<string>(?<version>[^<]+)<\/string>/;

/**
 * A resolved Obsidian shell executable.
 */
export interface ResolvedShell {
  /** Absolute path to the Obsidian executable to launch. */
  readonly exePath: string;

  /** The shell's version, or `undefined` if it could not be detected. */
  readonly version: string | undefined;
}

/**
 * Detects the version of an installed Obsidian shell from its executable.
 *
 * - Windows: the executable's PE `FileVersion`.
 * - macOS: `CFBundleShortVersionString` from the app bundle's `Info.plist`.
 * - Linux: best-effort parse from the executable path (often `undefined`).
 *
 * @param exePath - Absolute path to the Obsidian executable.
 * @returns The `x.y.z` version, or `undefined` if it cannot be determined.
 */
export function detectInstalledShellVersion(exePath: string): string | undefined {
  if (process.platform === 'win32') {
    return detectWindowsFileVersion(exePath);
  }

  if (process.platform === 'darwin') {
    return detectMacBundleVersion(exePath);
  }

  return detectVersionFromPath(exePath);
}

/**
 * Ensures a portable Obsidian shell for the given version is extracted into the
 * cache, downloading and extracting its GitHub release asset if necessary.
 *
 * @param version - A concrete public `x.y.z` version.
 * @returns The absolute path to the cached shell executable.
 * @throws Error if the asset cannot be downloaded or extracted.
 */
export async function ensureShellCached(version: string): Promise<string> {
  const shellDir = getCachedShellDir(version);
  const exePath = getCachedShellExePath(shellDir);
  if (existsSync(exePath)) {
    log(`[installer] Using cached shell for ${version}.`);
    return exePath;
  }

  mkdirSync(shellDir, { recursive: true });
  const assetUrls = await resolveInstallerAssetUrls(version);
  const assetPath = await downloadInstallerAsset(assetUrls, shellDir, version);
  extractShell(assetPath, shellDir);
  rmSync(assetPath, { force: true });

  if (!existsSync(exePath)) {
    throw new Error(`Extracted Obsidian shell ${version} but executable not found at ${exePath}.`);
  }
  log(`[installer] Extracted shell ${version} -> ${exePath}`);
  return exePath;
}

/**
 * Returns the cache directory a version's extracted shell lives in (the
 * directory may not yet exist).
 *
 * @param version - A concrete public `x.y.z` version.
 * @returns The absolute shell cache directory for the version.
 */
export function getCachedShellDir(version: string): string {
  return join(SHELL_CACHE_DIR, version);
}

/**
 * Throws a descriptive error if a required command is not on `PATH`.
 *
 * @param command - The command name.
 * @param hint - Actionable guidance appended to the error.
 */
function assertCommandAvailable(command: string, hint: string): void {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(probe, [command], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(`Required command "${command}" was not found on PATH. ${hint}`);
  }
}

/**
 * Reads `CFBundleShortVersionString` from a macOS app bundle's `Info.plist`.
 *
 * @param exePath - Path to `.../Obsidian.app/Contents/MacOS/Obsidian`.
 * @returns The `x.y.z` version, or `undefined`.
 */
function detectMacBundleVersion(exePath: string): string | undefined {
  try {
    const contentsDir = dirname(dirname(exePath));
    const plist = readFileSync(join(contentsDir, 'Info.plist'), 'utf-8');
    const match = MAC_PLIST_VERSION_PATTERN.exec(plist);
    return match?.groups?.['version'];
  } catch {
    return undefined;
  }
}

/**
 * Best-effort parse of an `x.y.z` version embedded in a path.
 *
 * @param value - The path or string to scan.
 * @returns The first `x.y.z` match, or `undefined`.
 */
function detectVersionFromPath(value: string): string | undefined {
  const match = /(?<version>\d+\.\d+\.\d+)/.exec(value);
  return match?.groups?.['version'];
}

/**
 * Reads the PE `FileVersion` of a Windows executable via PowerShell.
 *
 * @param exePath - Absolute path to the executable.
 * @returns The `x.y.z` version, or `undefined`.
 */
function detectWindowsFileVersion(exePath: string): string | undefined {
  try {
    const output = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item -LiteralPath ${JSON.stringify(exePath)}).VersionInfo.FileVersion`],
      { encoding: 'utf-8' }
    );
    const version = output.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Downloads a single release asset for a version to a destination file.
 *
 * @param url - The asset download URL.
 * @param dest - Destination file path.
 * @throws Error if the request fails.
 */
async function downloadAsset(url: string, dest: string): Promise<void> {
  log(`[installer] Downloading installer from ${url} ...`);
  const response = await fetch(url, { headers: { 'User-Agent': DOWNLOAD_USER_AGENT } });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

/**
 * Downloads the first reachable installer asset from an ordered list of
 * candidate URLs, returning the path it was saved to.
 *
 * @param urls - Candidate asset URLs, in priority order.
 * @param shellDir - The destination shell directory.
 * @param version - The release version (for error messages).
 * @returns The downloaded asset's path.
 * @throws Error if none of the candidates can be downloaded.
 */
async function downloadInstallerAsset(urls: string[], shellDir: string, version: string): Promise<string> {
  const errors: string[] = [];
  for (const url of urls) {
    const assetPath = join(shellDir, basename(url));
    try {
      await downloadAsset(url, assetPath);
      return assetPath;
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Failed to download Obsidian installer ${version}. Attempts: ${errors.join('; ')}. `
      + 'Catalyst/beta versions have no public installer — pin an asar version on a public/installed shell instead.'
  );
}

/**
 * Extracts a Linux `.tar.gz` portable build.
 *
 * @param assetPath - Path to the downloaded `.tar.gz`.
 * @param shellDir - Destination shell directory.
 */
function extractLinuxShell(assetPath: string, shellDir: string): void {
  run('tar', ['xzf', assetPath, '-C', shellDir, '--strip-components=1']);
}

/**
 * Extracts a macOS `.dmg` by mounting it and copying the app bundle.
 *
 * @param assetPath - Path to the downloaded `.dmg`.
 * @param shellDir - Destination shell directory.
 */
function extractMacShell(assetPath: string, shellDir: string): void {
  const mountPoint = join(shellDir, '__mnt');
  mkdirSync(mountPoint, { recursive: true });
  run('hdiutil', ['attach', '-nobrowse', '-mountpoint', mountPoint, assetPath]);
  try {
    run('cp', ['-R', join(mountPoint, 'Obsidian.app'), shellDir]);
  } finally {
    run('hdiutil', ['detach', mountPoint]);
  }
  rmSync(mountPoint, { force: true, recursive: true });
}

/**
 * Extracts a downloaded installer asset into a shell directory, per platform.
 *
 * @param assetPath - The downloaded asset path.
 * @param shellDir - The destination shell directory.
 */
function extractShell(assetPath: string, shellDir: string): void {
  if (process.platform === 'win32') {
    extractWindowsShell(assetPath, shellDir);
    return;
  }

  if (process.platform === 'darwin') {
    extractMacShell(assetPath, shellDir);
    return;
  }

  extractLinuxShell(assetPath, shellDir);
}

/**
 * Extracts a Windows NSIS installer's inner app payload via 7-Zip.
 *
 * The NSIS installer `.exe` contains `$PLUGINSDIR/app-64.7z`, which holds the
 * portable app (mirrors how the scoop manifest installs Obsidian).
 *
 * @param assetPath - Path to the downloaded `.exe`.
 * @param shellDir - Destination shell directory.
 */
function extractWindowsShell(assetPath: string, shellDir: string): void {
  assertCommandAvailable('7z', 'Install 7-Zip (e.g. `scoop install 7zip`) to extract a pinned Obsidian installer.');
  const nsisExtractDir = join(shellDir, '__nsis');
  run('7z', ['x', '-y', `-o${nsisExtractDir}`, assetPath]);
  const innerArchive = join(nsisExtractDir, '$PLUGINSDIR', 'app-64.7z');
  run('7z', ['x', '-y', `-o${shellDir}`, innerArchive]);
  rmSync(nsisExtractDir, { force: true, recursive: true });
}

/**
 * Fetches a release's asset names from the GitHub API.
 *
 * @param version - The release version (tag `v<version>`).
 * @returns The asset names, or `undefined` if the API is unavailable.
 */
async function fetchReleaseAssetNames(version: string): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${RELEASE_API_TAG_URL}/v${version}`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': DOWNLOAD_USER_AGENT }
    });
    if (!response.ok) {
      log(`[installer] Release API for ${version} returned HTTP ${String(response.status)}; falling back to templated asset names.`);
      return undefined;
    }
    const release = await response.json() as GitHubRelease;
    return release.assets.map((asset) => asset.name);
  } catch (error) {
    log(`[installer] Release API for ${version} unavailable (${error instanceof Error ? error.message : String(error)}); falling back to templated asset names.`);
    return undefined;
  }
}

/**
 * Returns the expected cached shell executable path for the current platform.
 *
 * @param shellDir - The shell cache directory for a version.
 * @returns The executable path.
 */
function getCachedShellExePath(shellDir: string): string {
  if (process.platform === 'win32') {
    return join(shellDir, 'Obsidian.exe');
  }

  if (process.platform === 'darwin') {
    return join(shellDir, 'Obsidian.app', 'Contents', 'MacOS', 'Obsidian');
  }

  return join(shellDir, 'obsidian');
}

/**
 * Resolves the ordered installer asset download URLs to try for a version.
 *
 * The release's real asset list is queried first so the platform-correct asset
 * is picked regardless of the historical dot-vs-hyphen naming; if that call is
 * unavailable it falls back to trying both templated separator forms.
 *
 * @param version - The concrete `x.y.z` version.
 * @returns Candidate asset URLs, in priority order.
 */
async function resolveInstallerAssetUrls(version: string): Promise<string[]> {
  const assetNames = await fetchReleaseAssetNames(version);
  if (assetNames) {
    const selected = selectInstallerAssetName({ assetNames, platform: process.platform, version });
    if (selected !== undefined) {
      return [`${RELEASE_DOWNLOAD_BASE_URL}/v${version}/${selected}`];
    }
    log(`[installer] No installer asset matched for ${version}; falling back to templated asset names.`);
  }

  return buildInstallerAssetNameCandidates({ platform: process.platform, version })
    .map((name) => `${RELEASE_DOWNLOAD_BASE_URL}/v${version}/${name}`);
}

/**
 * Runs a command synchronously, throwing on a non-zero exit.
 *
 * @param command - The command.
 * @param args - The arguments.
 */
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.map((arg) => basename(arg)).join(' ')} (exit ${String(result.status)})`);
  }
}

/* v8 ignore stop */
