/**
 * @file
 *
 * Opt-in build-step that records the concrete JS runtime each installer's Electron
 * shell ships (`process.versions`: Node / Chromium / V8 / Electron) into the
 * repo-root `metadata.json`, plus a derived `ecmaScriptVersion` string.
 *
 * It boots each version's own installer over CDP (via {@link connectToCdp}, pinning
 * both the asar and the installer to the same version so the shell+asar pair is
 * matched and boots cleanly), reads `process.versions`, derives the ECMAScript
 * edition from the Chromium major (see {@link deriveEcmaScriptVersion}), and merges
 * the result additively — never touching `channel` / `downloads` / `min*`. It is
 * heavy (each version is a multi-hundred-MB installer download + boot), so it is a
 * manual, opt-in script, run incrementally with filters.
 *
 * Electron bundles the same Node/V8/Chromium on every OS for a given Electron
 * version, so a single run on one platform is authoritative for all platforms.
 *
 * Usage:
 *   npm run collect:runtime-versions                # every not-yet-collected version
 *   npm run collect:runtime-versions -- --only 1.12.7
 *   npm run collect:runtime-versions -- --from 1.5.0 --to 1.12.7
 *   npm run collect:runtime-versions -- --force     # recollect already-recorded versions
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import type { ObsidianRuntimeVersions } from '../src/obsidian-metadata.ts';

import { deriveEcmaScriptVersion } from '../src/ecmascript-version.ts';
import { errorToString } from '../src/error-to-string.ts';
import { compareVersions } from '../src/obsidian-version.ts';
import {
  readMetadataTable,
  writeMetadataTable
} from './helpers/metadata-io.ts';

// The built library reads its version table from the `OBSIDIAN_METADATA` global.
// Esbuild's `define` inlines it at build time; under jiti that global is absent,
// So the transitively-imported reader throws at load. Inject it from
// `metadata.json` first — the same shim `scripts/vitest-metadata-setup.ts` uses.
Object.defineProperty(globalThis, 'OBSIDIAN_METADATA', {
  configurable: true,
  value: JSON.parse(readFileSync('metadata.json', 'utf-8'))
});

/** The desktop-installer download key for the current host platform. */
type PlatformInstallerKey = 'dmg' | 'exe' | 'tar';

/**
 * Reads the **entire** `process.versions` from a freshly-booted owned instance
 * pinned to a version's own installer + asar.
 *
 * @param version - The concrete `x.y.z` version to boot.
 * @returns The recorded runtime versions — every key `process.versions` exposes.
 */
async function collectRuntimeVersions(version: string): Promise<ObsidianRuntimeVersions> {
  // Dynamic import so the OBSIDIAN_METADATA shim (top of file) is applied before
  // Obsidian's module chain — which reads the version table — loads under jiti.
  // eslint-disable-next-line no-restricted-syntax -- Must inject OBSIDIAN_METADATA before this chain loads under jiti.
  const { connectToCdp } = await import('../src/connect-to-cdp.ts');
  await using connection = await connectToCdp({
    isObsidianAppVisible: false,
    obsidianInstallerVersion: version,
    obsidianVersion: version
  });

  const raw = await connection.invoke('JSON.stringify(process.versions)');
  // Record the whole object; the exact key set varies by Electron version.
  return JSON.parse(raw) as ObsidianRuntimeVersions;
}

/**
 * Resolves the desktop-installer download key for the current host platform.
 *
 * @returns The `downloads` key naming this platform's installer asset.
 */
function getPlatformInstallerKey(): PlatformInstallerKey {
  switch (process.platform) {
    case 'darwin':
      return 'dmg';
    case 'win32':
      return 'exe';
    default:
      return 'tar';
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      force: { type: 'boolean' },
      from: { type: 'string' },
      only: { multiple: true, type: 'string' },
      to: { type: 'string' }
    }
  });
  const shouldForce = values.force ?? false;
  const only = values.only ?? [];
  const from = values.from;
  const to = values.to;

  const table = await readMetadataTable();
  const platformKey = getPlatformInstallerKey();

  const versions = Object.keys(table)
    .filter((version) => table[version]?.downloads?.[platformKey] !== undefined)
    .filter((version) => only.length === 0 || only.includes(version))
    .filter((version) => from === undefined || compareVersions(version, from) >= 0)
    .filter((version) => to === undefined || compareVersions(version, to) <= 0)
    .filter((version) => shouldForce || table[version]?.runtimeVersions === undefined)
    // Newest-first so the most-relevant versions land first even if interrupted.
    // Old versions once stuck on the first-run vault selector; T72 fixed the
    // Owned-vault auto-open (down to 0.6.4), so they now boot and collect too.
    .sort((aVersion, bVersion) => compareVersions(bVersion, aVersion));

  console.log(`Collecting process.versions for ${String(versions.length)} version(s) via the ${platformKey} installer.`);

  let collected = 0;
  let skipped = 0;
  for (const version of versions) {
    try {
      const runtimeVersions = await collectRuntimeVersions(version);
      const ecmaScriptVersion = deriveEcmaScriptVersion(runtimeVersions.chrome);
      table[version] = {
        ...table[version],
        runtimeVersions,
        ...(ecmaScriptVersion === undefined ? {} : { ecmaScriptVersion })
      };
      // Write after each version so a long run is resumable if it is interrupted.
      await writeMetadataTable(table);
      collected++;
      console.log(`Collected ${version}: ${JSON.stringify(runtimeVersions)}${ecmaScriptVersion === undefined ? '' : ` -> ${ecmaScriptVersion}`}`);
    } catch (error) {
      skipped++;
      console.warn(`Skipped ${version}: ${errorToString(error)}`);
    }
  }

  console.log(`Runtime-version collection complete: collected ${String(collected)}, skipped ${String(skipped)}.`);
}

await main();
