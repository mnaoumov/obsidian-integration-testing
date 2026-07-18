/**
 * @file
 *
 * Build-step that refreshes the repo-root `metadata.json` catalog with the
 * per-version asset download URLs published by the upstream
 * `obsidian-versions.json` (`jesse-r-s-hines/wdio-obsidian-service`).
 *
 * The merge is **additive-only**: it sets the `downloads` field (app `asar` +
 * x64 desktop installers) on each version and adds any version missing from our
 * table, but it NEVER overwrites our own `channel` / `changelogUrl*` / `min*`
 * compatibility fields — those are empirically measured here (see `CLAUDE.md`
 * L20) and stay authoritative. Run it, then commit the updated `metadata.json`.
 *
 * The output is byte-stable: rerunning against an unchanged upstream produces no
 * diff, so it doubles as a "is our catalog current?" check.
 */

import type { ObsidianVersionDownloads } from '../src/obsidian-metadata.ts';

import {
  readMetadataTable,
  writeMetadataTable
} from './helpers/metadata-io.ts';

/** The subset of the upstream `obsidian-versions.json` document we read. */
interface UpstreamCatalog {
  readonly versions: readonly UpstreamVersionEntry[];
}

/** The subset of an upstream entry's `downloads` map we bake into our catalog. */
interface UpstreamDownloads {
  readonly asar?: string;
  readonly dmg?: string;
  readonly exe?: string;
  readonly tar?: string;
}

/** The subset of an upstream `obsidian-versions.json` version entry we read. */
interface UpstreamVersionEntry {
  readonly changelogUrl?: string;
  readonly downloads?: UpstreamDownloads;
  readonly isBeta?: boolean;
  readonly version: string;
}

const UPSTREAM_CATALOG_URL = 'https://raw.githubusercontent.com/jesse-r-s-hines/wdio-obsidian-service/HEAD/obsidian-versions.json';

/**
 * Picks only the asset URLs this library downloads (app asar + x64 desktop
 * installers) from an upstream entry's `downloads` map.
 *
 * @param downloads - The upstream entry's `downloads` map.
 * @returns The distilled URLs, or `undefined` when the entry carries none.
 */
function distillDownloads(downloads: undefined | UpstreamDownloads): ObsidianVersionDownloads | undefined {
  if (!downloads) {
    return undefined;
  }

  const distilled: Record<string, string> = {};
  for (const key of ['asar', 'dmg', 'exe', 'tar'] as const) {
    const url = downloads[key];
    if (url !== undefined) {
      distilled[key] = url;
    }
  }

  return Object.keys(distilled).length > 0 ? distilled : undefined;
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
  const upstream = await fetchUpstreamCatalog();
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
        ...(entry.changelogUrl === undefined ? {} : { changelogUrl: entry.changelogUrl }),
        downloads
      };
      added++;
    }
  }

  await writeMetadataTable(table);

  console.log(`Refreshed metadata.json: enriched ${String(enriched)} existing versions, added ${String(added)} new ones.`);
}

await main();
