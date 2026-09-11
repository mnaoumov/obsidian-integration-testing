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
 * written once the emulator is up and removed only by a verified stop. It is
 * deliberately tolerant — a missing, unreadable or mismatched marker reads as
 * "not ours", the same answer the harness gave before markers existed.
 *
 * What makes a marker's emulator ours is evidence, not the file: at least one
 * PID it records must still be a **live emulator process** on the host (the
 * caller intersects with the process listing, not a bare signal-0 probe), so a
 * recycled PID or an emulator somebody booted by hand is never mistaken for one
 * this harness started.
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
  The adb serial of the device it serves, e.g. `emulator-5554`.
   */
  readonly deviceId: string;

  /**
  The emulator processes the harness owns: the launcher plus the QEMU backend it forked.
   */
  readonly ownedEmulatorPids: readonly number[];

  /**
   * PID of the harness process responsible for stopping the emulator — the one
   * that started it, or the one that later took it over as a leftover.
   */
  readonly ownerPid: number;

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
  The adb serial of the device it serves.
   */
  readonly deviceId: string;

  /**
  The emulator processes the harness owns.
   */
  readonly ownedEmulatorPids: readonly number[];

  /**
  When the emulator was launched; omitted → now. A takeover keeps the original launch time.
   */
  readonly startedAtInMilliseconds?: number | undefined;
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
  const marker = readEmulatorMarker(avdName);
  if (marker?.ownedEmulatorPids.some((pid) => checkIsProcessAlive(pid))) {
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
 * Selects the marker's PIDs that are still live emulator processes.
 *
 * @param marker - The marker.
 * @param liveEmulatorPids - The emulator processes currently running on the host.
 * @returns The marked PIDs still running, in marker order.
 */
export function selectLiveMarkedPids(marker: EmulatorMarker, liveEmulatorPids: readonly number[]): number[] {
  return marker.ownedEmulatorPids.filter((pid) => liveEmulatorPids.includes(pid));
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
    deviceId: params.deviceId,
    ownedEmulatorPids: [...params.ownedEmulatorPids],
    ownerPid: process.pid,
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
  const { avdName: markedAvdName, deviceId, ownedEmulatorPids, ownerPid, startedAtInMilliseconds } = record;

  if (
    markedAvdName !== avdName
    || typeof deviceId !== 'string'
    || typeof ownerPid !== 'number'
    || typeof startedAtInMilliseconds !== 'number'
    || !checkIsNumberArray(ownedEmulatorPids)
  ) {
    return undefined;
  }

  return {
    avdName,
    deviceId,
    ownedEmulatorPids,
    ownerPid,
    startedAtInMilliseconds
  };
}
