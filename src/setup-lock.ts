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
 * handlers). The lock is a sentinel file in a shared temp directory, and its
 * holder keeps a **heartbeat** timestamp inside it fresh for as long as it holds
 * the lock — so a run that crashed without releasing stops beating and the next
 * run detects the lock as stale and steals it.
 *
 * The heartbeat, not the holder's PID, is what proves a holder is still there: a
 * PID probe only answers "does *a* process with this PID exist", which a
 * recycled PID satisfies long after the real holder died — leaving every later
 * run to block for the full acquisition timeout.
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

import { errorToString } from './error-to-string.ts';
import { log } from './log.ts';

const LOCK_DIR_NAME = 'obsidian-integration-testing';
const LOCK_FILE_SUFFIX = '.setup.lock';
const POLL_INTERVAL_IN_MILLISECONDS = 500;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const HEARTBEAT_INTERVAL_IN_SECONDS = 5;
const HEARTBEAT_INTERVAL_IN_MILLISECONDS = HEARTBEAT_INTERVAL_IN_SECONDS * MILLISECONDS_PER_SECOND;
// Generous on purpose: a dead holder is normally caught instantly by the PID
// Probe, so this threshold only has to cover the recycled-PID case. Two minutes
// Keeps a holder that blocks its event loop during heavy synchronous work (a
// Large vault sync, an installer unpack) from being robbed while it is alive.
const MISSED_HEARTBEATS_BEFORE_STALE = 24;
const HEARTBEAT_STALE_IN_MILLISECONDS = HEARTBEAT_INTERVAL_IN_MILLISECONDS * MISSED_HEARTBEATS_BEFORE_STALE;
const WAIT_LOG_INTERVAL_IN_SECONDS = 30;
const WAIT_LOG_INTERVAL_IN_MILLISECONDS = WAIT_LOG_INTERVAL_IN_SECONDS * MILLISECONDS_PER_SECOND;
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
 * Parameters for {@link createLockHandle}.
 */
interface CreateLockHandleParams {
  /** The transport label of this run. */
  readonly label: string;

  /** The path to the lock file this run just created. */
  readonly lockFilePath: string;

  /** The lock info this run wrote when it acquired the lock. */
  readonly ownInfo: LockFileInfo;

  /** The lock scope, for log messages. */
  readonly scope: string;
}

/**
 * Parameters for {@link createTimeoutError}.
 */
interface CreateTimeoutErrorParams {
  /** The current holder's lock info, or `null` if it could not be read. */
  readonly info: LockFileInfo | null;

  /** The lock scope. */
  readonly scope: string;

  /** The timeout that elapsed. */
  readonly timeoutInMilliseconds: number;
}

/**
 * Parameters for {@link formatWaitMessage}.
 */
interface FormatWaitMessageParams {
  /** The current holder's lock info, or `null` if it could not be read. */
  readonly info: LockFileInfo | null;

  /** The transport label of the waiting run. */
  readonly label: string;

  /** How much of the acquisition timeout is left. */
  readonly remainingInMilliseconds: number;

  /** The lock scope. */
  readonly scope: string;

  /** How long this run has been waiting so far. */
  readonly waitedInMilliseconds: number;
}

/**
 * The JSON payload stored inside a lock file, identifying the holder.
 */
interface LockFileInfo {
  /** When the lock was acquired (`Date.now()` epoch milliseconds). */
  readonly acquiredAtInMilliseconds: number;

  /**
   * When the holder last proved it was still alive (`Date.now()` epoch
   * milliseconds), refreshed every {@link HEARTBEAT_INTERVAL_IN_MILLISECONDS}
   * while the lock is held.
   *
   * Absent in a lock file written by an older version of this package, which
   * stamped the PID but never beat.
   */
  readonly heartbeatAtInMilliseconds?: number | undefined;

  /** The host that holds the lock (PID liveness is only valid on the same host). */
  readonly hostname: string;

  /** The transport label of the holding run. */
  readonly label: string;

  /** The process ID of the holding run. */
  readonly pid: number;
}

/**
 * Parameters for {@link refreshHeartbeat}.
 */
interface RefreshHeartbeatParams {
  /** The transport label of this run. */
  readonly label: string;

  /** The path to the lock file to refresh. */
  readonly lockFilePath: string;

  /** The lock info this run wrote when it acquired the lock. */
  readonly ownInfo: LockFileInfo;
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

  const startedAtInMilliseconds = Date.now();
  const deadlineInMilliseconds = startedAtInMilliseconds + timeoutInMilliseconds;
  let lastLoggedWaitAtInMilliseconds: null | number = null;

