/**
 * @file
 *
 * Global setup for the `integration-tests:android-trusted-input` project: takes the shared-emulator setup
 * lock for the run, and on teardown stops the emulator the run's worker started, then releases the lock.
 *
 * This project has no transport global setup — each test owns its own `TemporaryVault` — so it never went
 * through `coreSetup`, which is what normally acquires this lock (**L7**). Without it the suite would boot
 * an Appium session against the one shared emulator while another repo's android aggregate was mid-run, and
 * the two would corrupt each other (`ECONNREFUSED`, "vault not open") — the exact collision the lock exists
 * to prevent. Observed live: the lock file read `FREE` while this project was running.
 *
 * The scope is `ANDROID_SETUP_LOCK_SCOPE`, the one `coreSetup` uses for the Appium transport — a different
 * string would take a different lock and serialize against nothing.
 */
/* v8 ignore start -- Integration-time setup covered by the Android integration suite, not unit tests. */

import { execFileSync } from 'node:child_process';

import type { SetupLock } from '../src/setup-lock.ts';

import {
  acquireSetupLock,
  ANDROID_SETUP_LOCK_SCOPE
} from '../src/setup-lock.ts';
import { stopHarnessStartedEmulators } from '../src/transport-factory.ts';

const LOCK_LABEL = 'obsidian-android-appium';
const ADB_TIMEOUT_IN_MILLISECONDS = 15_000;
// `adb forward --list` prints three columns: `<deviceId> tcp:<port> localabstract:<socketName>`.
const FORWARD_LIST_COLUMN_COUNT = 3;

let lock: SetupLock | undefined;

export async function setup(): Promise<void> {
  lock = await acquireSetupLock({ label: LOCK_LABEL, scope: ANDROID_SETUP_LOCK_SCOPE });
}

/**
 * Leaves the host as the run found it: no forwards, no emulator, no lock.
 *
 * The emulator stop is here for the same reason the forward cleanup is. This
 * project's transport lives in the test worker, so the worker is what
 * auto-starts the emulator — and Vitest ends the worker without a teardown, so
 * nothing ever stopped it. On 2026-09-10 the one this project left idle ran for
 * six hours until `netsimd`'s log filled the drive (**L56**). The worker's marker
 * is how this process, which never held the emulator, finds it; the lock, still
 * held, is what makes stopping it safe.
 */
export async function teardown(): Promise<void> {
  removeWebViewForwards();
  try {
    await stopHarnessStartedEmulators();
  } finally {
    lock?.release();
    lock = undefined;
  }
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
