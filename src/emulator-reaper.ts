/**
 * @file
 *
 * Stops an emulator this harness started once its run is gone for good — the
 * case nothing else covers, **L56**'s path B with no later run: the runner is
 * killed (SIGKILL, Task Manager, an IDE stop button), no teardown runs, and no
 * other Android run ever comes along to reclaim the leftover from its marker.
 * On 2026-09-10 an emulator left like that kept `netsimd` spinning for six hours.
 *
 * The reaper is a small detached Node process spawned beside every emulator the
 * harness starts or takes over. It holds no handle to the emulator and needs
 * none: the marker (`emulator-marker.ts`) says what to stop, and the verified
 * stop (`emulator-reclaim.ts`) is the one the run's own teardown uses.
 *
 * ## It watches the `android` setup lock, not the process that started it
 *
 * The process that starts the emulator is not always the run. A project with no
 * transport global setup boots it from a **test worker** (**L56** path A), and
 * Vitest ends workers during a perfectly healthy run — so a reaper tied to its
 * spawner's lifetime (the **L33** liveness socket, the first idea) would stop
 * the emulator mid-run, or race the next worker taking it over. The `android`
 * setup lock (**L7**) is held by the run's main process for the whole run, and
 * its holder being alive is exactly what "an Android run is in flight" means.
 *
 * So the reaper polls that lock, and once it can **take** it — no live run
 * holds it — it stops the harness's leftovers while holding it, which is the
 * precondition every leftover stop documents: no run can adopt an emulator that
 * is mid-shutdown. That is precisely what the next run's preflight would do,
 * done at the first moment that run could have done it.
 *
 * A dead same-host holder is abandoned at once. A live-PID holder that has gone
 * silent is only abandoned after
 * {@link EMULATOR_REAPER_LOCK_SILENCE_IN_MILLISECONDS}, far wider than the
 * two minutes a waiting run steals on: a reaper is always waiting, so at two
 * minutes a live run that blocked its event loop would lose its emulator.
 *
 * ## Fail-open, like the renderer watchdog
 *
 * A reaper is armed only when a live run holds the lock at the moment the
 * emulator is recorded. A run that takes no lock — a hand-wired
 * `createTransportFromOptions` — gets none, and says so, rather than a reaper
 * that would read its missing lock as "the run is over" and stop an emulator
 * somebody is using. A spawn that fails is logged and never fails the launch.
 *
 * ## How it runs
 *
 * `process.execPath -e <bootstrap> <this module's URL> <avdName> <startedAt>`:
 * the bootstrap `import()`s this very module and calls {@link runEmulatorReaper}.
 * The URL is the built `.mjs` / `.cjs` in a consumer's install, and the `.ts`
 * source in this repo's own suites, which Node's type stripping runs as-is — so
 * nothing this module imports may reach a module that reads the build-time
 * `OBSIDIAN_METADATA` global. Its stdout/stderr go to a per-AVD log file, capped
 * at {@link EMULATOR_REAPER_LOG_MAX_SIZE_IN_BYTES}, so the verdict lines the stop
 * prints are on record even though no terminal is left to show them.
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { EmulatorMarker } from './emulator-marker.ts';
import type { SetupLock } from './setup-lock.ts';

import { readEmulatorMarker } from './emulator-marker.ts';
import { EmulatorReclaimer } from './emulator-reclaim.ts';
import { HARNESS_TEMP_DIR_NAME } from './leftover-cleanup.ts';
import { log } from './log.ts';
import { checkIsProcessAlive } from './process-liveness.ts';
import {
  ANDROID_SETUP_LOCK_SCOPE,
  checkIsSetupLockHeld,
  tryAcquireSetupLock
} from './setup-lock.ts';

/**
 * How often the reaper looks at the marker and the lock — the lock's own
 * heartbeat interval, so a killed run is noticed within one beat.
 */
export const EMULATOR_REAPER_POLL_INTERVAL_IN_MILLISECONDS = 5000;

