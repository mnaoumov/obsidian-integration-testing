/**
 * @file
 *
 * Cross-platform helper to kill a child process and its entire process tree.
 */

/* v8 ignore start -- Integration-time process management covered by integration tests, not unit tests. */

import type { ChildProcess } from 'node:child_process';

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { log } from './log.ts';

/**
 * Kills a child process and its entire process tree.
 *
 * On Windows, `child.kill()` only sends SIGTERM to the direct process,
 * leaving spawned grandchildren (e.g. Electron renderer/GPU helpers, QEMU,
 * UiAutomator) alive. `taskkill /F /T /PID` forcefully terminates the entire tree.
 *
 * @param child - The child process to kill.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } catch (error: unknown) {
      log(
        `[kill-process-tree] taskkill for PID ${String(child.pid)} failed (may have already exited): ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  } else {
    child.kill('SIGKILL');
  }
}

/* v8 ignore stop */
