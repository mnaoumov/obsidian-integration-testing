/**
 * @file
 *
 * Records which emulator this harness started for an AVD, so the emulator
 * stays **the harness's** until a stop of it has been verified — whichever run,
 * or whichever process of a run, gets to that stop.
 *
 * Ownership used to live only in the memory of the run that launched the
 * emulator, and three ordinary things lose that memory:
 *
 * - **The launching process is a test worker.** A project with no transport
 *   global setup creates its transport — and auto-starts its emulator — inside a
 *   Vitest worker, and Vitest ends workers abruptly, so the worker's teardown
 *   never gets a turn. The project's own global teardown runs, but held no
 *   handle to the emulator. This repo's `integration-tests:android-trusted-input`
 *   project is exactly this, and on 2026-09-10 the emulator it left idle kept
 *   `netsimd` writing until a 278 GB log filled the drive (**L56**).
 * - **The runner is killed** — SIGKILL, Task Manager, an IDE stop button — and
 *   neither teardown path runs at all.
 * - **A later run adopts the leftover.** A device this run did not start is
 *   correctly not this run's to stop — which, without a record, made every
 *   leftover nobody's to stop, for ever.
 *
 * The marker is the record: a small JSON sentinel per AVD next to the setup lock,
 * written from the moment the emulator is launched and removed only by a verified
 * stop. It is deliberately tolerant — a missing, unreadable or mismatched marker
 * reads as "not ours", the same answer the harness gave before markers existed.
 *
 * **It records a launch, not a booted emulator**, and that is the difference
 * between covering the third case above and covering it only after the ~45s a
 * cold boot takes. A launch-time marker names the `emulator` launcher alone and
 * no device yet; the device id arrives when one appears, and the QEMU backend's
 * PID once the boot completes. Each write keeps the original launch time, so the
 * reaper armed by the first still recognizes the last as the same emulator.
 *
 * What makes a marker's emulator ours is evidence, not the file: at least one
 * PID it records must still be a **live emulator process** on the host (the
 * caller intersects with the process listing, not a bare signal-0 probe), so a
 * recycled PID or an emulator somebody booted by hand is never mistaken for one
 * this harness started. A launch-time marker satisfies that as written, because
 * `emulator-backend.ts` counts the `emulator` launcher as one of the emulator
 * processes — which is why phasing the marker needed no change to the verdict.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { HARNESS_TEMP_DIR_NAME } from './leftover-cleanup.ts';
import { log } from './log.ts';
import { checkIsProcessAlive } from './process-liveness.ts';

const MARKER_FILE_SUFFIX = '.emulator.json';

/**
 * Identifies the emulator this harness started for an AVD.
 */
export interface EmulatorMarker {
  /**
  The AVD the emulator is running.
   */
  readonly avdName: string;

  /**
   * The adb serial of the device it serves, e.g. `emulator-5554`. Absent while
   * the emulator is still booting and no device has appeared yet — a marker is
   * written from the launch, before there is anything to name.
   */
  readonly deviceId?: string | undefined;

  /**
   * The emulator processes the harness owns: the launcher plus the QEMU backend
   * it forked — or, until the device appears, the launcher alone.
   */
  readonly ownedEmulatorPids: readonly number[];

  /**
   * PID of the harness process responsible for stopping the emulator — the one
   * that started it, or the one that later took it over as a leftover.
   */
  readonly ownerPid: number;

  /**
   * The emulator processes that were already running when this launch spawned
   * its own — present only while the record is still provisional, i.e. before
   * the backend's own PID is known.
   *
   * It is what makes a launch-time marker convictable at all. Killing the
   * launcher does **not** kill the `qemu-system-*-headless` backend it forked
   * (**L46**), so a record naming the launcher alone goes stale over an
   * emulator that is still running — the leak this marker exists to prevent.
   * With the snapshot, anything in the host's emulator listing that is not in
   * it was forked by this launch, which is the same pre-launch diff the
   * successful path uses (`emulator-backend.ts`) and the same one **L46**
   * requires instead of a `qemu*` sweep.
   */
  readonly preLaunchEmulatorPids?: readonly number[] | undefined;

  /**
  When the emulator was started (`Date.now()` epoch milliseconds).
   */
  readonly startedAtInMilliseconds: number;
}

/**
 * What a marker says about the emulator it describes.
 *
 * - `harness-leftover` — ours, and no live harness process is responsible for
 *   it: the caller may take it over or stop it.
 * - `in-use-by-live-run` — ours, but another live harness process owns it.
 * - `stale-marker` — none of its PIDs is a live emulator any more; the marker
 *   outlived its emulator and proves nothing.
 */
