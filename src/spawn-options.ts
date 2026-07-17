/**
 * @file
 *
 * Pure resolution of the `detached` / `windowsHide` spawn flags for the
 * auto-started Appium server and Android emulator, derived from whether their
 * console windows should be hidden.
 *
 * Kept separate from the integration-only launch code (`transport-factory`,
 * excluded from unit tests) so the flag resolution stays unit-testable — the
 * launcher itself needs a real Appium server / emulator. Mirrors the split in
 * `visibility.ts` and `emulator-args.ts`.
 *
 * **Why these exact flags** (empirically verified on Windows):
 * - `detached: true` sets `DETACHED_PROCESS`, which gives the child no console.
 *   For a console-subsystem child that means Windows/the child later allocates a
 *   **fresh, visible** console — and `windowsHide` (which only sets `SW_HIDE` on
 *   an inherited/new console at `CreateProcess` time) is silently defeated. So a
 *   process we want hidden must NOT be detached.
 * - Not detaching lets the child inherit the parent's (hidden) console, and any
 *   console-app **grandchildren** it spawns (e.g. the emulator's netsim/qemu
 *   helpers) inherit that hidden console too, instead of each popping their own.
 * - Teardown does not rely on `detached`: `killProcessTree` uses
 *   `taskkill /F /T /PID`, and `child.unref()` alone lets the parent event loop
 *   exit without waiting on the child.
 */

/**
 * The subset of spawn options that control console-window visibility.
 */
export interface SpawnVisibilityFlags {
  /**
   * Whether to run the child in its own process group / detached from the
   * parent console (`DETACHED_PROCESS` on Windows).
   */
  readonly detached: boolean;

  /** Whether to hide the child's console window (`windowsHide`). */
  readonly windowsHide: boolean;
}

/**
 * Resolves the visibility spawn flags for the auto-started Appium server.
 *
 * When hidden, the server must NOT be detached (otherwise a console window
 * appears despite `windowsHide`). When the user opts to see the console, it is
 * detached so it gets its own dedicated window.
 *
 * @param isConsoleHidden - Whether the Appium console should be hidden.
 * @returns The `detached` / `windowsHide` flags to pass to `spawn`.
 */
export function resolveAppiumSpawnFlags(isConsoleHidden: boolean): SpawnVisibilityFlags {
  return {
    detached: !isConsoleHidden,
    windowsHide: isConsoleHidden
  };
}

/**
 * Resolves the visibility spawn flags for the auto-started Android emulator.
 *
 * The emulator is never detached: detaching only causes its console-app
 * grandchildren (netsim/qemu) to allocate their own visible consoles. Its
 * on-screen device window is a GUI window controlled by the `-no-window`
 * argument (see `emulator-args.ts`), independent of these console flags.
 *
 * @param isWindowHidden - Whether the emulator (and its console) should be hidden.
 * @returns The `detached` / `windowsHide` flags to pass to `spawn`.
 */
export function resolveEmulatorSpawnFlags(isWindowHidden: boolean): SpawnVisibilityFlags {
  return {
    detached: false,
    windowsHide: isWindowHidden
  };
}
