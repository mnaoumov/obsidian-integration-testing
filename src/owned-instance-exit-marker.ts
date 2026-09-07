/**
 * @file
 *
 * Records that the harness-owned Obsidian instance on a CDP port died, so a
 * process that did not spawn it can still say **why** it is unreachable.
 *
 * Only the process that launched the instance holds the child handle and sees
 * `exit`; the test workers get nothing but the port (see the repo's L9). So the
 * one fact worth having — the exit code — has to cross a process boundary, and
 * this is the channel: a small JSON sentinel next to the setup lock
 * (`setup-lock.ts`) and the Appium server marker (`appium-server-marker.ts`),
 * keyed by port.
 *
 * Written **only for a death the harness did not order.** A deliberate kill
 * (teardown, or the relaunch loop killing an instance before starting the next)
 * clears the marker instead, because a marker left behind by a clean run would
 * convict the next run's healthy instance of an exit that never happened.
 *
 * Reads are deliberately tolerant, exactly as the Appium marker's are: missing,
 * unreadable, or describing another port all read as "no marker", and the
 * caller falls back to saying only that the instance is gone.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log } from './log.ts';

const MARKER_DIR_NAME = 'obsidian-integration-testing';
const MARKER_FILE_SUFFIX = '.owned-instance-exit.json';

/**
 * Records the death of the owned instance that was serving CDP on a port.
 */
export interface OwnedInstanceExitMarker {
  /**
  Exit code, or `null` when terminated by a signal or when it failed to spawn.
   */
  readonly code: null | number;

  /**
  When the instance exited (`Date.now()` epoch milliseconds).
   */
  readonly exitedAtInMilliseconds: number;

  /**
  The tail of everything the instance wrote to stdout/stderr (empty when it wrote nothing).
   */
  readonly outputTail: string;

  /**
  PID of the instance's process, or `undefined` when it never got one.
   */
  readonly pid: number | undefined;

  /**
  The CDP port the dead instance was serving.
   */
  readonly port: number;

  /**
  Terminating signal, or `null` when it exited normally or failed to spawn.
   */
  readonly signal: NodeJS.Signals | null;

  /**
  The spawn-failure message when the instance never started (e.g. `ENOENT`), otherwise absent.
   */
  readonly spawnError?: string | undefined;
}

/**
 * Parameters for {@link writeOwnedInstanceExitMarker}.
 */
export interface WriteOwnedInstanceExitMarkerParams {
  /**
  Exit code, or `null` when terminated by a signal or when it failed to spawn.
   */
  readonly code: null | number;

  /**
  The tail of everything the instance wrote to stdout/stderr.
   */
  readonly outputTail: string;

  /**
  PID of the instance's process, or `undefined` when it never got one.
   */
  readonly pid: number | undefined;

  /**
  The CDP port the dead instance was serving.
   */
  readonly port: number;

  /**
  Terminating signal, or `null` when it exited normally or failed to spawn.
   */
  readonly signal: NodeJS.Signals | null;

  /**
  The spawn-failure message when the instance never started, otherwise absent.
   */
  readonly spawnError?: string | undefined;
}

/**
 * Removes the marker for a port. Called when an instance is launched on it (a
 * recycled port must not inherit an older instance's death) and whenever the
 * harness kills an instance on purpose.
 *
 * @param port - The CDP port.
 */
export function clearOwnedInstanceExitMarker(port: number): void {
  try {
    rmSync(getMarkerFilePath(port), { force: true });
  } catch (error: unknown) {
    log(`[owned-instance-exit-marker] Could not remove the marker for port ${String(port)}: ${getErrorMessage(error)}`);
  }
}

/**
 * Reads the marker for a port.
 *
 * @param port - The CDP port.
 * @returns The marker, or `undefined` when there is none, it is unreadable, or it does not describe this port.
 */
export function readOwnedInstanceExitMarker(port: number): OwnedInstanceExitMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getMarkerFilePath(port), 'utf-8'));
  } catch {
    return undefined;
  }

  return parseMarker(parsed, port);
}

/**
 * Records that the instance serving a port has died, stamping it with the
 * current time so a reader can report how long ago it happened.
 *
 * @param params - The dead instance's port, exit details, and output tail.
 */
export function writeOwnedInstanceExitMarker(params: WriteOwnedInstanceExitMarkerParams): void {
  const marker: OwnedInstanceExitMarker = {
    code: params.code,
    exitedAtInMilliseconds: Date.now(),
    outputTail: params.outputTail,
    pid: params.pid,
    port: params.port,
    signal: params.signal,
    ...(params.spawnError !== undefined && { spawnError: params.spawnError })
  };

  try {
    mkdirSync(getMarkerDirectory(), { recursive: true });
    writeFileSync(getMarkerFilePath(marker.port), JSON.stringify(marker));
  } catch (error: unknown) {
    log(`[owned-instance-exit-marker] Could not record the exit on port ${String(marker.port)}: ${getErrorMessage(error)}`);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getMarkerDirectory(): string {
  return join(tmpdir(), MARKER_DIR_NAME);
}

function getMarkerFilePath(port: number): string {
  return join(getMarkerDirectory(), `${String(port)}${MARKER_FILE_SUFFIX}`);
}

function parseMarker(parsed: unknown, port: number): OwnedInstanceExitMarker | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const { code, exitedAtInMilliseconds, outputTail, pid, port: markedPort, signal, spawnError } = record;

  if (typeof exitedAtInMilliseconds !== 'number' || markedPort !== port) {
    return undefined;
  }

  return {
    code: typeof code === 'number' ? code : null,
    exitedAtInMilliseconds,
    outputTail: typeof outputTail === 'string' ? outputTail : '',
    pid: typeof pid === 'number' ? pid : undefined,
    port,
    signal: typeof signal === 'string' ? signal as NodeJS.Signals : null,
    ...(typeof spawnError === 'string' && { spawnError })
  };
}