/**
 * How long a same-host lock holder whose PID is still alive may stay silent
 * before the reaper treats its run as gone: 30 minutes, the threshold the lock
 * already uses across hosts. Only a recycled PID should ever reach it.
 */
export const EMULATOR_REAPER_LOCK_SILENCE_IN_MILLISECONDS = 1_800_000;

/**
 * The size past which the reaper log is started afresh rather than appended to.
 */
export const EMULATOR_REAPER_LOG_MAX_SIZE_IN_BYTES = 1_048_576;

/**
 * The export the bootstrap calls. Named here so the bootstrap and the export
 * cannot drift apart.
 */
export const EMULATOR_REAPER_ENTRY_NAME = 'runEmulatorReaper';

const LOCK_LABEL = 'emulator-reaper';
const REAPER_LOG_FILE_SUFFIX = '.emulator-reaper.log';

/**
 * What the reaper watches for: the emulator a marker recorded when it was armed.
 */
export interface EmulatorReaperArguments {
  /**
  The AVD whose marker it watches.
   */
  readonly avdName: string;

  /**
   * When the watched emulator was launched. A takeover keeps it, so it names one
   * emulator across every run that owns it, and tells a later emulator of the
   * same AVD apart.
   */
  readonly startedAtInMilliseconds: number;
}

/**
 * What the marker says the reaper should do next.
 *
 * - `emulator-stopped` — the marker is gone, or none of its PIDs is alive: the
 *   emulator was stopped, so there is nothing left to watch.
 * - `superseded` — the marker now records a different emulator of the same AVD,
 *   which has its own reaper.
 * - `watch` — the emulator is still up.
 */
export type EmulatorReaperWatchVerdict = 'emulator-stopped' | 'superseded' | 'watch';

/**
 * Parameters for {@link resolveEmulatorReaperWatch}.
 */
export interface ResolveEmulatorReaperWatchParams {
  /**
  The launch time of the emulator this reaper was armed for.
   */
  readonly armedStartedAtInMilliseconds: number;

  /**
  Whether a PID is still running.
   */
  readonly checkIsPidAlive: (pid: number) => boolean;

  /**
  The AVD's marker as it reads now, if any.
   */
  readonly marker: EmulatorMarker | undefined;
}

/**
 * Parameters for {@link spawnEmulatorReaper}.
 */
export interface SpawnEmulatorReaperParams {
  /**
  The AVD whose emulator was just recorded.
   */
  readonly avdName: string;

  /**
  Receives the armed / not-armed line.
   */
  readonly log: (message: string) => void;

  /**
  The recorded emulator's launch time, as written into its marker.
   */
  readonly startedAtInMilliseconds: number;
}

/**
 * Encodes the reaper's arguments for its command line.
 *
 * @param reaperArguments - What the reaper watches for.
 * @returns The command-line arguments, in the order {@link parseEmulatorReaperArguments} reads them.
 */
export function buildEmulatorReaperArguments(reaperArguments: EmulatorReaperArguments): string[] {
  return [reaperArguments.avdName, String(reaperArguments.startedAtInMilliseconds)];
}

/**
 * Builds the script `node -e` runs to start the reaper.
 *
 * It `import()`s the module whose URL is its first argument and hands the rest
 * to {@link runEmulatorReaper}. `import()` rather than `require`, because it
 * loads all three forms the module ships as — ESM, CJS, and this repo's own
 * `.ts` source under Node's type stripping. A CJS module's named exports are
 * found by Node's static analysis; `default` is the fallback when they are not.
 *
 * @returns The script.
 */
export function buildEmulatorReaperBootstrap(): string {
  return [
    'import(process.argv[1]).then((reaperModule) => {',
    `  const run = reaperModule.${EMULATOR_REAPER_ENTRY_NAME} ?? reaperModule.default.${EMULATOR_REAPER_ENTRY_NAME};`,
    '  return run(process.argv.slice(2));',
    '}).catch((error) => {',
    '  console.error(error);',
    '  process.exitCode = 1;',
    '});'
  ].join('\n');
}

