/**
 * @file
 *
 * Records which Appium server on a port this harness started, so a later run
 * that finds a server already listening can tell **provenance**: one of our own
 * servers left over from an earlier run, or a foreign one the user manages.
 *
 * The preflight adopts any server that answers `/status`, and adoption is the
 * right default — starting a second server on an occupied port cannot work. But
 * adopting silently means a wedged leftover (see `wedged-appium-server.ts`) is
 * indistinguishable from a healthy server, and the harness has no basis on which
 * to decide whether restarting it is its call to make. The marker supplies that
 * basis: a server we started may be restarted, a foreign one is only ever
 * reported.
 *
 * The marker is a small JSON sentinel next to the setup lock (`setup-lock.ts`),
 * keyed by port, and is deliberately tolerant — a missing, unreadable, or
 * mismatched marker simply reads as "not ours".
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { log } from './log.ts';

const MARKER_DIR_NAME = 'obsidian-integration-testing';
const MARKER_FILE_SUFFIX = '.appium-server.json';
const PROCESS_EXISTENCE_PROBE_SIGNAL = 0;

/**
 * Identifies the Appium server this harness started on a port.
 */
export interface AppiumServerMarker {
  /**
  PID of the spawned server process (the shell wrapper that owns the server's process tree).
   */
  readonly pid: number;

  /**
  The port the server was started on.
   */
  readonly port: number;

  /**
  When the server was started (`Date.now()` epoch milliseconds).
   */
  readonly startedAtInMilliseconds: number;
}

/**
 * Parameters for {@link writeAppiumServerMarker}.
 */
export interface WriteAppiumServerMarkerParams {
  /**
  PID of the spawned server process.
   */
  readonly pid: number;

  /**
  The port the server was started on.
   */
  readonly port: number;
}

/**
 * Checks whether the marked server is still running, which is what makes an
 * adopted server ours to restart.
 *
 * A dead PID means the marker outlived its server, so whatever answers on that
 * port now is somebody else's — the marker proves nothing about it.
 *
 * @param marker - The marker read for the port, or `undefined` when there is none.
 * @returns `true` when an earlier run of this harness started the server now listening.
 */
export function checkIsHarnessOwnedAppiumServer(marker: AppiumServerMarker | undefined): boolean {
  if (!marker) {
    return false;
  }

  try {
    process.kill(marker.pid, PROCESS_EXISTENCE_PROBE_SIGNAL);
    return true;
  } catch (error: unknown) {
    // `EPERM` means the process exists but is owned by another user — still alive.
    return getErrorCode(error) === 'EPERM';
  }
}

/**
 * Removes the marker for a port. Called once the marked server has been stopped,
 * so a later run does not mistake a recycled PID for our server.
 *
 * @param port - The Appium server port.
 */
export function clearAppiumServerMarker(port: number): void {
  try {
    rmSync(getMarkerFilePath(port), { force: true });
  } catch (error: unknown) {
    log(`[appium-server-marker] Could not remove the marker for port ${String(port)}: ${getErrorMessage(error)}`);
  }
}

/**
 * Reads the marker for a port.
 *
 * @param port - The Appium server port.
 * @returns The marker, or `undefined` when there is none, it is unreadable, or it does not describe this port.
 */
export function readAppiumServerMarker(port: number): AppiumServerMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getMarkerFilePath(port), 'utf-8'));
  } catch {
    return undefined;
  }

  return parseMarker(parsed, port);
}

/**
 * Records the server this run just started, stamping it with the current time so
 * a later run can report how long it has been up.
 *
 * @param params - The started server's PID and port.
 */
export function writeAppiumServerMarker(params: WriteAppiumServerMarkerParams): void {
  const marker: AppiumServerMarker = {
    pid: params.pid,
    port: params.port,
    startedAtInMilliseconds: Date.now()
  };

  try {
    mkdirSync(getMarkerDirectory(), { recursive: true });
    writeFileSync(getMarkerFilePath(params.port), JSON.stringify(marker));
  } catch (error: unknown) {
    log(`[appium-server-marker] Could not record the server on port ${String(params.port)}: ${getErrorMessage(error)}`);
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
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

function parseMarker(parsed: unknown, port: number): AppiumServerMarker | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const { pid, port: markedPort, startedAtInMilliseconds } = record;

  if (typeof pid !== 'number' || typeof startedAtInMilliseconds !== 'number' || markedPort !== port) {
    return undefined;
  }

  return { pid, port, startedAtInMilliseconds };
}
