/**
 * @file
 *
 * Build-step that refreshes the repo-root `metadata.json` catalog from the two
 * upstream sources it tracks: the per-version asset download URLs published by
 * `obsidian-versions.json` (`jesse-r-s-hines/wdio-obsidian-service`), and the
 * per-target changelog page URLs published by Obsidian's own changelog feed
 * (`obsidian.md/changelog.xml`).
 *
 * The download merge is **additive-only**: it sets the `downloads` field (app
 * `asar`, x64 desktop installers, Android `apk`) on each version and adds any
 * version missing from our table, but it NEVER overwrites our own `channel` /
 * `min*` compatibility fields — those are empirically measured here (see
 * `CLAUDE.md` L20) and stay authoritative.
 *
 * `changelogUrl` is the one field this script **owns**: the feed is the
 * authoritative publisher of every changelog page, so each catalogued version
 * the feed knows has its whole `changelogUrl` object rewritten from it. Versions
 * the feed never published a page for keep whatever they carry. Run it, then
 * commit the updated `metadata.json`.
 *
 * The output is byte-stable: rerunning against unchanged sources produces no
 * diff, so it doubles as a "is our catalog current?" check.
 */

import type {
  ObsidianVersionChangelogUrls,
  ObsidianVersionDownloads
} from '../src/obsidian-metadata.ts';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import {
  readMetadataTable,
  writeMetadataTable
} from './helpers/metadata-io.ts';

exitIfScriptDisabled();

/**
The subset of the upstream `obsidian-versions.json` document we read.
*/
interface UpstreamCatalog {
  readonly versions: readonly UpstreamVersionEntry[];
}

/**
The subset of an upstream entry's `downloads` map we bake into our catalog.
*/
interface UpstreamDownloads {
  readonly apk?: string;
  readonly asar?: string;
  readonly dmg?: string;
  readonly exe?: string;
  readonly tar?: string;
}

/**
The subset of an upstream `obsidian-versions.json` version entry we read.
*/
interface UpstreamVersionEntry {
  readonly downloads?: UpstreamDownloads;
  readonly isBeta?: boolean;
  readonly version: string;
}

const CHANGELOG_FEED_URL = 'https://obsidian.md/changelog.xml';

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

const UPSTREAM_CATALOG_URL = 'https://raw.githubusercontent.com/jesse-r-s-hines/wdio-obsidian-service/HEAD/obsidian-versions.json';

/**
 * Picks only the asset URLs this library downloads (app asar, x64 desktop
 * installers, Android apk) from an upstream entry's `downloads` map.
 *
 * @param downloads - The upstream entry's `downloads` map.
 * @returns The distilled URLs, or `undefined` when the entry carries none.
 */
function distillDownloads(downloads: undefined | UpstreamDownloads): ObsidianVersionDownloads | undefined {
  if (!downloads) {
    return undefined;
  }

  const distilled: Record<string, string> = {};
  for (const key of ['apk', 'asar', 'dmg', 'exe', 'tar'] as const) {
    const url = downloads[key];
    if (url !== undefined) {
      distilled[key] = url;
    }
  }

  return Object.keys(distilled).length > 0 ? distilled : undefined;
}

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
 * Fetches and parses the upstream `obsidian-versions.json` catalog.
 *
 * @returns The parsed upstream catalog.
 * @throws Error if the catalog cannot be fetched.
 */
async function fetchUpstreamCatalog(): Promise<UpstreamCatalog> {
  const response = await fetch(UPSTREAM_CATALOG_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch upstream obsidian-versions.json: HTTP ${String(response.status)}`);
  }
  return await response.json() as UpstreamCatalog;
}

async function main(): Promise<void> {
  const [upstream, feedXml] = await Promise.all([fetchUpstreamCatalog(), fetchChangelogFeed()]);
  const changelogUrlsByVersion = parseChangelogFeed(feedXml);
  const table = await readMetadataTable();

  let enriched = 0;
  let added = 0;
  for (const entry of upstream.versions) {
    const downloads = distillDownloads(entry.downloads);
    if (!downloads) {
      continue;
    }

    const existing = table[entry.version];
    if (existing) {
      table[entry.version] = { ...existing, downloads };
      enriched++;
    } else {
      table[entry.version] = {
        channel: entry.isBeta ? 'catalyst' : 'public',
        downloads
      };
      added++;
    }
  }

  let withChangelog = 0;
  for (const [version, existing] of Object.entries(table)) {
    const changelogUrl = changelogUrlsByVersion[version];
    if (!changelogUrl) {
      continue;
    }

    table[version] = { ...existing, changelogUrl };
    withChangelog++;
  }

  await writeMetadataTable(table);

  console.log(
    `Refreshed metadata.json: enriched ${String(enriched)} existing versions, added ${String(added)} new ones, `
      + `set changelog URLs on ${String(withChangelog)}.`
  );
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
