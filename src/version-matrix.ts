/**
 * @file
 *
 * Pure decision layer for running a suite against **every** supported Obsidian
 * version.
 *
 * Support is the range `[latest public, latest catalyst]` and both ends must be
 * verified (G99). The two ends are moving targets, and they periodically
 * **coincide** — when public catches up to catalyst, both specifiers provision
 * the same build, so running the suites twice re-runs the same build and buys
 * nothing. Worse, a consumer that ran both still reports "green on public AND
 * catalyst", a two-end claim it never verified.
 *
 * The decision therefore lives here rather than in every consuming repo: a list
 * of version specifiers is resolved to concrete versions, **de-duplicated on the
 * resolved version** (never on the specifier string, so an explicit `1.13.4` and
 * `catalyst-latest` collapse when catalyst *is* 1.13.4), and the suites run once
 * per distinct version.
 *
 * Everything here is pure and unit-tested; the manifest fetch and the logging
 * live in the integration-time `run-version-matrix.ts` glue.
 */

import type { DesktopReleasesManifest } from './obsidian-version.ts';

import {
  CATALYST_LATEST,
  parseVersionSpec,
  PUBLIC_LATEST,
  resolveVersionFromManifest
} from './obsidian-version.ts';

/**
 * The version specifiers a matrix run defaults to: both ends of the supported
 * range (G99). They are de-duplicated on their resolved versions, so when public
 * has caught up to catalyst this yields a single run.
 */
export const DEFAULT_OBSIDIAN_VERSION_SPECS: readonly string[] = [PUBLIC_LATEST, CATALYST_LATEST];

/**
 * A requested specifier that could not be resolved and was dropped.
 */
export interface DroppedVersionSpec {
  /**
  Why the specifier could not be resolved.
   */
  readonly reason: string;

  /**
  The specifier as requested.
   */
  readonly spec: string;
}

/**
 * Parameters for {@link formatVersionMatrixPlan}.
 */
export interface FormatVersionMatrixPlanParams {
  /**
  The de-duplicated matrix that will be run.
   */
  readonly entries: readonly ObsidianVersionMatrixEntry[];

  /**
  The specifiers that resolved, in requested order.
   */
  readonly resolvedSpecs: readonly ResolvedVersionSpec[];
}

/**
 * Parameters for {@link formatVersionMatrixRunHeader}.
 */
export interface FormatVersionMatrixRunHeaderParams {
  /**
  The entry about to run.
   */
  readonly entry: ObsidianVersionMatrixEntry;

  /**
  The entry's zero-based position in the matrix.
   */
  readonly index: number;

  /**
  The total number of entries in the matrix.
   */
  readonly total: number;
}

/**
 * One distinct Obsidian version the suites will run against.
 */
export interface ObsidianVersionMatrixEntry {
  /**
   * Every requested specifier that resolved to {@link version}, in requested
   * order. More than one means the specifiers coincided and were collapsed.
   */
  readonly specs: readonly string[];

  /**
  The concrete `x.y.z` version.
   */
  readonly version: string;
}

/**
 * A requested specifier paired with the concrete version it resolved to.
 */
export interface ResolvedVersionSpec {
  /**
  The specifier as requested (an `x.y.z` version or a channel alias).
   */
  readonly spec: string;

  /**
  The concrete `x.y.z` version it resolved to.
   */
  readonly version: string;
}

/**
 * The outcome of {@link resolveRequestedSpecs}.
 */
export interface ResolveRequestedSpecsResult {
  /**
   * Whether the specifiers came from {@link DEFAULT_OBSIDIAN_VERSION_SPECS}
   * rather than being explicitly requested.
   */
  readonly isDefault: boolean;

  /**
  The specifiers to resolve, in order.
   */
  readonly specs: readonly string[];
}

/**
 * Parameters for {@link resolveVersionSpecs}.
 */
