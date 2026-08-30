/**
 * @file
 *
 * Records the concrete JS runtime each installer's Electron shell ships
 * (`process.versions`: Node / Chromium / V8 / Electron) into the repo-root
 * `metadata.json`, plus a derived `ecmaScriptVersion` string.
 *
 * It boots each version's own installer over CDP (via {@link connectToCdp}, pinning
 * both the asar and the installer to the same version so the shell+asar pair is
 * matched and boots cleanly), reads `process.versions`, derives the ECMAScript
 * edition from the Chromium major (see {@link deriveEcmaScriptVersion}), and merges
 * the result additively — never touching `channel` / `downloads` / `min*`.
 *
 * Each version is a multi-hundred-MB installer download plus a real app boot, so
 * it is incremental by default: only versions with no `runtimeVersions` yet are
 * collected, which in steady state is none. `.github/workflows/collect-runtime-versions.yml`
 * runs it on a schedule so a newly-released installer is measured without anyone
 * having to remember to.
 *
 * **The Electron version is a property of the INSTALLER, not of the release.**
 * Node / V8 / Chromium are fixed by a given Electron version, but two installers
 * of the *same* Obsidian version can bundle different Electron builds: `1.12.4`
 * shipped Electron 39.6.0 in its `.exe` and 39.7.0 in every other installer, and
 * `1.8.10` shipped 34.2.0 vs 34.5.2. A single-platform run is therefore *not*
 * authoritative for all platforms. `metadata.json` records one flat
 * `runtimeVersions` per version, measured on **Windows** (the `.exe`, which
 * together with the `.dmg` is the only installer published for all 106
 * installer-bearing releases — the `.tar.gz` is missing for the 14 oldest); the
 * workflow's merge step boots the other platforms too, purely to warn when they
 * diverge.
 *
 * Usage:
 *   npm run collect:runtime-versions                # every not-yet-collected version
 *   npm run collect:runtime-versions -- --only 1.12.7
 *   npm run collect:runtime-versions -- --from 1.5.0 --to 1.12.7
 *   npm run collect:runtime-versions -- --force     # recollect already-recorded versions
 *   npm run collect:runtime-versions -- --out fragment.json --disable-sandbox
 */

import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { parseArgs } from 'node:util';

import type { ObsidianRuntimeVersions } from '../src/obsidian-metadata.ts';

import { deriveEcmaScriptVersion } from '../src/ecmascript-version.ts';
import { errorToString } from '../src/error-to-string.ts';
import { compareVersions } from '../src/obsidian-version.ts';
import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import { defineObsidianMetadataGlobal } from './helpers/metadata-global.ts';
import {
  readMetadataTable,
  writeMetadataTable
} from './helpers/metadata-io.ts';

exitIfScriptDisabled();

// The built library reads its version table from the `OBSIDIAN_METADATA` global.
// Esbuild's `define` inlines it at build time; under jiti that global is absent,
// So the transitively-imported reader throws at load. Publish it first — the same
// Shim `scripts/metadata-global-setup.ts` gives the test runners.
defineObsidianMetadataGlobal();

/**
 * One version's collected runtime, as written to a `--out` fragment.
 */
interface CollectedRuntime {
  readonly ecmaScriptVersion?: string;
  readonly runtimeVersions: ObsidianRuntimeVersions;
}

/**
The desktop-installer download key for the current host platform.
*/
type PlatformInstallerKey = 'dmg' | 'exe' | 'tar';

const JSON_INDENT = 2;

/**
 * Reads the **entire** `process.versions` from a freshly-booted owned instance
 * pinned to a version's own installer + asar.
 *
 * @param version - The concrete `x.y.z` version to boot.
 * @param shouldDisableSandbox - Whether to append `--no-sandbox`, needed to boot on Linux CI.
 * @returns The recorded runtime versions — every key `process.versions` exposes.
 */
async function collectRuntimeVersions(version: string, shouldDisableSandbox: boolean): Promise<ObsidianRuntimeVersions> {
  // Dynamic import so the OBSIDIAN_METADATA shim (top of file) is applied before
  // Obsidian's module chain — which reads the version table — loads under jiti.
  // eslint-disable-next-line no-restricted-syntax -- Must inject OBSIDIAN_METADATA before this chain loads under jiti.
  const { connectToCdp } = await import('../src/connect-to-cdp.ts');
  await using connection = await connectToCdp({
    isObsidianAppVisible: false,
    obsidianInstallerVersion: version,
    obsidianVersion: version,
    shouldDisableSandbox
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
    case 'darwin': {
      return 'dmg';
    }
    case 'win32': {
      return 'exe';
    }
    default: {
      return 'tar';
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'disable-sandbox': { type: 'boolean' },
      'force': { type: 'boolean' },
      'from': { type: 'string' },
      'only': { multiple: true, type: 'string' },
      'out': { type: 'string' },
      'to': { type: 'string' }
    }
  });
  const shouldForce = values.force ?? false;
  const shouldDisableSandbox = values['disable-sandbox'] ?? false;
  const outPath = values.out;
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

  const collected: Record<string, CollectedRuntime> = {};
  let skipped = 0;
  for (const version of versions) {
    try {
      const runtimeVersions = await collectRuntimeVersions(version, shouldDisableSandbox);
      const ecmaScriptVersion = deriveEcmaScriptVersion(runtimeVersions.chrome);
      collected[version] = {
        runtimeVersions,
        ...(ecmaScriptVersion !== undefined && { ecmaScriptVersion })
      };

      if (outPath === undefined) {
        table[version] = {
          ...table[version],
          runtimeVersions,
          ...(ecmaScriptVersion !== undefined && { ecmaScriptVersion })
        };
        // Write after each version so a long run is resumable if it is interrupted.
        await writeMetadataTable(table);
      }

      console.log(`Collected ${version}: ${JSON.stringify(runtimeVersions)}${ecmaScriptVersion === undefined ? '' : ` -> ${ecmaScriptVersion}`}`);
    } catch (error) {
      skipped++;
      console.warn(`Skipped ${version}: ${errorToString(error)}`);
    }
  }

  if (outPath !== undefined) {
    // A fragment, not the catalog: the matrix jobs run concurrently on separate
    // Runners and their results are merged in one place afterwards.
    await writeFile(outPath, `${JSON.stringify(collected, null, JSON_INDENT)}\n`);
    console.log(`Wrote ${String(Object.keys(collected).length)} collected version(s) to ${outPath}.`);
  }

  console.log(`Runtime-version collection complete: collected ${String(Object.keys(collected).length)}, skipped ${String(skipped)}.`);
}

await main();
