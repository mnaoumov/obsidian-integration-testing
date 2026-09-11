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
 *
 * **The environment quiets `netsimd`, because nothing else can.** The emulator
 * starts `netsimd`, its network simulator, and netsimd has a loop that never
 * checks its hostapd socket for end-of-file: once that socket closes, every
 * pass decodes an empty Wi-Fi frame and logs the failure, with no rate limit.
 * On 2026-09-10 an idle emulator's netsimd wrote 278 GB of that one warning to
 * `%TEMP%\netsimd\netsim_stderr.log` in six hours, filling the drive. netsimd
 * has no flag to quiet it; its log level is `RUST_LOG`, read from the
 * environment it inherits. See **L56**.
 */

const DNS_SERVER = '8.8.8.8';

/**
 * The `RUST_LOG` filter the harness hands the emulator, and through it `netsimd`.
 *
 * `error` rather than a directive aimed at the one noisy module: nothing reads
 * netsimd's log, real failures are still recorded, and a level can be verified
 * by the absence of `netsimd I` lines where a module directive could only be
 * verified by reproducing the flood.
 */
export const NETSIM_LOG_FILTER = 'error';

const RUST_LOG_VARIABLE_NAME = 'RUST_LOG';

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
 * Result of {@link buildEmulatorEnvironment}.
 */
export interface EmulatorEnvironment {
  /**
  The environment to spawn the emulator with.
   */
  readonly environment: NodeJS.ProcessEnv;

  /**
   * Whether the harness set `RUST_LOG` itself. `false` means the caller's
   * environment already carried one, which wins — and which leaves netsimd's
   * log unbounded if it is `warn` or chattier.
   */
  readonly isNetsimLogGuarded: boolean;
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

/**
 * Builds the environment for spawning the Android emulator: the caller's own,
 * plus a `RUST_LOG` that keeps `netsimd`'s log bounded.
 *
 * An explicit `RUST_LOG` is left alone — someone who set it asked for that
 * level — and reported back so the caller can say the guard is off.
 *
 * @param baseEnvironment - The environment to extend, normally `process.env`.
 * @returns The environment, and whether the harness supplied the log filter.
 */
export function buildEmulatorEnvironment(baseEnvironment: NodeJS.ProcessEnv): EmulatorEnvironment {
  const existingFilter = baseEnvironment[RUST_LOG_VARIABLE_NAME];
  if (existingFilter !== undefined && existingFilter !== '') {
    return { environment: { ...baseEnvironment }, isNetsimLogGuarded: false };
  }

  return {
    environment: { ...baseEnvironment, [RUST_LOG_VARIABLE_NAME]: NETSIM_LOG_FILTER },
    isNetsimLogGuarded: true
  };
}