export interface ResolveVersionSpecsParams {
  /**
   * The desktop releases manifest, or `undefined` when no requested specifier is
   * a channel alias (so no fetch was needed).
   */
  readonly manifest: DesktopReleasesManifest | undefined;

  /**
   * Whether a specifier that cannot be resolved is dropped with a recorded
   * reason instead of throwing. Set for the **default** specifier list only: a
   * manifest that ships no catalyst entry must not break every consumer's gate,
   * whereas an explicitly requested specifier that cannot resolve is a real
   * error.
   */
  readonly shouldTolerateUnresolvableSpecs: boolean;

  /**
  The requested specifiers, in order.
   */
  readonly specs: readonly string[];
}

/**
 * The outcome of {@link resolveVersionSpecs}.
 */
export interface ResolveVersionSpecsResult {
  /**
  Specifiers dropped because they could not be resolved (tolerant mode only).
   */
  readonly droppedSpecs: readonly DroppedVersionSpec[];

  /**
  The specifiers that resolved, in requested order.
   */
  readonly resolvedSpecs: readonly ResolvedVersionSpec[];
}

/**
 * Parameters for {@link runVersionMatrixEntries}.
 */
export interface RunVersionMatrixEntriesParams {
  /**
  The de-duplicated matrix to run.
   */
  readonly entries: readonly ObsidianVersionMatrixEntry[];

  /**
  Called just before each entry runs, for progress reporting.
   */
  readonly onEntryStart: (params: FormatVersionMatrixRunHeaderParams) => void;

  /**
  Runs the suites against a single entry, throwing on failure.
   */
  readonly run: (entry: ObsidianVersionMatrixEntry) => Promise<void> | void;
}

/**
 * Collapses resolved specifiers into one entry per **distinct resolved version**.
 *
 * De-duplication is keyed on the resolved version, not the specifier string, so
 * specifiers that name the same build collapse however they were written.
 * First-seen order is preserved, and every specifier that landed on a version is
 * recorded on its entry.
 *
 * @param resolvedSpecs - The resolved specifiers, in requested order.
 * @returns One entry per distinct version, in first-seen order.
 */
export function buildVersionMatrix(resolvedSpecs: readonly ResolvedVersionSpec[]): ObsidianVersionMatrixEntry[] {
  const specsByVersion = new Map<string, string[]>();

  for (const { spec, version } of resolvedSpecs) {
    const specs = specsByVersion.get(version);
    if (!specs) {
      specsByVersion.set(version, [spec]);
      continue;
    }
    if (!specs.includes(spec)) {
      specs.push(spec);
    }
  }

  return [...specsByVersion].map(([version, specs]) => ({ specs, version }));
}

/**
 * Formats an entry for logs and error messages.
 *
 * Specifiers that merely repeat the version add nothing, so an explicit-only
 * entry formats as the bare version rather than `1.13.4 (1.13.4)`.
 *
 * @param entry - The entry to format.
 * @returns A string like `1.13.4 (public-latest, catalyst-latest)`.
 */
export function formatVersionMatrixEntry(entry: ObsidianVersionMatrixEntry): string {
  const { specs, version } = entry;
  const aliasSpecs = specs.filter((spec) => spec !== version);
  if (aliasSpecs.length === 0) {
    return version;
  }
  return `${version} (${aliasSpecs.join(', ')})`;
}

/**
 * Builds the lines announcing what the matrix resolved to and how many runs it
 * will take.
 *
 * The collapse must be **stated**, never inferred: a reader who sees one run
 * where they expected two has to be told the second end was already covered,
 * not left wondering whether it was skipped by accident.
 *
 * @param params - The matrix and the specifiers it was built from.
 * @returns The lines to log, in order.
 */
