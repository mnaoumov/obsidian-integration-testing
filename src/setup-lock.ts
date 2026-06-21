/**
 * @file
 *
 * Cross-process advisory lock that serializes whole integration-test runs.
 *
 * Two test runs that drive the same shared resources corrupt each other: on
 * desktop they share the single local Obsidian instance, its `obsidian.json`
 * registry, and the CDP port; on Android they share the emulator and the Appium
 * server. One run's setup/teardown kills or reconfigures the instance the other
 * run is mid-eval on (observed as `ECONNREFUSED` or "vault not open"), so both
 * runs fail.
 *
 * This lock makes the second run **wait** for the first to finish instead of
 * running concurrently. It is held for the entire run: acquired at the start of
 * the core setup and released by the core teardown (and by the process cleanup
 * handlers). The lock is a sentinel file in a shared temp directory, carrying
 * the holder's PID so a run that crashed without releasing leaves a lock that
 * the next run detects as stale and steals.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {
  hostname,
  tmpdir
} from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { log } from './log.ts';

const LOCK_DIR_NAME = 'obsidian-integration-testing';
const LOCK_FILE_SUFFIX = '.setup.lock';
const POLL_INTERVAL_IN_MILLISECONDS = 500;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const STALE_LOCK_AGE_IN_MINUTES = 30;
const DEFAULT_TIMEOUT_IN_MINUTES = 60;
const STALE_LOCK_AGE_IN_MILLISECONDS = STALE_LOCK_AGE_IN_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const DEFAULT_TIMEOUT_IN_MILLISECONDS = DEFAULT_TIMEOUT_IN_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const PROCESS_EXISTENCE_PROBE_SIGNAL = 0;

/**
 * Parameters for {@link acquireSetupLock}.
 */
export interface AcquireSetupLockParams {
  /** Short transport label for log messages (e.g. `"obsidian-cli"`). */
  readonly label: string;

  /**
   * Logical scope the lock serializes within. Runs that share resources must
   * use the same scope (e.g. `"desktop"` for the CLI/CDP transports, `"android"`
   * for the Appium transport).
   */
  readonly scope: string;

  /**
   * Maximum time to wait for a competing run to release the lock before giving
   * up and throwing.
   *
   * @default 1 hour
   */
  readonly timeoutInMilliseconds?: number | undefined;
}

/**
 * A held setup lock. Release it once the run's teardown is complete.
 */
export interface SetupLock {
  /** Releases the lock. Safe to call more than once. */
  release(): void;
}

/**
 * The JSON payload stored inside a lock file, identifying the holder.
 */
interface LockFileInfo {
  /** When the lock was acquired (`Date.now()` epoch milliseconds). */
  readonly acquiredAtInMilliseconds: number;

  /** The host that holds the lock (PID liveness is only valid on the same host). */
  readonly hostname: string;

  /** The transport label of the holding run. */
  readonly label: string;

  /** The process ID of the holding run. */
  readonly pid: number;
}

/**
 * Acquires the cross-process setup lock for the given scope, waiting until any
 * competing run releases it (or its lock is detected as stale).
 *
 * @param params - The lock parameters.
 * @returns A handle whose {@link SetupLock.release} frees the lock.
 * @throws If the lock cannot be acquired within `timeoutInMilliseconds`.
 */
export async function acquireSetupLock(params: AcquireSetupLockParams): Promise<SetupLock> {
  const {
    label,
    scope
  } = params;
  const timeoutInMilliseconds = params.timeoutInMilliseconds ?? DEFAULT_TIMEOUT_IN_MILLISECONDS;
  const lockFilePath = getLockFilePath(scope);
  mkdirSync(getLockDir(), { recursive: true });

  const deadlineInMilliseconds = Date.now() + timeoutInMilliseconds;
  let hasLoggedWait = false;

  for (;;) {
    if (tryCreateLockFile(lockFilePath, label)) {
      return createLockHandle(lockFilePath);
    }

    const info = readLockFileInfo(lockFilePath);
    if (info && isLockStale(info)) {
      log(`[integration-setup:${label}] Stealing stale '${scope}' setup lock from ${describeInfo(info)}.`);
      rmSync(lockFilePath, { force: true });
      continue;
    }

    if (Date.now() >= deadlineInMilliseconds) {
      throw new Error(
        `Timed out after ${String(timeoutInMilliseconds)}ms waiting for the '${scope}' integration-test setup lock `
          + `held by ${describeHolder(info)}. Another integration-test run is still in progress.`
      );
    }

    if (!hasLoggedWait) {
      hasLoggedWait = true;
      log(`[integration-setup:${label}] Waiting for the '${scope}' setup lock held by ${describeHolder(info)} to be released...`);
    }

    await delay(POLL_INTERVAL_IN_MILLISECONDS);
  }
}

