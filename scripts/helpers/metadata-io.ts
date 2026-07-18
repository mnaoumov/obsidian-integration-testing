/**
 * @file
 *
 * Shared read/write helpers for the repo-root `metadata.json` catalog, used by
 * both `scripts/refresh-metadata.ts` (bakes upstream download URLs) and
 * `scripts/collect-runtime-versions.ts` (bakes empirical `process.versions`).
 *
 * The write is byte-stable: version keys sorted numerically, two-space indented,
 * with a trailing newline — matching what the format gate produces, so an
 * unchanged table rewrites to an identical file (no diff). Both scripts share
 * this so their output stays byte-for-byte identical.
 */

import {
  readFile,
  writeFile
} from 'node:fs/promises';

import type { ObsidianVersionMetadata } from '../../src/obsidian-metadata.ts';

import { compareVersions } from '../../src/obsidian-version.ts';

/** The repo-root catalog: version → metadata (mutable while merging). */
export type MetadataTable = Record<string, ObsidianVersionMetadata>;

const METADATA_PATH = 'metadata.json';
const JSON_INDENT = 2;

/**
 * Reads and parses the repo-root `metadata.json` catalog.
 *
 * @returns The parsed, mutable catalog.
 */
export async function readMetadataTable(): Promise<MetadataTable> {
  return JSON.parse(await readFile(METADATA_PATH, 'utf-8')) as MetadataTable;
}

/**
 * Serializes the catalog to the repo's on-disk format: version keys sorted
 * numerically, two-space indented, trailing newline (matching what the format
 * gate produces, so the output is byte-stable across runs).
 *
 * @param table - The catalog to serialize.
 * @returns The JSON text.
 */
export function serializeTable(table: MetadataTable): string {
  const sorted = Object.fromEntries(
    Object.entries(table).sort(([aVersion], [bVersion]) => compareVersions(aVersion, bVersion))
  );
  return `${JSON.stringify(sorted, null, JSON_INDENT)}\n`;
}

/**
 * Writes the catalog back to the repo-root `metadata.json` byte-stably.
 *
 * @param table - The catalog to write.
 */
export async function writeMetadataTable(table: MetadataTable): Promise<void> {
  await writeFile(METADATA_PATH, serializeTable(table));
}