  for (;;) {
    const ownInfo = tryCreateLockFile(lockFilePath, label);
    if (ownInfo) {
      return createLockHandle({
        label,
        lockFilePath,
        ownInfo,
        scope
      });
    }

    const info = readLockFileInfo(lockFilePath);
    if (info && checkIsLockStale(info)) {
      log(`[integration-setup:${label}] Stealing stale '${scope}' setup lock from ${describeInfo(info)}.`);
      rmSync(lockFilePath, { force: true });
      // Retry immediately — but still honour the deadline, so a lock that a
      // Competing run keeps recreating cannot spin this loop forever.
      if (Date.now() >= deadlineInMilliseconds) {
        throw createTimeoutError({
          info,
          scope,
          timeoutInMilliseconds
        });
      }
      continue;
    }

    const nowInMilliseconds = Date.now();
    if (nowInMilliseconds >= deadlineInMilliseconds) {
      throw createTimeoutError({
        info,
        scope,
        timeoutInMilliseconds
      });
    }

    const shouldLogWait = lastLoggedWaitAtInMilliseconds === null
      || nowInMilliseconds - lastLoggedWaitAtInMilliseconds >= WAIT_LOG_INTERVAL_IN_MILLISECONDS;
    if (shouldLogWait) {
      lastLoggedWaitAtInMilliseconds = nowInMilliseconds;
      log(formatWaitMessage({
        info,
        label,
        remainingInMilliseconds: deadlineInMilliseconds - nowInMilliseconds,
        scope,
        waitedInMilliseconds: nowInMilliseconds - startedAtInMilliseconds
      }));
    }

    await delay(POLL_INTERVAL_IN_MILLISECONDS);
  }
}

/**
 * Determines whether a lock can be considered abandoned.
 *
 * A live holder refreshes its heartbeat every
 * {@link HEARTBEAT_INTERVAL_IN_MILLISECONDS}, so a heartbeat that stopped means
 * the holder is gone. That is the primary signal, because the recorded PID alone
 * cannot be trusted: {@link checkIsProcessAlive} only answers "does *a* process
 * with this PID exist", which a recycled PID satisfies long after the holder
 * died.
 *
 * On the same host a dead PID is still an immediate give-away, so it is kept as
 * a fast path. On a different host (a shared/network temp directory) the PID
 * cannot be probed at all and the two clocks may disagree, so the much wider
 * {@link STALE_LOCK_AGE_IN_MILLISECONDS} threshold is used instead.
 *
 * @param info - The parsed lock info.
 * @returns `true` if the lock is stale and may be stolen.
 */
function checkIsLockStale(info: LockFileInfo): boolean {
  const silentForInMilliseconds = Date.now() - getLastSeenAtInMilliseconds(info);

  if (info.hostname === hostname()) {
    return !checkIsProcessAlive(info.pid) || silentForInMilliseconds > HEARTBEAT_STALE_IN_MILLISECONDS;
  }

  return silentForInMilliseconds > STALE_LOCK_AGE_IN_MILLISECONDS;
}

/**
 * Determines whether a lock file still names this process as its holder.
 *
 * @param info - The parsed lock info.
 * @returns `true` if this process holds the lock.
 */
function checkIsOwnLock(info: LockFileInfo): boolean {
  return info.pid === process.pid && info.hostname === hostname();
}

/**
 * Checks whether a process with the given PID is currently alive.
 *
 * @param pid - The process ID to probe.
 * @returns `true` if the process exists.
 */
function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, PROCESS_EXISTENCE_PROBE_SIGNAL);
    return true;
  } catch (error: unknown) {
    // `EPERM` means the process exists but is owned by another user — still alive.
    return getErrorCode(error) === 'EPERM';
  }
}

/**
 * Creates a {@link SetupLock} handle that keeps the lock's heartbeat fresh while
 * held and removes the lock file on release.
 *
 * The heartbeat timer is `unref`ed so it can never keep the process alive on its
 * own, and it stops as soon as the lock file names somebody else — a run whose
 * lock was stolen must not overwrite its successor's lock, nor delete it on
 * release.
 *
 * @param params - The handle parameters.
 * @returns The lock handle.
 */
function createLockHandle(params: CreateLockHandleParams): SetupLock {
  const {
    label,
    lockFilePath,
    ownInfo,
    scope
  } = params;
  let isReleased = false;

  const heartbeatTimer = setInterval(() => {
    const isStillOurs = refreshHeartbeat({
      label,
      lockFilePath,
      ownInfo
    });
    if (isStillOurs) {
      return;
    }
    clearInterval(heartbeatTimer);
    log(`[integration-setup:${label}] The '${scope}' setup lock is no longer ours — another run took it over. Heartbeat stopped.`);
  }, HEARTBEAT_INTERVAL_IN_MILLISECONDS);
  heartbeatTimer.unref();

  return {
    release(): void {
      if (isReleased) {
        return;
      }
      isReleased = true;
      clearInterval(heartbeatTimer);

      const info = readLockFileInfo(lockFilePath);
      if (info && !checkIsOwnLock(info)) {
        log(`[integration-setup:${label}] Leaving the '${scope}' setup lock in place — it now belongs to ${describeInfo(info)}.`);
        return;
      }
      rmSync(lockFilePath, { force: true });
    }
  };
}

