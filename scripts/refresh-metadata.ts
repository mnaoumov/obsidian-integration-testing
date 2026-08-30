/**
 * @file
 *
 * Build-step that refreshes the repo-root `metadata.json` catalog from Obsidian's
 * **own** publication endpoints. It deliberately depends on no third-party
 * catalog: this repo publishes `metadata.json` as a public runtime feed, so a
 * stalled upstream must not be able to freeze it.
 *
 * Three sources, each authoritative for a different part of an entry:
 *
 * - **The `obsidianmd/obsidian-releases` GitHub Releases API** → `downloads`. The
 *   release's real asset list is matched (never templated) by
 *   {@link selectReleaseDownloads}, so the historical dot-vs-hyphen installer
 *   rename needs no guessing and the 32-bit / arm64 / AppImage / deb / snap
 *   siblings are left behind.
 * - **`obsidian.md/changelog.xml`** → `changelogUrl` **and** `channel`. The feed
 *   is the authoritative publisher of every changelog page and the only place
 *   Obsidian states a release's channel, so this script owns both fields for
 *   every version the feed knows.
 * - **`desktop-releases.json`** → `minRecommendedInstallerVersion`, captured for
 *   the current public and catalyst releases. **Additive only** — it never
 *   overwrites a recorded value, because the historical floors were measured
 *   here and cannot be rebuilt from a live endpoint that only ever reports the
 *   latest.
 *
 * Catalyst asars are the one asset with no listing behind them (they are served
 * from `releases.obsidian.md`, not GitHub), so a version the feed knows but
 * GitHub has no release for gets its URL constructed by
 * {@link buildCatalystAsarUrl} and **probed** before it is recorded.
 *
 * Our own empirically-measured fields — `minRunnableInstallerVersion`,
 * `minRecommendedElectronVersion`, `available`, `runtimeVersions` /
 * `ecmaScriptVersion` (see `scripts/collect-runtime-versions.ts`) — are never
 * touched.
 *
 * The output is byte-stable: rerunning against unchanged sources produces no
 * diff, so it doubles as a "is our catalog current?" check. Run it, then commit
 * the updated `metadata.json`.
 */

import process from 'node:process';

import type { ObsidianVersionChangelogUrls } from '../src/obsidian-metadata.ts';
import type { MetadataTable } from './helpers/metadata-io.ts';

import { DESKTOP_RELEASES_MANIFEST_URL } from '../src/obsidian-version.ts';
import {
  buildCatalystAsarUrl,
  resolveReleaseChannel,
  selectReleaseDownloads
} from '../src/release-catalog.ts';
import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import {
  readMetadataTable,
  writeMetadataTable
} from './helpers/metadata-io.ts';

exitIfScriptDisabled();

/**
The subset of Obsidian's `desktop-releases.json` this script reads.
*/
interface DesktopReleasesFloors extends DesktopReleasesLine {
  /**
  The catalyst (early access) line, carrying its own latest version and floor.
   */
  readonly beta?: DesktopReleasesLine;
}

/**
One release line of `desktop-releases.json`: its latest version and that version's
recommended installer floor.
*/
interface DesktopReleasesLine {
  readonly latestVersion?: string;
  readonly minimumVersion?: string;
}

/**
The subset of a GitHub release this script reads.
*/
interface GitHubRelease {
  readonly assets: readonly GitHubReleaseAsset[];
  readonly tag_name: string;
}

/**
The subset of a GitHub release asset this script reads.
*/
interface GitHubReleaseAsset {
  readonly browser_download_url: string;
  readonly name: string;
}

/**
A catalyst asar URL the CDN was confirmed to serve, and the version it belongs to.
*/
interface PublishedCatalystAsar {
  readonly asar: string;
  readonly version: string;
}

/**
How many versions {@link mergeReleaseDownloads} touched, plus the public-channel
evidence {@link mergeChangelogAndChannel} needs.
*/
interface ReleaseDownloadsMergeResult {
  readonly added: number;
  readonly publiclyReleasedVersions: ReadonlySet<string>;
  readonly updated: number;
}

const CHANGELOG_FEED_URL = 'https://obsidian.md/changelog.xml';