/**
 * Decodes the reaper's command-line arguments.
 *
 * @param argv - The arguments after the module URL.
 * @returns The arguments, or `undefined` when they are not the two {@link buildEmulatorReaperArguments} writes.
 */
export function parseEmulatorReaperArguments(argv: readonly string[]): EmulatorReaperArguments | undefined {
  const [avdName, startedAtText, ...rest] = argv;
  if (!avdName || startedAtText === undefined || rest.length > 0) {
    return undefined;
  }

  const startedAtInMilliseconds = Number(startedAtText);
  if (!Number.isSafeInteger(startedAtInMilliseconds) || startedAtInMilliseconds <= 0) {
    return undefined;
  }

  return { avdName, startedAtInMilliseconds };
}

/**
 * Decides how the reaper log is opened, so it can never grow without bound.
 *
 * @param sizeInBytes - The log's current size, or `undefined` when there is none.
 * @returns `'a'` to append, or `'w'` to start it afresh once it has passed the cap.
 */
export function resolveEmulatorReaperLogOpenFlag(sizeInBytes: number | undefined): 'a' | 'w' {
  return sizeInBytes !== undefined && sizeInBytes > EMULATOR_REAPER_LOG_MAX_SIZE_IN_BYTES ? 'w' : 'a';
}

/**
 * Decides what the marker says the reaper should do next.
 *
 * @param params - The marker as it reads now, and the emulator the reaper was armed for.
 * @returns The verdict.
 */
export function resolveEmulatorReaperWatch(params: ResolveEmulatorReaperWatchParams): EmulatorReaperWatchVerdict {
  const { marker } = params;
  if (marker === undefined) {
    return 'emulator-stopped';
  }

  if (marker.startedAtInMilliseconds !== params.armedStartedAtInMilliseconds) {
    return 'superseded';
  }

  return marker.ownedEmulatorPids.some((pid) => params.checkIsPidAlive(pid)) ? 'watch' : 'emulator-stopped';
}

/* v8 ignore start -- Detached-process glue covered by the Android integration suite, not unit tests. */

/**
 * The reaper process's body: watches the marker and the lock until either the
 * emulator is gone or no run holds the lock, and in the second case stops the
 * harness's leftovers while holding it.
 *
 * Exported for the bootstrap, which is its only caller.
 *
 * @param argv - The reaper's arguments, as {@link buildEmulatorReaperArguments} wrote them.
 */
export async function runEmulatorReaper(argv: readonly string[]): Promise<void> {
  const reaperArguments = parseEmulatorReaperArguments(argv);
  if (!reaperArguments) {
    log(`[emulator-reaper] Refusing to run: expected <avdName> <startedAtInMilliseconds>, got ${JSON.stringify(argv)}.`);
    process.exitCode = 1;
    return;
  }

  const { avdName, startedAtInMilliseconds } = reaperArguments;
  reaperLog(
    `Watching the emulator started at ${new Date(startedAtInMilliseconds).toISOString()} (reaper PID ${String(process.pid)}); it is stopped once no Android run holds the '${ANDROID_SETUP_LOCK_SCOPE}' setup lock.`
  );

  for (;;) {
    const verdict = readWatchVerdict(reaperArguments);
    if (verdict !== 'watch') {
      reaperLog(describeExit(verdict));
      return;
    }

    let lock: SetupLock | undefined;
    try {
      lock = tryAcquireSetupLock({
        label: LOCK_LABEL,
        scope: ANDROID_SETUP_LOCK_SCOPE,
        staleAfterSilenceInMilliseconds: EMULATOR_REAPER_LOCK_SILENCE_IN_MILLISECONDS
      });
    } catch (error: unknown) {
      // Fail open: a lock this process cannot even look at is no evidence the run is over.
      reaperLog(`Giving up: the setup lock could not be read (${error instanceof Error ? error.message : String(error)}). The next Android run reclaims the emulator instead.`);
      return;
    }

    if (lock) {
      try {
        // The run may have ended normally between the look above and the lock: its teardown then stopped the emulator.
        const lockedVerdict = readWatchVerdict(reaperArguments);
        if (lockedVerdict !== 'watch') {
          reaperLog(describeExit(lockedVerdict));
          return;
        }

        reaperLog('No Android run holds the setup lock any more, so nothing is left to stop the emulator. Stopping the leftovers this harness started...');
        await new EmulatorReclaimer(reaperLog).reclaimLeftoverEmulators({ scope: 'end-of-run' });
      } finally {
        lock.release();
      }
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, EMULATOR_REAPER_POLL_INTERVAL_IN_MILLISECONDS);
    });
  }

  function reaperLog(message: string): void {
    log(`[emulator-reaper:${avdName}] ${message}`);
  }
}

