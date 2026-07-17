/**
 * @file
 *
 * Pure resolution of the two owned-instance compatibility knobs — whether the
 * installer↔app / runtime-Electron nag warnings are emitted, and whether an
 * `'unrunnable'` installer↔app pair fails fast with
 * {@link IncompatibleInstallerVersionError} before launch.
 *
 * Both default to today's behavior (`true`): warnings on, and an unrunnable pin
 * throws proactively. Setting `shouldWarnOnCompatibilityIssues` to `false`
 * silences both nags (the verdicts are still computed and surfaced as data);
 * setting `shouldThrowOnIncompatibleInstaller` to `false` lets an unrunnable pin
 * proceed to launch, where the reactive dead-boot fast-fail
 * (`RendererFailedToInitializeError`) still catches it.
 *
 * Kept separate from the integration-only launch code (`transport-factory`,
 * `transport-desktop-cdp`, both excluded from unit tests) so the default
 * resolution stays unit-testable — mirroring the `visibility.ts` /
 * `appium-session-config.ts` pure-resolver split.
 */

import type { InstallerCompatibilityTier } from './installer-compatibility.ts';

/**
 * The action to take for a resolved installer↔app compatibility verdict, given
 * the throw/warn knobs.
 *
 * - `'throw'` — the verdict is `'unrunnable'` and the proactive throw is enabled;
 *   the caller throws `IncompatibleInstallerVersionError` before launch.
 * - `'warn-unrunnable'` — the verdict is `'unrunnable'` but the throw is disabled
 *   and warnings are on; the caller logs a "proceeding to launch" warning and
 *   lets the boot proceed (where the reactive dead-boot fast-fail catches it).
 * - `'warn-nagged'` — the verdict is `'nagged'` and warnings are on; the caller
 *   logs the recommended-installer warning.
 * - `'silent'` — nothing to do (`'ok'` / `'unknown'`, or warnings disabled).
 */
export type InstallerCompatibilityAction = 'silent' | 'throw' | 'warn-nagged' | 'warn-unrunnable';

/**
 * Parameters for {@link resolveInstallerCompatibilityAction}.
 */
export interface ResolveInstallerCompatibilityActionParams {
  /** Whether an `'unrunnable'` verdict throws (vs. proceeds to launch). */
  readonly shouldThrowOnIncompatibleInstaller: boolean;

  /** Whether a nag / proceeding-unrunnable verdict is logged. */
  readonly shouldWarnOnCompatibilityIssues: boolean;

  /** The resolved installer↔app compatibility tier. */
  readonly tier: InstallerCompatibilityTier;
}

/**
 * Resolves what to do for an installer↔app compatibility verdict, given the
 * throw/warn knobs. Pure — the caller performs the throw/log side effects.
 *
 * @param params - The verdict tier and the resolved throw/warn knobs.
 * @returns The action the caller should take.
 */
export function resolveInstallerCompatibilityAction(params: ResolveInstallerCompatibilityActionParams): InstallerCompatibilityAction {
  const { shouldThrowOnIncompatibleInstaller, shouldWarnOnCompatibilityIssues, tier } = params;

  if (tier === 'unrunnable') {
    if (shouldThrowOnIncompatibleInstaller) {
      return 'throw';
    }

    return shouldWarnOnCompatibilityIssues ? 'warn-unrunnable' : 'silent';
  }

  if (tier === 'nagged') {
    return shouldWarnOnCompatibilityIssues ? 'warn-nagged' : 'silent';
  }

  return 'silent';
}

/**
 * Whether an `'unrunnable'` installer↔app pair should fail fast with
 * {@link IncompatibleInstallerVersionError} before launch.
 *
 * @param shouldThrowOnIncompatibleInstaller - The resolved option value (omitted → throw).
 * @returns `true` when an unrunnable pin should throw (the default).
 */
export function resolveShouldThrowOnIncompatibleInstaller(shouldThrowOnIncompatibleInstaller?: boolean): boolean {
  return shouldThrowOnIncompatibleInstaller ?? true;
}

/**
 * Whether the owned-instance compatibility nag warnings should be emitted (both
 * the installer↔app `'nagged'` warning and the runtime-Electron `'nagged'`
 * warning).
 *
 * @param shouldWarnOnCompatibilityIssues - The resolved option value (omitted → warn).
 * @returns `true` when the warnings should be emitted (the default).
 */
export function resolveShouldWarnOnCompatibilityIssues(shouldWarnOnCompatibilityIssues?: boolean): boolean {
  return shouldWarnOnCompatibilityIssues ?? true;
}
