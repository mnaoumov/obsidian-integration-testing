/**
 * @file
 *
 * Pure helpers for locating and describing an AVD's saved boot snapshot.
 *
 * Only the opt-in `shouldReuseEmulatorSnapshot` path resumes one, and even then
 * its age is worth a log line: a snapshot is the one input to a run that no gate
 * inspects, and the failure a rotten one produces — a guest that serves adb,
 * accepts a uiautomator2 session and then drops `offline` about half a minute
 * later — reads as a code regression rather than as stale state. `emulator
 * -avd … -no-snapshot-load` (the default) makes the question moot; when the
 * caller has deliberately traded that away, *"resuming snapshot saved <date>"*
 * is what keeps the trade visible in the transcript.
 *
 * Kept separate from the integration-only `transport-factory` so the path
 * derivation and the wording stay unit-testable — the factory itself does the
 * `stat`.
 */

/**
 * Parameters for {@link buildAvdSnapshotDirectoryCandidates}.
 */
export interface BuildAvdSnapshotDirectoryCandidatesParams {
  /**
  The Android Virtual Device name.
   */
  readonly avdName: string;

  /**
  The process environment, read for the Android SDK's AVD-home overrides.
   */
  readonly environment: Readonly<Record<string, string | undefined>>;

  /**
  The user's home directory, the base of the default AVD home.
   */
  readonly homeDirectory: string;
}

/**
 * Parameters for {@link buildSnapshotAgeMessage}.
 */
export interface BuildSnapshotAgeMessageParams {
  /**
  The Android Virtual Device name.
   */
  readonly avdName: string;

  /**
  When the snapshot was last written, or `undefined` when none was found.
   */
  readonly savedAt?: Date | undefined;
}

/**
 * The snapshot the emulator loads and saves by default.
 */
const DEFAULT_SNAPSHOT_NAME = 'default_boot';

/**
 * The directory the Android SDK keeps AVDs in, under whichever home applies.
 */
const AVD_HOME_SEGMENTS = ['.android', 'avd'];
const TRAILING_SEPARATOR_PATTERN = /[/\\]+$/;

/**
 * Builds the directories the AVD's boot snapshot could live in, most specific
 * first.
 *
 * The lookup mirrors the emulator's own: `ANDROID_AVD_HOME` wins outright, then
 * `.android/avd` under `ANDROID_SDK_HOME`, then under the user's home. Returning
 * candidates rather than one path keeps the `stat` — and the decision that a
 * miss is not an error — in the caller.
 *
 * @param params - The AVD name, the environment, and the home directory.
 * @returns The candidate snapshot directories, most specific first.
 */
export function buildAvdSnapshotDirectoryCandidates(params: BuildAvdSnapshotDirectoryCandidatesParams): string[] {
  const { avdName, environment, homeDirectory } = params;

  const avdHomes = [
    environment['ANDROID_AVD_HOME'],
    resolveAvdHomeUnder(environment['ANDROID_SDK_HOME']),
    resolveAvdHomeUnder(homeDirectory)
  ];

  return avdHomes
    .filter((avdHome): avdHome is string => avdHome !== undefined && avdHome.length > 0)
    .map((avdHome) => joinPath(avdHome, `${avdName}.avd`, 'snapshots', DEFAULT_SNAPSHOT_NAME));
}

/**
 * Builds the line logged when a run has opted into resuming a snapshot.
 *
 * @param params - The AVD name and the snapshot's save time, if it was found.
 * @returns The log line.
 */
export function buildSnapshotAgeMessage(params: BuildSnapshotAgeMessageParams): string {
  if (params.savedAt === undefined) {
    return `Snapshot reuse is enabled for AVD "${params.avdName}", but no \`${DEFAULT_SNAPSHOT_NAME}\` snapshot was found — this run cold-boots and saves one for the next.`;
  }

  return `Snapshot reuse is enabled for AVD "${params.avdName}": resuming \`${DEFAULT_SNAPSHOT_NAME}\` saved ${params.savedAt.toISOString()}.`;
}

/**
 * Joins path segments with `/`, which every platform's path APIs accept.
 *
 * @param base - The leading segment, whose trailing separators are dropped.
 * @param segments - The segments to append.
 * @returns The joined path.
 */
function joinPath(base: string, ...segments: string[]): string {
  return [base.replace(TRAILING_SEPARATOR_PATTERN, ''), ...segments].join('/');
}

/**
 * Resolves the AVD home under a base directory, when there is one.
 *
 * @param base - `ANDROID_SDK_HOME` or the user's home directory.
 * @returns The AVD home, or `undefined` when `base` is unset.
 */
function resolveAvdHomeUnder(base: string | undefined): string | undefined {
  if (base === undefined || base.length === 0) {
    return undefined;
  }

  return joinPath(base, ...AVD_HOME_SEGMENTS);
}
