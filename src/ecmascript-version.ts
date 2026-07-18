/**
 * @file
 *
 * Pure derivation of the ECMAScript language level supported by a given
 * Chromium (V8) version, expressed as an ECMAScript-edition string (e.g. `'ES2022'`).
 *
 * A serialized `evalInObsidian` closure runs in Obsidian's Chromium renderer, so
 * the ES features it may safely use are bounded by that shell's Chromium version.
 * The empirically-collected `runtimeVersions.chrome` (see
 * {@link ObsidianRuntimeVersions} and `scripts/collect-runtime-versions.ts`) is
 * fed through {@link deriveEcmaScriptVersion} to bake a per-version
 * `ecmaScriptVersion` into `metadata.json`, so a consumer pinning an installer can
 * tell offline which ES level is safe.
 *
 * The Chromium-major → ES-year breakpoints below are the Chromium releases at
 * which each yearly ECMAScript edition became fully supported, per MDN /
 * caniuse / the ECMAScript compatibility tables. They are a curated table, not
 * derived from anything else, so this module is pure and unit-tested to the 100% gate.
 */

/**
 * One Chromium-major → ECMAScript-edition breakpoint.
 */
interface EcmaScriptBreakpoint {
  /** The ECMAScript-edition label (e.g. `'ES2022'`) supported from {@link minChromeMajor} onward. */
  readonly ecmaScriptVersion: string;

  /** The lowest Chromium major that fully supports {@link ecmaScriptVersion}. */
  readonly minChromeMajor: number;
}

const CHROME_MAJOR_FOR_ES2015 = 51;
const CHROME_MAJOR_FOR_ES2016 = 52;
const CHROME_MAJOR_FOR_ES2017 = 58;
const CHROME_MAJOR_FOR_ES2018 = 64;
const CHROME_MAJOR_FOR_ES2019 = 73;
const CHROME_MAJOR_FOR_ES2020 = 80;
const CHROME_MAJOR_FOR_ES2021 = 85;
const CHROME_MAJOR_FOR_ES2022 = 94;
const CHROME_MAJOR_FOR_ES2023 = 110;
const CHROME_MAJOR_FOR_ES2024 = 122;

/**
 * Chromium-major → ECMAScript-edition breakpoints, sorted by
 * {@link EcmaScriptBreakpoint.minChromeMajor} descending so the first entry whose
 * threshold is met is the highest supported edition (first-match-wins).
 */
const ECMA_SCRIPT_BREAKPOINTS: readonly EcmaScriptBreakpoint[] = [
  { ecmaScriptVersion: 'ES2024', minChromeMajor: CHROME_MAJOR_FOR_ES2024 },
  { ecmaScriptVersion: 'ES2023', minChromeMajor: CHROME_MAJOR_FOR_ES2023 },
  { ecmaScriptVersion: 'ES2022', minChromeMajor: CHROME_MAJOR_FOR_ES2022 },
  { ecmaScriptVersion: 'ES2021', minChromeMajor: CHROME_MAJOR_FOR_ES2021 },
  { ecmaScriptVersion: 'ES2020', minChromeMajor: CHROME_MAJOR_FOR_ES2020 },
  { ecmaScriptVersion: 'ES2019', minChromeMajor: CHROME_MAJOR_FOR_ES2019 },
  { ecmaScriptVersion: 'ES2018', minChromeMajor: CHROME_MAJOR_FOR_ES2018 },
  { ecmaScriptVersion: 'ES2017', minChromeMajor: CHROME_MAJOR_FOR_ES2017 },
  { ecmaScriptVersion: 'ES2016', minChromeMajor: CHROME_MAJOR_FOR_ES2016 },
  { ecmaScriptVersion: 'ES2015', minChromeMajor: CHROME_MAJOR_FOR_ES2015 }
];

const DECIMAL_RADIX = 10;

/**
 * Derives the highest fully-supported ECMAScript edition for a Chromium version.
 *
 * @param chromeVersion - A Chromium version string (e.g. `'114.0.5735.289'`);
 *   only the leading major segment is significant.
 * @returns The ECMAScript-edition label (e.g. `'ES2022'`), or `undefined` when the
 *   version cannot be parsed or its Chromium major predates the earliest tracked edition.
 */
export function deriveEcmaScriptVersion(chromeVersion: string): string | undefined {
  // `parseInt` reads the leading integer, so `'114.0.5735.289'` yields 114.
  // A non-numeric string yields `NaN` — no split, so no dead index-access branch.
  const chromeMajor = Number.parseInt(chromeVersion, DECIMAL_RADIX);
  if (Number.isNaN(chromeMajor)) {
    return undefined;
  }

  for (const breakpoint of ECMA_SCRIPT_BREAKPOINTS) {
    if (chromeMajor >= breakpoint.minChromeMajor) {
      return breakpoint.ecmaScriptVersion;
    }
  }

  return undefined;
}