export type EmulatorMarkerVerdict = 'harness-leftover' | 'in-use-by-live-run' | 'stale-marker';

/**
 * Parameters for {@link resolveEmulatorMarkerVerdict}.
 */
export interface ResolveEmulatorMarkerVerdictParams {
  /**
  PID of the process asking.
   */
  readonly currentPid: number;

  /**
  Whether the marker's owner process is still running.
   */
  readonly isOwnerAlive: boolean;

  /**
  The emulator processes currently running on the host.
   */
  readonly liveEmulatorPids: readonly number[];

  /**
  The marker to judge.
   */
  readonly marker: EmulatorMarker;
}

/**
 * Parameters for {@link writeEmulatorMarker}.
 */
export interface WriteEmulatorMarkerParams {
  /**
  The AVD the emulator is running.
   */
  readonly avdName: string;

  /**
  The adb serial of the device it serves; omitted while the emulator is still booting.
   */
  readonly deviceId?: string | undefined;

  /**
  The emulator processes the harness owns.
   */
  readonly ownedEmulatorPids: readonly number[];

  /**
  The emulator processes that predate this launch. Written only while the backend's own PID is not known yet.
   */
  readonly preLaunchEmulatorPids?: readonly number[] | undefined;

  /**
  When the emulator was launched; omitted → now. A takeover keeps the original launch time.
   */
  readonly startedAtInMilliseconds?: number | undefined;
}

/**
 * Says whether a marker still names a process that is running.
 *
 * A signal-0 probe, not the emulator listing `resolveEmulatorMarkerVerdict`
 * intersects with: this answers the cheap question "is there anything left of
 * what this marker recorded", which is what deciding whether a marker may be
 * overwritten or removed needs. Convicting one as another run's leftover is the
 * stronger question, and costs a host process listing.
 *
 * @param marker - The marker, or `undefined` when there is none.
 * @returns `true` when the marker records a PID that is still alive.
 */
export function checkIsMarkedEmulatorRunning(marker: EmulatorMarker | undefined): boolean {
  return marker?.ownedEmulatorPids.some((pid) => checkIsProcessAlive(pid)) ?? false;
}

/**
 * Removes the marker for an AVD. Called once its emulator is verifiably gone, so
 * a later run cannot mistake a recycled PID for ours.
 *
 * @param avdName - The AVD name.
 */
export function clearEmulatorMarker(avdName: string): void {
  try {
    rmSync(getMarkerFilePath(avdName), { force: true });
  } catch (error: unknown) {
    log(`[emulator-marker] Could not remove the marker for AVD "${avdName}": ${getErrorMessage(error)}`);
  }
}

/**
 * Removes the marker for an AVD once none of the processes it records is still
 * running — the form a stop uses.
 *
 * A stop is verified against the PIDs **it** owned, which is not always the
 * emulator the marker describes: a launch that died at once (the emulator's own
 * `Running multiple emulators with the same AVD` FATAL) owns nothing, verifies
 * trivially, and must not erase the record of an emulator that is still up.
 *
 * @param avdName - The AVD name.
 */
export function clearEmulatorMarkerIfStopped(avdName: string): void {
  if (checkIsMarkedEmulatorRunning(readEmulatorMarker(avdName))) {
    return;
  }

  clearEmulatorMarker(avdName);
}

/**
 * Lists every emulator marker on this host.
 *
 * @returns The readable markers, in directory order.
 */
export function listEmulatorMarkers(): EmulatorMarker[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(getMarkerDirectory());
  } catch {
    return [];
  }

  const markers: EmulatorMarker[] = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(MARKER_FILE_SUFFIX)) {
      continue;
    }

    const marker = readEmulatorMarker(fileName.slice(0, -MARKER_FILE_SUFFIX.length));
    if (marker) {
      markers.push(marker);
    }
  }

  return markers;
}

/**
 * Reads the marker for an AVD.
 *
 * @param avdName - The AVD name.
 * @returns The marker, or `undefined` when there is none, it is unreadable, or it describes another AVD.
 */
export function readEmulatorMarker(avdName: string): EmulatorMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getMarkerFilePath(avdName), 'utf-8'));
  } catch {
    return undefined;
  }

  return parseMarker(parsed, avdName);
}