/**
 * Browser `User-Agent` used when probing `releases.obsidian.md`, which is
 * Cloudflare-gated against non-browser clients. Matches the UA the download path
 * (`obsidian-version-switch.ts`) already sends.
 */
const CATALYST_PROBE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.183 Safari/537.36';

/**
 * Matches one `<entry>` element of the Atom changelog feed.
 */
const FEED_ENTRY_PATTERN = /<entry>(?<entryXml>[\s\S]*?)<\/entry>/g;

/**
 * Matches an entry's canonical link, whose slug carries the publication date,
 * the platform and the version: `/changelog/<date>-<platform>-v<version>/`.
 */
const FEED_LINK_PATTERN = /<link href="(?<url>https:\/\/obsidian\.md\/changelog\/\d{4}-\d{2}-\d{2}-(?<platform>desktop|mobile)-v(?<version>[^/"]+)\/)"\s*\/>/;

/**
 * Matches an entry's title, whose trailing parenthetical is the release channel
 * (the only place the feed states it).
 */
const FEED_TITLE_PATTERN = /<title>[^<]*\((?<channel>Public|Early access)\)<\/title>/;

const RELEASES_API_URL = 'https://api.github.com/repos/obsidianmd/obsidian-releases/releases';

const RELEASES_PER_PAGE = 100;

/**
 * Fetches the raw Atom changelog feed.
 *
 * @returns The feed XML.
 * @throws Error if the feed cannot be fetched.
 */
async function fetchChangelogFeed(): Promise<string> {
  const response = await fetch(CHANGELOG_FEED_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch changelog.xml: HTTP ${String(response.status)}`);
  }
  return await response.text();
}

/**
 * Fetches Obsidian's `desktop-releases.json` manifest.
 *
 * @returns The parsed manifest.
 * @throws Error if the manifest cannot be fetched.
 */
async function fetchDesktopReleasesFloors(): Promise<DesktopReleasesFloors> {
  const response = await fetch(DESKTOP_RELEASES_MANIFEST_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch desktop-releases.json: HTTP ${String(response.status)}`);
  }
  return await response.json() as DesktopReleasesFloors;
}

/**
 * Fetches every release of `obsidianmd/obsidian-releases`, following pagination.
 *
 * Each release object already carries its full asset list, so the whole history
 * costs a couple of requests. `GITHUB_TOKEN` is used when present — the
 * anonymous quota 403s on shared CI runner IPs.
 *
 * @returns Every release, newest first.
 * @throws Error if a page cannot be fetched.
 */
