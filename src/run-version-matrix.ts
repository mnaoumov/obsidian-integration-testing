/**
 * @file
 *
 * Integration-time runner that executes a suite once per **distinct** supported
 * Obsidian version.
 *
 * Thin glue over the pure `version-matrix.ts` decision layer: the only things
 * that happen here are the single manifest fetch and the logging. Everything
 * that decides — normalizing the requested specifiers, resolving them,
 * de-duplicating on the resolved version, sequencing the runs, and building the
 * failure summary — is pure and unit-tested next door.
 *
 * The loop lives above the transport rather than inside it because a test
 * framework's global setup cannot re-run its own test files: it launches one
 * instance for one run. Keeping the loop framework-agnostic (the caller supplies
 * `run`) is what lets Vitest, Jest, and manual consumers all inherit it (L6).
 */

/* v8 ignore start -- Integration-time glue (network fetch + logging) covered by integration tests, not unit tests. */

import type {
  ObsidianVersionMatrixEntry,
  ResolvedVersionSpec
} from './version-matrix.ts';

import { log } from './log.ts';
import { fetchDesktopReleasesManifest } from './obsidian-version-switch.ts';
import {
  buildVersionMatrix,
  formatVersionMatrixPlan,
  formatVersionMatrixRunHeader,
  hasChannelSpec,
  resolveRequestedSpecs,
  resolveVersionSpecs,
  runVersionMatrixEntries
} from './version-matrix.ts';

/**
 * Parameters for {@link runObsidianVersionMatrix}.
 */
export interface RunObsidianVersionMatrixParams {
  /**
   * Runs the suites against one concrete Obsidian version, throwing on failure.
   *
   * The entry's `version` is the concrete `x.y.z` to pin — typically forwarded to
   * the test-runner child as `OBSIDIAN_VERSION`.
   */
  readonly run: (entry: ObsidianVersionMatrixEntry) => Promise<void> | void;

  /**
   * The version specifiers to run against: an array, or a comma-separated string
   * so an env var can be passed straight through.
   *
   * Each accepts an explicit `'x.y.z'`, `'public-latest'`, or `'catalyst-latest'`.
   * Defaults to both ends of the supported range (G99) when omitted or empty, and
   * the list is always de-duplicated on the **resolved** version — so when public
   * has caught up to catalyst, the suites run once.
   */
  readonly versions?: readonly string[] | string | undefined;
}

/**
 * Runs a suite once per distinct supported Obsidian version.
 *
 * @param params - The per-version runner and the requested versions.
 * @returns A {@link Promise} that resolves once every version has run successfully.
 * @throws Error if no version could be resolved, or an {@link AggregateError}
 *   naming every version whose run failed.
 */
export async function runObsidianVersionMatrix(params: RunObsidianVersionMatrixParams): Promise<void> {
  const { run, versions } = params;

  const { isDefault, specs } = resolveRequestedSpecs(versions);
  const manifest = hasChannelSpec(specs) ? await fetchDesktopReleasesManifest() : undefined;
  const { droppedSpecs, resolvedSpecs } = resolveVersionSpecs({
    manifest,
    // The default list must not break every consumer's gate when a channel is
    // Momentarily absent from the manifest; an explicitly requested specifier
    // That cannot resolve is a real error.
    shouldTolerateUnresolvableSpecs: isDefault,
    specs
  });

  for (const { reason, spec } of droppedSpecs) {
    logMatrix(`Skipping "${spec}": ${reason}`);
  }

  const entries = buildVersionMatrix(resolvedSpecs);
  logPlan(resolvedSpecs, entries);

  await runVersionMatrixEntries({
    entries,
    onEntryStart: (headerParams) => {
      logMatrix(formatVersionMatrixRunHeader(headerParams));
    },
    run
  });
}

/**
 * Logs a matrix message under a consistent prefix.
 *
 * @param message - The message to log.
 */
function logMatrix(message: string): void {
  log(`[version-matrix] ${message}`);
}

/**
 * Logs what the specifiers resolved to and how many runs that implies.
 *
 * @param resolvedSpecs - The resolved specifiers, in requested order.
 * @param entries - The de-duplicated matrix.
 */
function logPlan(resolvedSpecs: readonly ResolvedVersionSpec[], entries: readonly ObsidianVersionMatrixEntry[]): void {
  for (const line of formatVersionMatrixPlan({ entries, resolvedSpecs })) {
    logMatrix(line);
  }
}

/* v8 ignore stop */