/**
 * Decides what a marker says about the emulator it describes.
 *
 * Evidence first: a marker none of whose PIDs is a live emulator is stale,
 * whoever owns it. Only then does ownership matter — and a live owner that is
 * not the caller keeps it, because that run will stop it itself.
 *
 * @param params - The marker, the host's live emulator PIDs, and who is asking.
 * @returns The verdict.
 */
export function resolveEmulatorMarkerVerdict(params: ResolveEmulatorMarkerVerdictParams): EmulatorMarkerVerdict {
  if (selectLiveMarkedPids(params.marker, params.liveEmulatorPids).length === 0) {
    return 'stale-marker';
  }

  if (params.marker.ownerPid !== params.currentPid && params.isOwnerAlive) {
    return 'in-use-by-live-run';
  }

  return 'harness-leftover';
}

/**
 * Selects the emulator processes a marker convicts: the PIDs it records that
 * are still running, plus — while the record is still provisional — whatever
 * the launch it describes has forked since.
 *
 * The second half is what makes a launch-time marker usable. It names the
 * launcher, and killing the launcher leaves the QEMU backend running
 * (**L46**), so without the `preLaunchEmulatorPids` diff a stop would kill the
 * one process that does not hold the AVD and the marker would then read as
 * stale over a live emulator. The diff claims exactly what the successful path
 * claims — the emulator processes that appeared across this launch — and never
 * one that predates it.
 *
 * @param marker - The marker.
 * @param liveEmulatorPids - The emulator processes currently running on the host.
 * @returns The marked PIDs still running, in marker order, then any this launch forked, in listed order.
 */
export function selectLiveMarkedPids(marker: EmulatorMarker, liveEmulatorPids: readonly number[]): number[] {
  const livePids = marker.ownedEmulatorPids.filter((pid) => liveEmulatorPids.includes(pid));
  const { preLaunchEmulatorPids } = marker;
  if (preLaunchEmulatorPids === undefined) {
    return livePids;
  }

  return [...livePids, ...liveEmulatorPids.filter((pid) => !preLaunchEmulatorPids.includes(pid) && !livePids.includes(pid))];
}

/**
 * Records that the current process is responsible for stopping an AVD's
 * emulator — one it just started, or a leftover it is taking over.
 *
 * @param params - The emulator's AVD, device and PIDs.
 */
export function writeEmulatorMarker(params: WriteEmulatorMarkerParams): void {
  const marker: EmulatorMarker = {
    avdName: params.avdName,
    // Omitted rather than written empty while the emulator is still booting: the stop reads its absence as "no console to shut down".
    ...(params.deviceId !== undefined && { deviceId: params.deviceId }),
    ownedEmulatorPids: [...params.ownedEmulatorPids],
    ownerPid: process.pid,
    // Dropped by the write that learns the backend's PID: from then on the owned set is exact and a diff would only widen it.
    ...(params.preLaunchEmulatorPids !== undefined && { preLaunchEmulatorPids: [...params.preLaunchEmulatorPids] }),
    startedAtInMilliseconds: params.startedAtInMilliseconds ?? Date.now()
  };

  try {
    mkdirSync(getMarkerDirectory(), { recursive: true });
    writeFileSync(getMarkerFilePath(marker.avdName), JSON.stringify(marker));
  } catch (error: unknown) {
    log(`[emulator-marker] Could not record the emulator for AVD "${marker.avdName}": ${getErrorMessage(error)}`);
  }
}

function checkIsNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getMarkerDirectory(): string {
  return join(tmpdir(), HARNESS_TEMP_DIR_NAME);
}

function getMarkerFilePath(avdName: string): string {
  return join(getMarkerDirectory(), `${avdName}${MARKER_FILE_SUFFIX}`);
}

function parseMarker(parsed: unknown, avdName: string): EmulatorMarker | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const { avdName: markedAvdName, deviceId, ownedEmulatorPids, ownerPid, preLaunchEmulatorPids, startedAtInMilliseconds } = record;

  if (
    markedAvdName !== avdName
    || (deviceId !== undefined && typeof deviceId !== 'string')
    || typeof ownerPid !== 'number'
    || typeof startedAtInMilliseconds !== 'number'
    || !checkIsNumberArray(ownedEmulatorPids)
    || (preLaunchEmulatorPids !== undefined && !checkIsNumberArray(preLaunchEmulatorPids))
  ) {
    return undefined;
  }

  return {
    avdName,
    ...(deviceId !== undefined && { deviceId }),
    ownedEmulatorPids,
    ownerPid,
    ...(preLaunchEmulatorPids !== undefined && { preLaunchEmulatorPids }),
    startedAtInMilliseconds
  };
}
