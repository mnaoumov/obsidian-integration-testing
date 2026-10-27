/**
 * @file
 *
 * Makes sure the adb server is running before a quick `adb` call needs it.
 *
 * A quick listing gets 5s (`ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS`). When no
 * server is running, that listing starts one first, the start outlasts the
 * budget, and the run failed in setup with `Failed to run 'adb devices': ...
 * daemon not running; starting now at tcp:5037`. A manual `adb start-server`
 * made the same run pass. So the harness starts the server itself, once per
 * process, under a budget sized for the start.
 *
 * Nothing here may import a module that reads the build-time `OBSIDIAN_METADATA`
 * global: `emulator-reclaim.ts` uses it, and the emulator reaper loads that
 * module under plain Node.
 */

/* v8 ignore start -- Integration-time code (shells out to adb) covered by the Android integration suite, not unit tests. */

import { execFile } from 'node:child_process';

/*
 * A cold start of the server took a few seconds on an idle host. 60s leaves room
 * for the contended host the Android budgets are sized for, and an already
 * running server answers at once, so the budget costs nothing then.
 */
const ADB_START_SERVER_TIMEOUT_IN_MILLISECONDS = 60_000;

let startPromise: Promise<void> | undefined;

/**
 * Starts the adb server unless this process already did.
 *
 * A failed start is not remembered, so the next call tries again.
 *
 * @param shouldForce - Start it again even if this process already did, for a server that has since stopped.
 * @returns A {@link Promise} that resolves once the server is running.
 * @throws Error if `adb start-server` failed.
 */
export async function ensureAdbServerStarted(shouldForce = false): Promise<void> {
  if (shouldForce) {
    startPromise = undefined;
  }

  startPromise ??= startAdbServer().catch((error: unknown) => {
    startPromise = undefined;
    throw error;
  });

  await startPromise;
}

async function startAdbServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('adb', ['start-server'], { timeout: ADB_START_SERVER_TIMEOUT_IN_MILLISECONDS }, (error, _stdout, stderr) => {
      if (error) {
        const reason = error.killed ? `no answer within ${String(ADB_START_SERVER_TIMEOUT_IN_MILLISECONDS)}ms` : error.message;
        reject(new Error(`Failed to run 'adb start-server': ${reason}. ${stderr.trim()} Is ADB installed and in PATH?`.trim()));
        return;
      }

      resolve();
    });
  });
}

/* v8 ignore stop */