/**
 * Builds the error thrown when the lock could not be acquired in time.
 *
 * @param params - The error parameters.
 * @returns The error to throw.
 */
function createTimeoutError(params: CreateTimeoutErrorParams): Error {
  const {
    info,
    scope,
    timeoutInMilliseconds
  } = params;
  return new Error(
    `Timed out after ${String(timeoutInMilliseconds)}ms waiting for the '${scope}' integration-test setup lock `
      + `held by ${describeHolder(info)}. Another integration-test run is still in progress.`
  );
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
 * @param info - The parsed lock info, or `null` if it could not be read.
 * @returns A description string.
 */
function describeHolder(info: LockFileInfo | null): string {
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
 * Formats a duration as a compact `1m 30s` / `45s` string for progress logs.
 *
 * @param milliseconds - The duration in milliseconds.
 * @returns The formatted duration.
 */
function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / MILLISECONDS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return minutes > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(seconds)}s`;
}

/**
 * Builds the periodic "still waiting" progress line, so a legitimate multi-minute
 * wait is distinguishable from a hang in the terminal.
 *
 * @param params - The message parameters.
 * @returns The message to log.
 */
function formatWaitMessage(params: FormatWaitMessageParams): string {
  const {
    info,
    label,
    remainingInMilliseconds,
    scope,
    waitedInMilliseconds
  } = params;
  const heldFor = info ? `, held for ${formatDuration(Date.now() - info.acquiredAtInMilliseconds)}` : '';
  return `[integration-setup:${label}] Waiting for the '${scope}' setup lock held by ${describeHolder(info)} to be released `
    + `(waited ${formatDuration(waitedInMilliseconds)}${heldFor}, giving up in ${formatDuration(remainingInMilliseconds)})...`;
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
 * Returns when the holder was last known to be alive — its most recent heartbeat,
 * falling back to its acquisition time for a lock file written by an older
 * version of this package that stamped no heartbeat at all.
 *
 * @param info - The parsed lock info.
 * @returns The epoch milliseconds of the holder's last sign of life.
 */
function getLastSeenAtInMilliseconds(info: LockFileInfo): number {
  return info.heartbeatAtInMilliseconds ?? info.acquiredAtInMilliseconds;
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
 * Reads and parses the lock file, if it exists and is valid JSON.
 *
 * @param lockFilePath - The path to the lock file.
 * @returns The parsed lock info, or `null` if it could not be read.
 */
function readLockFileInfo(lockFilePath: string): LockFileInfo | null {
  try {
    return JSON.parse(readFileSync(lockFilePath, 'utf-8')) as LockFileInfo;
  } catch {
    return null;
  }
}

/**
 * Rewrites the lock file with a fresh heartbeat timestamp, so waiting runs can
 * tell this holder apart from a crashed one whose PID has been recycled.
 *
 * A lock file that is missing or unreadable is still treated as ours and rewritten:
 * this run never released, so its claim stands.
 *
 * @param params - The refresh parameters.
 * @returns `true` while the lock is still ours, `false` once another run owns it.
 */
function refreshHeartbeat(params: RefreshHeartbeatParams): boolean {
  const {
    label,
    lockFilePath,
    ownInfo
  } = params;

  const info = readLockFileInfo(lockFilePath);
  if (info && !checkIsOwnLock(info)) {
    return false;
  }

  const refreshedInfo: LockFileInfo = {
    ...ownInfo,
    heartbeatAtInMilliseconds: Date.now()
  };
  try {
    writeFileSync(lockFilePath, JSON.stringify(refreshedInfo));
  } catch (error: unknown) {
    // Not fatal: the lock is still held and will still be released. Only its
    // Heartbeat goes stale, which at worst lets a waiting run steal it.
    log(`[integration-setup:${label}] Failed to refresh the setup lock heartbeat: ${errorToString(error)}`);
  }
  return true;
}

/**
 * Attempts to atomically create the lock file (failing if it already exists).
 *
 * @param lockFilePath - The path to the lock file.
 * @param label - The transport label to record in the lock file.
 * @returns The lock info written on success, or `null` if the lock is already held.
 * @throws If the file system fails for any reason other than the file existing.
 */
function tryCreateLockFile(lockFilePath: string, label: string): LockFileInfo | null {
  const nowInMilliseconds = Date.now();
  const info: LockFileInfo = {
    acquiredAtInMilliseconds: nowInMilliseconds,
    heartbeatAtInMilliseconds: nowInMilliseconds,
    hostname: hostname(),
    label,
    pid: process.pid
  };

  try {
    writeFileSync(lockFilePath, JSON.stringify(info), { flag: 'wx' });
    return info;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'EEXIST') {
      return null;
    }
    throw error;
  }
}
