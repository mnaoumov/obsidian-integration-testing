/**
 * @file
 *
 * Reads the Electron version an Obsidian build recommends out of that build's own
 * `app.js`, for the `minRecommendedElectronVersion` field of `metadata.json`.
 *
 * The app hardcodes it as a string constant declared straight after the app's own
 * version string: `goe="1.14.5",moe="28.2.3";` in the minified asar, or the same
 * two declarations on separate lines in a prettier-formatted copy. Requiring the
 * preceding string to BE the app version is what makes the match unambiguous: a
 * minified bundle is full of `x="a.b.c",y="d.e.f"` pairs, and only one of them
 * follows the version being read.
 */

import type { ObsidianVersionMetadata } from '../../src/desktop/versions/obsidian-metadata.ts';

import { compareVersions } from '../../src/desktop/versions/obsidian-version.ts';

/**
The parameters of {@link extractMinRecommendedElectronVersion}.
*/
export interface ExtractMinRecommendedElectronVersionParams {
  /**
  The build's `app.js` source.
  */
  readonly appJs: string;

  /**
  The app version the build is, as its `app.js` declares it.
  */
  readonly version: string;
}

const ESCAPED_REGEX_CHARACTERS_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Extracts the Electron version a build recommends from its `app.js`.
 *
 * @param params - The source and the version it belongs to.
 * @returns The `a.b.c` Electron version, or `undefined` when the source carries
 *   no match or more than one (an ambiguous answer is not recorded).
 */
export function extractMinRecommendedElectronVersion(params: ExtractMinRecommendedElectronVersionParams): string | undefined {
  const escapedVersion = params.version.replaceAll(ESCAPED_REGEX_CHARACTERS_PATTERN, String.raw`\$&`);
  const pattern = new RegExp(
    String.raw`[\w$]+\s*=\s*(['"])${escapedVersion}\1,\s*[\w$]+\s*=\s*(['"])(?<electronVersion>\d+\.\d+\.\d+)\2;`,
    'g'
  );
  const electronVersions = new Set([...params.appJs.matchAll(pattern)].map((match) => match.groups?.['electronVersion'] ?? ''));
  if (electronVersions.size !== 1) {
    return undefined;
  }

  const [electronVersion] = electronVersions;
  return electronVersion;
}

/**
 * Selects the versions whose `minRecommendedElectronVersion` the refresh should
 * extract: those newer than the newest version that already carries one.
 *
 * Builds older than the field's first appearance (before `0.15.3`) never declare
 * it, so "every version that lacks it" would download ~170 asars on every run.
 * Everything past the frontier is new by construction, so a steady-state run
 * selects nothing.
 *
 * @param table - Each version's current `minRecommendedElectronVersion`.
 * @returns The versions to extract, oldest first.
 */
export function selectElectronVersionCandidates(table: Readonly<Record<string, ObsidianVersionMetadata>>): string[] {
  const versions = Object.keys(table).sort(compareVersions);
  let frontier = -1;
  for (const [index, version] of versions.entries()) {
    if (table[version]?.minRecommendedElectronVersion !== undefined) {
      frontier = index;
    }
  }
  return versions.slice(frontier + 1);
}
