/**
 * @file
 *
 * Merges the per-OS fragments produced by `scripts/collect-runtime-versions.ts`
 * (`--out`) into the repo-root `metadata.json`.
 *
 * The matrix in `.github/workflows/collect-runtime-versions.yml` boots each new
 * installer on Windows, macOS and Linux, and each job writes what it measured to
 * its own fragment. This step folds them into one catalog:
 *
 * - **The Windows fragment wins**, because `metadata.json` carries one flat
 *   `runtimeVersions` per version and the `.exe` is the reference installer (see
 *   the `collect-runtime-versions.ts` file comment for why). A version measured
 *   only on the other platforms still lands, so a Windows job that failed does
 *   not lose the whole release.
 * - **Divergence is reported, not hidden.** Two installers of the same Obsidian
 *   version can bundle different Electron builds (`1.12.4`: 39.6.0 on Windows vs
 *   39.7.0 elsewhere; `1.8.10`: 34.2.0 vs 34.5.2). Storing one number silently
 *   loses that, so every disagreement is logged by version and platform — which
 *   is the whole reason the matrix boots three platforms rather than one.
 *
 * The merge is additive: `channel` / `downloads` / `min*` are never touched, and
 * the byte-stable writer in `helpers/metadata-io.ts` keeps the output diff-free
 * when nothing changed.
 *
 * Usage:
 *   npm run merge:runtime-versions -- --fragment windows=a.json --fragment macos=b.json --fragment linux=c.json
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import type { ObsidianRuntimeVersions } from '../src/obsidian-metadata.ts';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import {
  readMetadataTable,
  writeMetadataTable
} from './helpers/metadata-io.ts';

exitIfScriptDisabled();

/**
 * One version's collected runtime, as written by `collect-runtime-versions.ts --out`.
 */
interface CollectedRuntime {
  readonly ecmaScriptVersion?: string;
  readonly runtimeVersions: ObsidianRuntimeVersions;
}

/**
 * One platform's fragment: what that runner measured, keyed by version.
 */
interface PlatformFragment {
  readonly collected: Record<string, CollectedRuntime>;
  readonly platform: string;
}

/**
 * The platform whose measurement is stored in the flat `runtimeVersions` field.
 */
const REFERENCE_PLATFORM = 'windows';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fragment: { multiple: true, type: 'string' }
    }
  });

  const specifiers = values.fragment ?? [];
  if (specifiers.length === 0) {
    console.log('No fragments given — nothing to merge.');
    return;
  }

  const fragments = await Promise.all(specifiers.map(async (specifier) => await readFragment(specifier)));
  const diverged = reportDivergence(fragments);

  // The reference platform is applied last so it overwrites the others.
  const ordered = [
    ...fragments.filter((fragment) => fragment.platform !== REFERENCE_PLATFORM),
    ...fragments.filter((fragment) => fragment.platform === REFERENCE_PLATFORM)
  ];

  const table = await readMetadataTable();
  const merged = new Set<string>();
  for (const fragment of ordered) {
    for (const [version, { ecmaScriptVersion, runtimeVersions }] of Object.entries(fragment.collected)) {
      const existing = table[version];
      if (!existing) {
        console.warn(`Skipped ${version}: absent from metadata.json.`);
        continue;
      }

      table[version] = {
        ...existing,
        runtimeVersions,
        ...(ecmaScriptVersion !== undefined && { ecmaScriptVersion })
      };
      merged.add(version);
    }
  }

  await writeMetadataTable(table);
  console.log(
    `Merged runtime versions for ${String(merged.size)} version(s) from ${String(fragments.length)} platform fragment(s); `
      + `${String(diverged)} diverged across platforms.`
  );
}

/**
 * Reads one `<platform>=<path>` fragment argument.
 *
 * @param specifier - The argument value.
 * @returns The parsed fragment.
 * @throws Error if the argument is not `<platform>=<path>`.
 */
async function readFragment(specifier: string): Promise<PlatformFragment> {
  const separatorIndex = specifier.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error(`Expected --fragment <platform>=<path>, got: ${specifier}`);
  }

  const platform = specifier.slice(0, separatorIndex);
  const path = specifier.slice(separatorIndex + 1);
  const collected = JSON.parse(await readFile(path, 'utf-8')) as Record<string, CollectedRuntime>;
  return { collected, platform };
}

/**
 * Logs every version whose platforms disagree on the bundled Electron version.
 *
 * @param fragments - Every platform's fragment.
 * @returns How many versions diverged.
 */
function reportDivergence(fragments: readonly PlatformFragment[]): number {
  const versions = new Set(fragments.flatMap((fragment) => Object.keys(fragment.collected)));
  let diverged = 0;
  for (const version of versions) {
    const measured = fragments
      .map((fragment) => ({ electron: fragment.collected[version]?.runtimeVersions.electron, platform: fragment.platform }))
      .filter((entry) => entry.electron !== undefined);
    const distinct = new Set(measured.map((entry) => entry.electron));
    if (distinct.size <= 1) {
      continue;
    }

    diverged++;
    const detail = measured.map((entry) => `${entry.platform}=${String(entry.electron)}`).join(', ');
    console.warn(
      `Electron divergence on ${version}: ${detail}. `
        + `metadata.json stores the ${REFERENCE_PLATFORM} value; the others are reported only.`
    );
  }
  return diverged;
}

await main();