export function formatVersionMatrixPlan(params: FormatVersionMatrixPlanParams): string[] {
  const { entries, resolvedSpecs } = params;

  const lines = resolvedSpecs
    .filter(({ spec, version }) => spec !== version)
    .map(({ spec, version }) => `${spec} -> ${version}`);

  const specifierCount = resolvedSpecs.length;
  const versionCount = entries.length;
  const formattedEntries = entries.map((entry) => formatVersionMatrixEntry(entry)).join(', ');

  lines.push(
    `${String(specifierCount)} requested ${pluralize(specifierCount, 'specifier')} `
      + `${resolveVerb(specifierCount)} to ${String(versionCount)} distinct ${pluralize(versionCount, 'version')}: `
      + `${formattedEntries}. Running the suites ${formatRunCount(versionCount)}.`
  );

  return lines;
}

/**
 * Builds the progress line announcing a single entry's run.
 *
 * @param params - The entry and its position in the matrix.
 * @returns A string like `Run 1 of 2: 1.12.7 (public-latest)`.
 */
export function formatVersionMatrixRunHeader(params: FormatVersionMatrixRunHeaderParams): string {
  const { entry, index, total } = params;
  return `Run ${String(index + 1)} of ${String(total)}: ${formatVersionMatrixEntry(entry)}`;
}

/**
 * Reports whether any specifier is a channel alias, i.e. whether the releases
 * manifest has to be fetched at all.
 *
 * @param specs - The requested specifiers.
 * @returns `true` when at least one specifier resolves against the manifest.
 */
export function hasChannelSpec(specs: readonly string[]): boolean {
  return specs.some((spec) => spec === PUBLIC_LATEST || spec === CATALYST_LATEST);
}

/**
 * Splits a comma-separated specifier list, so a consumer can hand an env var
 * (`OBSIDIAN_VERSION=1.12.7,catalyst-latest`) straight through.
 *
 * @param raw - The raw comma-separated string.
 * @returns The trimmed, non-empty specifiers, in order.
 */
export function parseVersionSpecList(raw: string): string[] {
  return raw.split(',').map((spec) => spec.trim()).filter((spec) => spec !== '');
}

/**
 * Normalizes the requested version specifiers, falling back to the default
 * both-ends list when none were given.
 *
 * An empty string is treated as absent, so a consumer can pass an unset
 * `process.env['OBSIDIAN_VERSION']` without guarding it.
 *
 * @param versions - An array of specifiers, a comma-separated string, or `undefined`.
 * @returns The specifiers to resolve, and whether they came from the default list.
 */
export function resolveRequestedSpecs(versions: readonly string[] | string | undefined): ResolveRequestedSpecsResult {
  const specs = typeof versions === 'string' ? parseVersionSpecList(versions) : [...versions ?? []];
  if (specs.length === 0) {
    return { isDefault: true, specs: [...DEFAULT_OBSIDIAN_VERSION_SPECS] };
  }
  return { isDefault: false, specs };
}

/**
 * Resolves each requested specifier to a concrete version against a
 * single manifest.
 *
 * @param params - The specifiers, the manifest, and the tolerance mode.
 * @returns The resolved specifiers and any that were dropped.
 * @throws Error if a specifier cannot be resolved and tolerance is off, or if
 *   tolerance is on but nothing resolved at all.
 */
export function resolveVersionSpecs(params: ResolveVersionSpecsParams): ResolveVersionSpecsResult {
  const { manifest, shouldTolerateUnresolvableSpecs, specs } = params;

  const droppedSpecs: DroppedVersionSpec[] = [];
  const resolvedSpecs: ResolvedVersionSpec[] = [];

  for (const spec of specs) {
    try {
      resolvedSpecs.push({ spec, version: resolveSpec(spec, manifest) });
    } catch (error) {
      if (!shouldTolerateUnresolvableSpecs) {
        throw error;
      }
      droppedSpecs.push({ reason: toReason(error), spec });
    }
  }

  if (resolvedSpecs.length === 0) {
    throw new Error(
      `No Obsidian version could be resolved from: ${specs.join(', ')}. ${droppedSpecs.map(({ reason, spec }) => `${spec}: ${reason}`).join('; ')}`
    );
  }

  return { droppedSpecs, resolvedSpecs };
}