async function fetchGitHubReleases(): Promise<GitHubRelease[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }

  const releases: GitHubRelease[] = [];
  let page = 1;
  let pageReleases: GitHubRelease[];
  do {
    const response = await fetch(`${RELEASES_API_URL}?per_page=${String(RELEASES_PER_PAGE)}&page=${String(page)}`, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch releases page ${String(page)}: HTTP ${String(response.status)}`);
    }

    pageReleases = await response.json() as GitHubRelease[];
    releases.push(...pageReleases);
    page++;
  } while (pageReleases.length === RELEASES_PER_PAGE);

  return releases;
}

/**
 * Probes whether a constructed catalyst asar URL actually serves a build.
 *
 * **A `200` is not enough.** For a version it does not host the CDN answers
 * `200` with `content-length: 0` — measured 2026-08-30 on `0.0.3`, `0.1.0` and
 * `0.3.0`, all of which predate the catalyst channel — so a status-only check
 * invents download URLs for versions that have none. A real build is megabytes
 * (`1.4.8` is 8391125 bytes), so a non-empty body is the discriminator. The CDN
 * also returns a transient `502` at times, which this correctly reads as "not
 * proven" and leaves for a later run.
 *
 * @param url - The URL to probe.
 * @returns Whether the CDN serves an actual build there.
 */
async function isCatalystAsarPublished(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { 'user-agent': CATALYST_PROBE_USER_AGENT }, method: 'HEAD' });
    if (!response.ok) {
      return false;
    }

    return Number(response.headers.get('content-length') ?? '0') > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const [releases, feedXml, floors] = await Promise.all([
    fetchGitHubReleases(),
    fetchChangelogFeed(),
    fetchDesktopReleasesFloors()
  ]);
  const changelogUrlsByVersion = parseChangelogFeed(feedXml);
  const table = await readMetadataTable();

  const enriched = mergeReleaseDownloads(table, releases);
  const withChangelog = mergeChangelogAndChannel(table, changelogUrlsByVersion, enriched.publiclyReleasedVersions);
  const probed = await mergeCatalystAsars(table, Object.keys(changelogUrlsByVersion));
  const floored = mergeInstallerFloors(table, floors);

  await writeMetadataTable(table);

  console.log(
    `Refreshed metadata.json: set downloads on ${String(enriched.updated)} versions (added ${String(enriched.added)} new), `
      + `changelog/channel on ${String(withChangelog)}, probed ${String(probed)} catalyst asar(s), `
      + `recorded ${String(floored)} installer floor(s).`
  );
}

/**
 * Records the constructed asar URL for feed-known versions that GitHub publishes
 * no release for, probing each before it is recorded.
 *
 * Only versions with no `downloads` yet are probed, so a steady-state run makes
 * no requests at all.
 *
 * @param table - The catalog to mutate.
 * @param feedVersions - Every version the changelog feed knows.
 * @returns How many URLs were probed and recorded.
 */
async function mergeCatalystAsars(table: MetadataTable, feedVersions: readonly string[]): Promise<number> {
  // Every probe completes before anything is written back, so the table is never
  // Assigned from a snapshot taken before an await.
  const published: PublishedCatalystAsar[] = [];
  for (const version of feedVersions) {
    const existing = table[version];
    if (!existing || existing.downloads !== undefined) {
      continue;
    }

    const asar = buildCatalystAsarUrl(version);
    if (await isCatalystAsarPublished(asar)) {
      published.push({ asar, version });
    }
  }

  let probed = 0;
  for (const { asar, version } of published) {
    const existing = table[version];
    if (!existing) {
      continue;
    }

    table[version] = { ...existing, downloads: { asar } };
    probed++;
  }
  return probed;
}

/**
 * Rewrites `changelogUrl` and `channel` for every version the feed knows.
 *
 * `changelogUrl` is feed-owned: the feed is the authoritative publisher of every
 * changelog page. `channel` is derived from the feed's pages **plus** whether
 * GitHub published the release, because the feed's own `(Public)` /
 * `(Early access)` marker is unreliable for the pre-1.0 era — see
 * {@link resolveReleaseChannel}. Versions the feed has no page for keep whatever
 * they carry.
 *
 * @param table - The catalog to mutate.
 * @param changelogUrlsByVersion - The parsed feed.
 * @param publiclyReleasedVersions - Versions GitHub published a release asar for.
 * @returns How many versions were updated.
 */
function mergeChangelogAndChannel(
  table: MetadataTable,
  changelogUrlsByVersion: Record<string, ObsidianVersionChangelogUrls>,
  publiclyReleasedVersions: ReadonlySet<string>
): number {
  let updated = 0;
  for (const [version, existing] of Object.entries(table)) {
    const changelogUrl = changelogUrlsByVersion[version];
    if (!changelogUrl) {
      continue;
    }

    const channel = resolveReleaseChannel({
      hasCatalystPage: changelogUrl.desktopCatalyst !== undefined,
      hasPublicPage: changelogUrl.desktop !== undefined,
      hasPublicRelease: publiclyReleasedVersions.has(version)
    });
    table[version] = {
      ...existing,
      changelogUrl,
      ...(channel !== undefined && { channel })
    };
    updated++;
  }
  return updated;
}

/**
 * Records `minRecommendedInstallerVersion` for the current public and catalyst
 * releases from `desktop-releases.json`.
 *
 * **Additive only.** The manifest reports only the *latest* release's floor, so
 * this captures each new one as it ships; the historical values already in the
 * table were measured here and are never overwritten.
 *
 * @param table - The catalog to mutate.
 * @param floors - The parsed manifest.
 * @returns How many versions gained a floor.
 */
function mergeInstallerFloors(table: MetadataTable, floors: DesktopReleasesFloors): number {
  const candidates = [
    { minimumVersion: floors.minimumVersion, version: floors.latestVersion },
    { minimumVersion: floors.beta?.minimumVersion, version: floors.beta?.latestVersion }
  ];

  let recorded = 0;
  for (const { minimumVersion, version } of candidates) {
    if (version === undefined || minimumVersion === undefined) {
      continue;
    }

    const existing = table[version];
    if (!existing || existing.minRecommendedInstallerVersion !== undefined) {
      continue;
    }

    table[version] = { ...existing, minRecommendedInstallerVersion: minimumVersion };
    recorded++;
  }
  return recorded;
}

/**
 * Sets `downloads` from every GitHub release that publishes assets we carry.
 *
 * A release only *mints* a new catalog entry when it publishes a desktop `asar`:
 * the table is keyed by desktop app version, so a mobile-only release (an apk
 * and nothing else, e.g. `1.13.8`) must not create one. Such a release still
 * contributes its apk to an entry that already exists.
 *
 * @param table - The catalog to mutate.
 * @param releases - Every GitHub release.
 * @returns How many versions were updated, how many were newly added, and which
 *   versions GitHub published a release asar for (the public-channel evidence
 *   {@link mergeChangelogAndChannel} needs).
 */
function mergeReleaseDownloads(
  table: MetadataTable,
  releases: readonly GitHubRelease[]
): ReleaseDownloadsMergeResult {
  const publiclyReleasedVersions = new Set<string>();
  let added = 0;
  let updated = 0;
  for (const release of releases) {
    const version = release.tag_name.replace(/^v/, '');
    const downloads = selectReleaseDownloads({
      assets: release.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
      version
    });
    if (!downloads) {
      continue;
    }

    if (downloads.asar !== undefined) {
      publiclyReleasedVersions.add(version);
    }

    const existing = table[version];
    if (existing) {
      table[version] = { ...existing, downloads };
      updated++;
      continue;
    }

    if (downloads.asar === undefined) {
      continue;
    }

    table[version] = { channel: 'public', downloads };
    added++;
  }
  return { added, publiclyReleasedVersions, updated };
}

/**
 * Parses the Atom changelog feed into a version → per-target-URL map.
 *
 * The version and the platform are taken from the link **slug**, never from the
 * title: two entries carry a typo'd version in their title (`Obsidian 1.0.4
 * Mobile` links `…-mobile-v0.1.4/`; `Obsidian 0.6.0 Desktop` links
 * `…-desktop-v0.6.1/`), and trusting the title collapses those onto the wrong
 * key. Only the **channel** comes from the title, which is the sole place the
 * feed states it. Entries with no `-v<version>` slug (the Publish and Sync
 * changelogs) carry no version and are skipped.
 *
 * @param feedXml - The raw feed XML.
 * @returns The map, keyed by app version.
 */
function parseChangelogFeed(feedXml: string): Record<string, ObsidianVersionChangelogUrls> {
  const urlsByVersion: Record<string, Record<string, string>> = {};

  for (const entryMatch of feedXml.matchAll(FEED_ENTRY_PATTERN)) {
    const entryXml = entryMatch.groups?.['entryXml'] ?? '';
    const link = FEED_LINK_PATTERN.exec(entryXml)?.groups;
    const title = FEED_TITLE_PATTERN.exec(entryXml)?.groups;
    const url = link?.['url'];
    const platform = link?.['platform'];
    const version = link?.['version'];
    const channel = title?.['channel'];
    if (url === undefined || platform === undefined || version === undefined || channel === undefined) {
      continue;
    }

    const target = channel === 'Early access' ? `${platform}Catalyst` : platform;
    const urls = urlsByVersion[version] ?? {};
    urls[target] = url;
    urlsByVersion[version] = urls;
  }

  return Object.fromEntries(
    Object.entries(urlsByVersion).map(([version, urls]) => [version, sortChangelogUrls(urls)])
  );
}

/**
 * Re-keys one version's target → URL map into a fixed key order, so the
 * serialized catalog stays byte-stable regardless of feed entry order.
 *
 * @param urls - The target → URL map for one version.
 * @returns The same URLs in canonical key order.
 */
function sortChangelogUrls(urls: Record<string, string>): ObsidianVersionChangelogUrls {
  const sorted: Record<string, string> = {};
  for (const target of ['desktop', 'desktopCatalyst', 'mobile', 'mobileCatalyst'] as const) {
    const url = urls[target];
    if (url !== undefined) {
      sorted[target] = url;
    }
  }
  return sorted;
}

await main();