/**
 * Starts the reaper for an emulator the harness just recorded as its own, when
 * a live run holds the `android` setup lock — and says which it did.
 *
 * Never throws: a reaper that cannot be spawned is a lost safety net, not a
 * reason to fail the launch it would have guarded.
 *
 * @param params - The recorded emulator, and where to report.
 */
export function spawnEmulatorReaper(params: SpawnEmulatorReaperParams): void {
  const { avdName } = params;
  if (!checkIsSetupLockHeld(ANDROID_SETUP_LOCK_SCOPE)) {
    params.log(
      `No emulator reaper armed for AVD "${avdName}": no run holds the '${ANDROID_SETUP_LOCK_SCOPE}' setup lock, so a reaper could not tell this run ending from it being killed. If this process is killed, only the next Android run on this host stops the emulator.`
    );
    return;
  }

  const logFilePath = join(getReaperLogDirectory(), `${avdName}${REAPER_LOG_FILE_SUFFIX}`);
  try {
    mkdirSync(getReaperLogDirectory(), { recursive: true });
    const logFileDescriptor = openSync(logFilePath, resolveEmulatorReaperLogOpenFlag(readFileSize(logFilePath)));
    try {
      const child = spawn(
        process.execPath,
        [
          '-e',
          buildEmulatorReaperBootstrap(),
          resolveOwnModuleUrl(),
          ...buildEmulatorReaperArguments({ avdName, startedAtInMilliseconds: params.startedAtInMilliseconds })
        ],
        { detached: true, stdio: ['ignore', logFileDescriptor, logFileDescriptor], windowsHide: true }
      );
      child.once('error', (error) => {
        params.log(`The emulator reaper for AVD "${avdName}" failed to start: ${error.message}`);
      });
      child.unref();
      params.log(
        `Emulator reaper armed for AVD "${avdName}" (PID ${String(child.pid)}): if this run is killed, it stops the emulator once no Android run holds the '${ANDROID_SETUP_LOCK_SCOPE}' setup lock. Log: ${logFilePath}`
      );
    } finally {
      closeSync(logFileDescriptor);
    }
  } catch (error: unknown) {
    params.log(`Could not arm the emulator reaper for AVD "${avdName}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function describeExit(verdict: Exclude<EmulatorReaperWatchVerdict, 'watch'>): string {
  return verdict === 'superseded'
    ? 'The marker now records a later emulator of this AVD, which has its own reaper; nothing left to watch.'
    : 'The emulator was stopped; nothing left to watch.';
}

function getReaperLogDirectory(): string {
  return join(tmpdir(), HARNESS_TEMP_DIR_NAME);
}

function readFileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function readWatchVerdict(reaperArguments: EmulatorReaperArguments): EmulatorReaperWatchVerdict {
  return resolveEmulatorReaperWatch({
    armedStartedAtInMilliseconds: reaperArguments.startedAtInMilliseconds,
    checkIsPidAlive: checkIsProcessAlive,
    marker: readEmulatorMarker(reaperArguments.avdName)
  });
}

/**
 * Finds this module's own URL — the one the bootstrap imports.
 *
 * The CJS build has no `import.meta` (esbuild empties it), but it has
 * `__filename`; the ESM build and the `.ts` source have `import.meta.url`.
 *
 * @returns The URL of this module as it is running.
 */
function resolveOwnModuleUrl(): string {
  return typeof __filename === 'string' ? pathToFileURL(__filename).href : import.meta.url;
}

/* v8 ignore stop */