/**
 * Creates a {@link SetupLock} handle that removes the lock file on release.
 *
 * @param lockFilePath - The path to the lock file to remove on release.
 * @returns The lock handle.
 */
function createLockHandle(lockFilePath: string): SetupLock {
  let isReleased = false;
  return {
    release(): void {
      if (isReleased) {
        return;
      }
      isReleased = true;
      rmSync(lockFilePath, { force: true });
    }
  };
}

/**
 * Resolves after the given delay. Used to poll between lock-acquisition attempts.
 *
 * @param milliseconds - The delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Builds a human-readable description of the current lock holder for log/error
 * messages.
 *
 * @param info - The parsed lock info, or `undefined` if it could not be read.
 * @returns A description string.
 */
function describeHolder(info: LockFileInfo | undefined): string {
  return info ? describeInfo(info) : 'another run';
}

/**
 * Formats a {@link LockFileInfo} as a short identifier string.
 *
 * @param info - The lock info.
 * @returns A string like `pid 1234 (obsidian-cli) on host`.
 */
function describeInfo(info: LockFileInfo): string {
  return `pid ${String(info.pid)} (${info.label}) on ${info.hostname}`;
}

/**
 * Extracts the `code` from a Node.js system error, if present.
 *
 * @param error - The thrown value.
 * @returns The error code string, or `undefined` if not a coded error.
 */
function getErrorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

/**
 * Returns the shared lock directory inside the OS temp directory.
 *
 * @returns The absolute path to the lock directory.
 */
function getLockDir(): string {
  return join(tmpdir(), LOCK_DIR_NAME);
}

/**
 * Returns the lock file path for the given scope.
 *
 * @param scope - The lock scope.
 * @returns The absolute path to the scope's lock file.
 */
function getLockFilePath(scope: string): string {
  return join(getLockDir(), `${scope}${LOCK_FILE_SUFFIX}`);
}

/**
 * Determines whether a lock can be considered abandoned.
 *
 * On the same host, the holder's PID is probed directly: a dead PID means the
 * run crashed without releasing. On a different host (a shared/network temp
 * directory) the PID cannot be probed, so an age threshold is used instead.
 *
 * @param info - The parsed lock info.
 * @returns `true` if the lock is stale and may be stolen.
 */
function isLockStale(info: LockFileInfo): boolean {
  if (info.hostname === hostname()) {
    return !isProcessAlive(info.pid);
  }

  return Date.now() - info.acquiredAtInMilliseconds > STALE_LOCK_AGE_IN_MILLISECONDS;
}

/**
 * Checks whether a process with the given PID is currently alive.
 *
 * @param pid - The process ID to probe.
 * @returns `true` if the process exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, PROCESS_EXISTENCE_PROBE_SIGNAL);
    return true;
  } catch (error: unknown) {
    // `EPERM` means the process exists but is owned by another user — still alive.
    return getErrorCode(error) === 'EPERM';
  }
}

/**
 * Reads and parses the lock file, if it exists and is valid JSON.
 *
 * @param lockFilePath - The path to the lock file.
 * @returns The parsed lock info, or `undefined` if it could not be read.
 */
function readLockFileInfo(lockFilePath: string): LockFileInfo | undefined {
  try {
    return JSON.parse(readFileSync(lockFilePath, 'utf-8')) as LockFileInfo;
  } catch {
    return undefined;
  }
}

/**
 * Attempts to atomically create the lock file (failing if it already exists).
 *
 * @param lockFilePath - The path to the lock file.
 * @param label - The transport label to record in the lock file.
 * @returns `true` if the lock was acquired, `false` if it is already held.
 * @throws If the file system fails for any reason other than the file existing.
 */
function tryCreateLockFile(lockFilePath: string, label: string): boolean {
  const info: LockFileInfo = {
    acquiredAtInMilliseconds: Date.now(),
    hostname: hostname(),
    label,
    pid: process.pid
  };

  try {
    writeFileSync(lockFilePath, JSON.stringify(info), { flag: 'wx' });
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'EEXIST') {
      return false;
    }
    throw error;
  }
}
