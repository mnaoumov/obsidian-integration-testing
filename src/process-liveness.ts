/**
 * @file
 *
 * Cheap, synchronous "is this PID still running?" probe.
 *
 * Signal `0` performs the permission and existence checks without delivering a
 * signal, on Windows as well as POSIX, so it costs nothing at teardown-poll
 * frequency. `EPERM` means the process exists but is owned by another user —
 * still alive, and the distinction matters: reading it as dead is how a
 * teardown convinces itself a process it could not touch is gone.
 */

import process from 'node:process';

const PROCESS_EXISTENCE_PROBE_SIGNAL = 0;

/**
 * Checks whether a process is still running.
 *
 * @param pid - The PID to probe.
 * @returns `true` when the process exists.
 */
export function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, PROCESS_EXISTENCE_PROBE_SIGNAL);
    return true;
  } catch (error: unknown) {
    return getErrorCode(error) === 'EPERM';
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}
