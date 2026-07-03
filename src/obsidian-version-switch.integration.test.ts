/**
 * @file
 *
 * Integration test for the desktop asar provisioning path: downloading a
 * concrete Obsidian version's `obsidian-<version>.asar.gz` and gunzip-
 * decompressing it into a valid, cached asar.
 *
 * This exercises the real network fetch + `node:zlib` decompression in
 * `obsidian-version-switch.ts`, which is otherwise integration-time-only glue
 * excluded from unit coverage. It needs internet access but no running Obsidian.
 *
 * A version's asar.gz is hosted on exactly one host depending on its channel:
 * **public** (stable) releases are GitHub release assets, while **catalyst**
 * (early access) releases are on the Obsidian CDN. Both channels are covered so
 * the download + unpack path is verified for each host.
 */

import {
  existsSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs';
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  ensureAsarCached,
  getCachedAsarPath,
  resolveConcreteVersion
} from './obsidian-version-switch.ts';
import {
  CATALYST_LATEST,
  PUBLIC_LATEST
} from './obsidian-version.ts';

const DOWNLOAD_TIMEOUT_IN_MILLISECONDS = 120_000;

// Live network downloads: retry to absorb transient CDN 5xx / empty-body blips
// Without masking a real regression, which fails every attempt.
const DOWNLOAD_RETRY_COUNT = 2;

// The first UInt32LE of every asar archive is 4 — the size of the Pickle that
// Holds the header-length integer (verified empirically against a real Obsidian
// Asar). A still-gzipped payload would start with the 0x1f 0x8b gzip magic
// Instead, so this doubles as proof the download was actually decompressed.
const ASAR_MAGIC_HEADER_SIZE_PREFIX = 4;

// The asar header JSON length is a UInt32LE at byte offset 12, and the JSON
// Itself begins immediately after the 16-byte size preamble.
const ASAR_HEADER_JSON_LENGTH_OFFSET = 12;
const ASAR_HEADER_JSON_OFFSET = 16;

// A real Obsidian asar is tens of megabytes; a tiny file means the download or
// Decompression produced a truncated/invalid result.
const MINIMUM_PLAUSIBLE_ASAR_SIZE_IN_BYTES = 1_000_000;

interface AsarHeader {
  files: object;
}

const CHANNELS = [
  { alias: PUBLIC_LATEST, label: 'public' },
  { alias: CATALYST_LATEST, label: 'catalyst' }
];

describe.each(CHANNELS)('asar download and unpack ($label channel)', ({ alias }) => {
  it(
    'should download the asar.gz, gunzip it into a valid asar, and reuse the cache',
    { retry: DOWNLOAD_RETRY_COUNT, timeout: DOWNLOAD_TIMEOUT_IN_MILLISECONDS },
    async () => {
      const version = await resolveConcreteVersion(alias);
      // Evict any cached copy so the download + gunzip path actually runs.
      rmSync(getCachedAsarPath(version), { force: true });

      const asarPath = await ensureAsarCached(version);
      expect(asarPath).toBe(getCachedAsarPath(version));
      expect(existsSync(asarPath)).toBe(true);

      const buffer = readFileSync(asarPath);
      expect(buffer.length).toBeGreaterThan(MINIMUM_PLAUSIBLE_ASAR_SIZE_IN_BYTES);
      expect(buffer.readUInt32LE(0)).toBe(ASAR_MAGIC_HEADER_SIZE_PREFIX);
      expect(Object.keys(parseAsarHeader(buffer).files).length).toBeGreaterThan(0);

      // A second call is a cache hit — same path, file left untouched.
      const mtimeBefore = statSync(asarPath).mtimeMs;
      const cachedPath = await ensureAsarCached(version);
      expect(cachedPath).toBe(asarPath);
      expect(statSync(cachedPath).mtimeMs).toBe(mtimeBefore);
    }
  );
});

/**
 * Parses the JSON header of an asar archive from its raw bytes.
 *
 * @param buffer - The full asar file contents.
 * @returns The parsed asar header.
 */
function parseAsarHeader(buffer: Buffer): AsarHeader {
  const headerJsonLength = buffer.readUInt32LE(ASAR_HEADER_JSON_LENGTH_OFFSET);
  const headerJson = buffer.toString('utf8', ASAR_HEADER_JSON_OFFSET, ASAR_HEADER_JSON_OFFSET + headerJsonLength);
  return JSON.parse(headerJson) as AsarHeader;
}
