/**
 * @file
 *
 * Pure resolution of the process-visibility options — whether the launched
 * desktop Obsidian window, Android emulator window, and Appium server console
 * are shown on screen. The desktop application is visible by default; integration
 * setup explicitly requests an off-screen instance so test runs do not steal
 * focus. Android surfaces are hidden by default.
 *
 * Kept separate from the integration-only launch/spawn code (`transport-factory`,
 * `transport-desktop-cdp`, `obsidian-instance`, all excluded from unit tests) so
 * the hidden-by-default resolution stays unit-testable — those launchers need a
 * real Obsidian / emulator / Appium server.
 */

/**
 * Chromium switches passed to a **hidden** owned desktop instance.
 *
 * The harness hides the window by moving it **off-screen** (not minimizing it).
 * An off-screen window still reports `visibilityState: 'visible'` to Chromium, so
 * `setTimeout`, `requestAnimationFrame`, `:hover`, and trusted input all keep
 * working exactly as when visible — but only if Chromium never decides to
 * background it. These flags guarantee that: native occlusion tracking is
 * disabled and the timer/renderer backgrounding heuristics are switched off, so
 * an off-screen (or covered) renderer is never throttled or frozen.
 *
 * A *minimized* window, by contrast, freezes `requestAnimationFrame` regardless
 * of any flag (there is no surface to composite), which is why the harness moves
 * the window off-screen rather than minimizing it.
 */
export const OWNED_HIDDEN_LAUNCH_FLAGS = [
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding'
];

/**
 * Chromium switch that disables the setuid sandbox for an owned instance.
 *
 * Electron's Linux sandbox needs a correctly-configured (root-owned, setuid)
 * `chrome-sandbox` helper. A portable shell extracted from an installer — and a
 * CI runner launching it as a non-root user — has no such helper, so the
 * renderer refuses to start ("The SUID sandbox helper binary was found, but is
 * not configured correctly"). Passing `--no-sandbox` disables it. It is harmless
 * on Windows/macOS (their sandbox is unaffected by extraction), so an owned test
 * instance can pass it uniformly across platforms.
 */
export const NO_SANDBOX_LAUNCH_FLAG = '--no-sandbox';

/**
 * Resolves the extra Chromium launch args for an owned desktop instance: the
 * {@link OWNED_HIDDEN_LAUNCH_FLAGS} when the window is hidden, or an empty list
 * when it is visible (the default).
 *
 * @param isObsidianAppVisible - The resolved option value (omitted → visible).
 * @returns The extra launch args (possibly empty).
 */
export function resolveOwnedHiddenLaunchArgs(isObsidianAppVisible?: boolean): string[] {
  return shouldHideObsidianApp(isObsidianAppVisible) ? [...OWNED_HIDDEN_LAUNCH_FLAGS] : [];
}

/**
 * Resolves the extra Chromium launch args for disabling the sandbox.
 *
 * @param shouldDisableSandbox - The resolved option value (omitted → sandbox kept).
 * @returns `[{@link NO_SANDBOX_LAUNCH_FLAG}]` when the sandbox should be disabled, else `[]`.
 */
export function resolveSandboxLaunchArgs(shouldDisableSandbox?: boolean): string[] {
  return (shouldDisableSandbox ?? false) ? [NO_SANDBOX_LAUNCH_FLAG] : [];
}

/**
 * Whether the auto-started Appium server console window should be hidden.
 *
 * @param isAppiumConsoleVisible - The resolved option value (omitted → hidden).
 * @returns `true` when the console window should be hidden (the default).
 */
export function shouldHideAppiumConsole(isAppiumConsoleVisible?: boolean): boolean {
  return !(isAppiumConsoleVisible ?? false);
}

/**
 * Whether the auto-started Android emulator window should be hidden
 * (via the emulator's `-no-window` flag).
 *
 * @param isEmulatorVisible - The resolved option value (omitted → hidden).
 * @returns `true` when the emulator window should be hidden (the default).
 */
export function shouldHideEmulatorWindow(isEmulatorVisible?: boolean): boolean {
  return !(isEmulatorVisible ?? false);
}

/**
 * Whether the owned desktop Obsidian window should be hidden (moved off-screen).
 *
 * @param isObsidianAppVisible - The resolved option value (omitted → visible).
 * @returns `true` when the window should be hidden.
 */
export function shouldHideObsidianApp(isObsidianAppVisible?: boolean): boolean {
  return !(isObsidianAppVisible ?? true);
}
