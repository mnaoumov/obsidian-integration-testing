/**
 * @file
 *
 * Builds the argument list for spawning the Android emulator.
 *
 * **The harness owns the snapshot it loads, or it loads none.** This file used
 * to pass `-no-snapshot-save` alone — the one combination that is never
 * correct. It never *writes* `default_boot`, yet every run *resumed* it, so the
 * guest each run started from was state nothing had validated since whenever a
 * human last saved it. Measured 2026-09-03, same AVD back to back:
 *
 * | Launch | Result |
 * | --- | --- |
 * | snapshot resumed (`-no-snapshot-save` alone) | guest dies ~90s in, every time |
 * | `-no-snapshot-load` (cold) | booted in 50s, alive at 60/120/180/240s |
 *
 * A resumed snapshot rots silently, and the failure it eventually produces —
 * a device that serves adb, accepts a session and then drops `offline` a
 * half-minute later — is indistinguishable from a code regression. So the
 * default is a full cold boot, and snapshot reuse is an explicit opt-in that
 * takes **both** halves: load and save together, so the snapshot the next run
 * resumes is one this run wrote.
 */

const DNS_SERVER = '8.8.8.8';

/**
 * Parameters for {@link buildEmulatorArguments}.
 */
export interface BuildEmulatorArgumentsParams {
  /**
  The Android Virtual Device name.
   */
  readonly avdName: string;

  /**
   * Whether to run the emulator headless (`-no-window`), so it never steals
   * focus. Resolved from the `isEmulatorVisible` transport option.
   */
  readonly isHidden: boolean;

  /**
   * Whether the emulator may resume — and refresh — the AVD's saved boot
   * snapshot. Resolved from the `shouldReuseEmulatorSnapshot` transport option.
   *
   * `false` (the default) cold-boots hermetically. `true` buys back the ~112s
   * boot on a persistent runner, at the cost of test isolation.
   */
  readonly shouldReuseSnapshot: boolean;
}

/**
 * Builds the argument list for spawning the Android emulator.
 *
 * @param params - The emulator argument parameters.
 * @returns The argument array to pass to the emulator binary.
 */
export function buildEmulatorArguments(params: BuildEmulatorArgumentsParams): string[] {
  const emulatorArguments = ['-avd', params.avdName];
  /*
   * Both flags or neither: loading without saving is the resume-what-we-never-
   * wrote combination this file's header exists to rule out.
   */
  if (!params.shouldReuseSnapshot) {
    emulatorArguments.push('-no-snapshot-load', '-no-snapshot-save');
  }
  emulatorArguments.push('-dns-server', DNS_SERVER);
  if (params.isHidden) {
    emulatorArguments.push('-no-window');
  }
  return emulatorArguments;
}
