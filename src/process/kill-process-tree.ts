/**
 * @file
 *
 * Cross-platform helper to kill a child process and its entire process tree.
 */

/* v8 ignore start -- Integration-time process management covered by integration tests, not unit tests. */

import type { ChildProcess } from 'node:child_process';

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { log } from '../log.ts';
import { exec } from './exec.ts';
import { checkIsProcessAlive } from './process-liveness.ts';

const TASKKILL_TIMEOUT_IN_MILLISECONDS = 5000;
const PROCESS_EXIT_TIMEOUT_IN_MILLISECONDS = 1000;
const PROCESS_EXIT_POLL_INTERVAL_IN_MILLISECONDS = 50;

/**
 * Kills a child process and its entire process tree.
 *
 * @param child - The child process to kill.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }

  killProcessTreeByPid(child.pid);
}

/**
 * Kills a process tree by PID, for a process this run did not spawn itself — an
 * Appium server left listening by an earlier run, identified through its marker
 * (`appium-server-marker.ts`).
 *
 * On Windows, `child.kill()` only sends SIGTERM to the direct process,
 * leaving spawned grandchildren (e.g. Electron renderer/GPU helpers, QEMU,
 * UiAutomator) alive. `taskkill /F /T /PID` forcefully terminates the entire tree.
 *
 * @param pid - The PID whose process tree to kill.
 */
export function killProcessTreeByPid(pid: number): void {
  if (process.platform === 'win32') {
    try {
      // Piped rather than ignored, so a failure names its cause: "not found" (already exited) and "Access is denied" need different answers.
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: TASKKILL_TIMEOUT_IN_MILLISECONDS
      });
    } catch (error: unknown) {
      log(
        `[kill-process-tree] taskkill for PID ${String(pid)} failed (may have already exited): ${error instanceof Error ? error.message.trim() : 'unknown error'}`
      );
      terminateIfStillAlive(pid);
    }
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error: unknown) {
    log(
      `[kill-process-tree] SIGKILL for PID ${String(pid)} failed (may have already exited): ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
}

/**
 * Kills a process tree without blocking the harness event loop. A stalled
 * Windows WMI tree walk is bounded and falls back to direct termination.
 *
 * @param pid - The process whose tree to kill.
 */
export async function killProcessTreeByPidAsync(pid: number): Promise<void> {
  if (!checkIsProcessAlive(pid)) {
    return;
  }

  if (process.platform !== 'win32') {
    killProcessTreeByPid(pid);
    await waitForProcessExit(pid);
    return;
  }

  try {
    await exec(['taskkill', '/F', '/T', '/PID', String(pid)], {
      isQuiet: true,
      timeoutInMilliseconds: TASKKILL_TIMEOUT_IN_MILLISECONDS
    });
  } catch (error: unknown) {
    // Exiting between the listener snapshot and taskkill is successful cleanup.
    if (!checkIsProcessAlive(pid)) {
      return;
    }
    log(`[kill-process-tree] taskkill for PID ${String(pid)} failed: ${error instanceof Error ? error.message.trim() : 'unknown error'}`);
    terminateIfStillAlive(pid);
  }
  await waitForProcessExit(pid);
}

/**
 * Terminates a process directly when `taskkill` failed but the process lives on.
 *
 * `taskkill /T` walks the tree through WMI, and a host whose WMI is unwell fails
 * the whole call with `ERROR: The requested object does not exist.` while the
 * process keeps running — measured on an owned Obsidian instance, which then
 * outlived its run. `process.kill` is a plain `TerminateProcess` with no WMI in
 * the way. It reaches the one process only, which is enough for an Electron
 * browser process: its children exit when it does.
 *
 * @param pid - The PID `taskkill` failed to kill.
 */
function terminateIfStillAlive(pid: number): void {
  if (!checkIsProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
    log(`[kill-process-tree] PID ${String(pid)} was still alive after taskkill failed; terminated it directly (its own children were not walked).`);
  } catch (error: unknown) {
    log(`[kill-process-tree] Direct termination of PID ${String(pid)} failed too: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Gives a terminated process time to release its handles before the caller
 * checks for survivors. Command completion does not imply process exit.
 *
 * @param pid - The process whose exit to observe.
 */
async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_IN_MILLISECONDS;
  while (checkIsProcessAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PROCESS_EXIT_POLL_INTERVAL_IN_MILLISECONDS);
    });
  }
}

/* v8 ignore stop */
