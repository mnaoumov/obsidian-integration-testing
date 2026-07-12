/**
 * @file
 *
 * Pure detection of a terminal "dead boot" of the owned Obsidian renderer, plus
 * resolving the fast-fail grace window from the transport options. Kept separate
 * from the integration-only `transport-desktop-cdp` (which drives real CDP and is
 * excluded from unit tests) so the verdict logic and default resolution stay
 * unit-testable.
 *
 * When an Obsidian asar cannot run on the launched Electron shell (the installer
 * version is too old for that app version), the renderer loads `index.html`
 * (`document.readyState` reaches `'complete'`) but the app never bootstraps:
 * `document.body` stays empty and `window.app` remains `undefined` — visually a
 * black screen. The owned-vault readiness poll cannot tell this terminal state
 * apart from "still loading", so without a detector it waits out the whole
 * readiness timeout before failing. This module encodes the signal that
 * distinguishes the two: once the renderer has been `complete` for a short grace
 * window with no `window.app` and an empty `<body>`, it is dead, not slow.
 */

import type { ObsidianCdpTransportOptions } from './transport-options.ts';

/**
 * Default for {@link ObsidianCdpTransportOptions.deadBootGraceInMilliseconds}.
 */
export const DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS = 10000;

/**
 * Parameters for {@link checkRendererBootState}.
 */
export interface CheckRendererBootStateParams extends RendererBootObservation {
  /**
   * Whether the bootstrap grace window has elapsed since the renderer first
   * reached `document.readyState` `'complete'`. The `'dead'` verdict is withheld
   * until this is `true` so a genuinely slow boot is never misjudged.
   */
  readonly hasGraceElapsed: boolean;
}

/**
 * A sample of the owned renderer's bootstrap state, taken from the vault page
 * target via a single CDP evaluation.
 */
export interface RendererBootObservation {
  /**
   * `document.body.childElementCount` in the vault renderer (`0` when `body` is
   * absent). A dead boot leaves the body empty; a slow-but-valid boot renders at
   * least a loading shell.
   */
  readonly bodyChildElementCount: number;

  /** Whether `window.app` is defined in the vault renderer. */
  readonly hasWindowApp: boolean;

  /** Whether the vault renderer's `document.readyState` is `'complete'`. */
  readonly isDocumentComplete: boolean;
}

/**
 * Verdict from {@link checkRendererBootState}: `'dead'` when the renderer has
 * terminally failed to initialize, `'pending'` when it may still be booting.
 */
export type RendererBootVerdict = 'dead' | 'pending';

/**
 * Decides whether the owned renderer has terminally failed to initialize.
 *
 * The verdict is `'dead'` only when all of the following hold: the grace window
 * has elapsed, `window.app` is still undefined, the document is `'complete'`,
 * and `<body>` is empty. This is exactly the observed incompatible-shell state
 * (an asar that cannot run on the launched Electron), and it cannot be reached
 * by a healthy boot — `window.app` is defined early, and a slow boot renders a
 * non-empty loading shell — so there is no false-positive path on a valid boot.
 *
 * @param params - The sampled observation plus whether the grace has elapsed.
 * @returns `'dead'` when the renderer is terminally dead, otherwise `'pending'`.
 */
export function checkRendererBootState(params: CheckRendererBootStateParams): RendererBootVerdict {
  const { bodyChildElementCount, hasGraceElapsed, hasWindowApp, isDocumentComplete } = params;

  if (hasWindowApp) {
    return 'pending';
  }

  if (!hasGraceElapsed) {
    return 'pending';
  }

  if (isDocumentComplete && bodyChildElementCount === 0) {
    return 'dead';
  }

  return 'pending';
}

/**
 * Resolves the dead-boot fast-fail grace window, applying the default when the
 * option is omitted.
 *
 * This bounds how long the owned-vault readiness poll waits — after the renderer
 * first reaches `document.readyState` `'complete'` — before concluding the boot
 * is dead (see {@link checkRendererBootState}). A value of `0` disables fast-fail
 * entirely, restoring the plain wait-out-the-readiness-timeout behavior.
 *
 * @param options - The desktop CDP transport options (or the relevant slice).
 * @returns The grace window in milliseconds.
 */
export function resolveDeadBootGraceInMilliseconds(
  options?: Pick<ObsidianCdpTransportOptions, 'deadBootGraceInMilliseconds'>
): number {
  return options?.deadBootGraceInMilliseconds ?? DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS;
}