/**
 * Runs the suites once per matrix entry, **always running every entry** before
 * reporting.
 *
 * A failing end must not hide the state of the other: stopping at the first
 * failure would leave "catalyst broke" and "both ends broke" indistinguishable
 * without a second run. Every entry therefore runs, and the summary names which
 * concrete versions failed and which passed.
 *
 * @param params - The matrix, the per-entry runner, and the progress reporter.
 * @returns A {@link Promise} that resolves once every entry has run successfully.
 * @throws Error if the matrix is empty, or an {@link AggregateError} naming every
 *   version that failed.
 */
export async function runVersionMatrixEntries(params: RunVersionMatrixEntriesParams): Promise<void> {
  const { entries, onEntryStart, run } = params;

  if (entries.length === 0) {
    throw new Error('Refusing to run an empty Obsidian version matrix: no version would be verified.');
  }

  const errors: unknown[] = [];
  const failedEntries: ObsidianVersionMatrixEntry[] = [];
  const passedEntries: ObsidianVersionMatrixEntry[] = [];

  for (const [index, entry] of entries.entries()) {
    onEntryStart({ entry, index, total: entries.length });
    try {
      await run(entry);
      passedEntries.push(entry);
    } catch (error) {
      errors.push(error);
      failedEntries.push(entry);
    }
  }

  if (failedEntries.length === 0) {
    return;
  }

  const passedClause = passedEntries.length === 0
    ? ''
    : ` Passed: ${passedEntries.map((entry) => formatVersionMatrixEntry(entry)).join(', ')}.`;

  throw new AggregateError(
    errors,
    `Obsidian version matrix failed on ${String(failedEntries.length)} of ${String(entries.length)} `
      + `${pluralize(entries.length, 'version')}: `
      + `${failedEntries.map((entry) => formatVersionMatrixEntry(entry)).join(', ')}.${passedClause}`
  );
}

/**
 * Formats a run count as prose, so the single-run case reads as a deliberate
 * decision rather than a suspicious `1`.
 *
 * @param count - The number of runs.
 * @returns `once`, `twice`, or `N times`.
 */
function formatRunCount(count: number): string {
  const TWICE = 2;
  if (count === 1) {
    return 'once';
  }
  if (count === TWICE) {
    return 'twice';
  }
  return `${String(count)} times`;
}

/**
 * Pluralizes a noun by count.
 *
 * @param count - The count.
 * @param noun - The singular noun.
 * @returns The noun, suffixed with `s` unless the count is exactly one.
 */
function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/**
 * Resolves a single specifier against a manifest.
 *
 * @param spec - The specifier.
 * @param manifest - The manifest, or `undefined` when none was fetched.
 * @returns The concrete `x.y.z` version.
 * @throws Error if the specifier is invalid, or names a channel with no manifest
 *   entry.
 */
function resolveSpec(spec: string, manifest: DesktopReleasesManifest | undefined): string {
  const parsed = parseVersionSpec(spec);
  if (parsed.kind === 'explicit') {
    return parsed.version;
  }
  if (!manifest) {
    throw new Error(`Cannot resolve "${spec}" without the desktop releases manifest.`);
  }
  return resolveVersionFromManifest(manifest, parsed.channel);
}

/**
 * Chooses the subject-verb agreement for the specifier count.
 *
 * @param count - The number of specifiers.
 * @returns `resolves` or `resolve`.
 */
function resolveVerb(count: number): string {
  return count === 1 ? 'resolves' : 'resolve';
}

/**
 * Extracts a human-readable reason from a thrown value.
 *
 * @param error - The thrown value.
 * @returns The reason text.
 */
function toReason(error: unknown): string {
  /* v8 ignore next -- Defensive: every throw site reachable from here (parseVersionSpec, resolveVersionFromManifest, the missing-manifest guard) throws an Error. */
  return error instanceof Error ? error.message : String(error);
}
