/**
 * @file
 *
 * Global setup for the `integration-tests:android-trusted-input` project: takes the shared-emulator setup
 * lock for the run, and releases it on teardown.
 *
 * This project has no transport global setup — each test owns its own `TemporaryVault` — so it never went
 * through `coreSetup`, which is what normally acquires this lock (**L7**). Without it the suite would boot
 * an Appium session against the one shared emulator while another repo's android aggregate was mid-run, and
 * the two would corrupt each other (`ECONNREFUSED`, "vault not open") — the exact collision the lock exists
 * to prevent. Observed live: the lock file read `FREE` while this project was running.
 *
 * The scope string must match the one `coreSetup` uses for the Appium transport, or the two would take
 * different locks and serialize against nothing.
 */
/* v8 ignore start -- Integration-time setup covered by the Android integration suite, not unit tests. */

import { execFileSync } from 'node:child_process';

import type { SetupLock } from '../src/setup-lock.ts';

import { acquireSetupLock } from '../src/setup-lock.ts';

const LOCK_SCOPE = 'android';
const LOCK_LABEL = 'obsidian-android-appium';
const ADB_TIMEOUT_IN_MILLISECONDS = 15_000;
// `adb forward --list` prints three columns: `<deviceId> tcp:<port> localabstract:<socketName>`.
const FORWARD_LIST_COLUMN_COUNT = 3;

let lock: SetupLock | undefined;

export async function setup(): Promise<void> {
  lock = await acquireSetupLock({ label: LOCK_LABEL, scope: LOCK_SCOPE });
}

export function teardown(): void {
  removeWebViewForwards();
  lock?.release();
  lock = undefined;
}

/**
 * Drops the adb port forwards the trusted-input channel opened, so a run leaves the device as it found it.
 *
 * This lives in the global-setup teardown, not in the transport, because the transport's own async and
 * `process.on('exit')` teardown paths are both unreliable here: Vitest terminates its workers abruptly, so
 * neither is guaranteed a turn (observed 2026-08-30 — a forward survived a fully passing run with both in
 * place). The main process's teardown does run, which is also what releases the lock below.
 *
 * Removing every `webview_devtools_remote_*` forward rather than one specific port is safe precisely
 * because the lock above is still held: no other Obsidian Android run can be in flight.
 */
function removeWebViewForwards(): void {
  try {
    const forwardList = execFileSync('adb', ['forward', '--list'], {
      encoding: 'utf-8',
      timeout: ADB_TIMEOUT_IN_MILLISECONDS
    });

    for (const line of forwardList.split('\n')) {
      const [deviceId, local, remote] = line.trim().split(/\s+/, FORWARD_LIST_COLUMN_COUNT);
      if (!deviceId || !local?.startsWith('tcp:') || !remote?.startsWith('localabstract:webview_devtools_remote_')) {
        continue;
      }

      execFileSync('adb', ['-s', deviceId, 'forward', '--remove', local], {
        stdio: 'ignore',
        timeout: ADB_TIMEOUT_IN_MILLISECONDS
      });
    }
  } catch {
    // Best effort: adb drops every forward when the device disconnects anyway.
  }
}

/* v8 ignore stop */
