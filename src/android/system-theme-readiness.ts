/**
 * @file
 *
 * Pure helpers for the system-theme gate that runs before a vault is opened on Android (AGENTS.md L91).
 *
 * SystemUI's `ThemeOverlayController` applies the wallpaper-derived theme as three fabricated resource
 * overlays (`com.android.systemui:neutral`, `:accent`, `:dynamic`). Enabling or disabling them is a global
 * `CONFIG_ASSETS_PATHS` configuration change, which Android answers by RELAUNCHING every activity those overlays
 * affect, Obsidian's `MainActivity` included. The relaunch creates a new WebView, so the page a test was talking
 * to is gone: ChromeDriver answers `no such window: web view not found`, and an eval in flight comes back with no
 * result (`EvalResultLostError`).
 *
 * On a one-core guest that happens after the harness has handed the device over. Measured on 2026-11-12: SystemUI
 * hit an ANR about a minute after boot and was restarted; the new SystemUI DISABLED the overlays at once, spent
 * 61-108 s extracting the wallpaper's colors, and then ENABLED them again, relaunching Obsidian mid-suite. So the
 * gate waits until every SystemUI theme overlay the device lists is enabled, which is the state SystemUI leaves
 * once its theme is applied.
 */

/**
 * The `adb shell` script the gate runs: the overlays that target the `android` package.
 */
export const SYSTEM_THEME_PROBE_SCRIPT = 'cmd overlay list android';

/**
 * Default for the system-theme budget. The measured gap was 61-108 s on a one-core guest; this leaves room for a
 * slower host. The gate is best-effort: running out of it logs a warning and the run proceeds.
 */
export const DEFAULT_SYSTEM_THEME_READY_TIMEOUT_IN_MILLISECONDS = 240_000;

/**
 * How often the gate re-reads the overlay list.
 */
export const SYSTEM_THEME_POLL_INTERVAL_IN_MILLISECONDS = 3000;

const SYSTEM_UI_THEME_OVERLAY_PATTERN = /^\s*\[(?<state>[ x-])\]\s+(?<name>com\.android\.systemui:\S+)\s*$/u;

/**
 * Parameters of {@link buildSystemThemeNotSettledWarning}.
 */
export interface BuildSystemThemeNotSettledWarningParams {
  /**
   * The device UDID.
   */
  readonly deviceId: string;

  /**
   * The last verdict, or `null` when no probe answered.
   */
  readonly lastVerdict: null | SystemThemeVerdict;

  /**
   * The budget that ran out.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * The overlay list answered and named no SystemUI theme overlay, so there is nothing to wait for.
 */
export interface SystemThemeNoOverlaysVerdict {
  /**
   * The verdict kind.
   */
  readonly kind: 'no-theme-overlays';
}

/**
 * One SystemUI theme overlay as `cmd overlay list` reports it.
 */
export interface SystemThemeOverlay {
  /**
   * Whether the overlay is enabled (`[x]`).
   */
  readonly isEnabled: boolean;

  /**
   * The overlay's name, e.g. `com.android.systemui:accent`.
   */
  readonly name: string;
}

/**
 * SystemUI has some of its theme overlays off, so it is about to apply its theme.
 */
export interface SystemThemePendingVerdict {
  /**
   * The overlays still disabled.
   */
  readonly disabledOverlayNames: readonly string[];

  /**
   * The verdict kind.
   */
  readonly kind: 'pending';
}

/**
 * Every SystemUI theme overlay is enabled.
 */
export interface SystemThemeSettledVerdict {
  /**
   * The verdict kind.
   */
  readonly kind: 'settled';

  /**
   * How many theme overlays the list named.
   */
  readonly overlayCount: number;
}

/**
 * The probe's output is not an overlay list.
 */
export interface SystemThemeUnreadableVerdict {
  /**
   * The verdict kind.
   */
  readonly kind: 'unreadable';

  /**
   * What the probe answered instead, trimmed.
   */
  readonly output: string;
}

/**
 * What the gate concludes from one probe.
 */
export type SystemThemeVerdict = SystemThemeNoOverlaysVerdict | SystemThemePendingVerdict | SystemThemeSettledVerdict | SystemThemeUnreadableVerdict;

/**
 * Builds the warning logged when the budget runs out, naming what the run is now exposed to.
 *
 * @param params - The device, the budget and the last verdict.
 * @returns The warning.
 */
export function buildSystemThemeNotSettledWarning(params: BuildSystemThemeNotSettledWarningParams): string {
  const { deviceId, lastVerdict, timeoutInMilliseconds } = params;
  let state: string;
  if (lastVerdict === null) {
    state = 'no overlay probe answered';
  } else if (lastVerdict.kind === 'pending') {
    state = `still disabled: ${lastVerdict.disabledOverlayNames.join(', ')}`;
  } else if (lastVerdict.kind === 'unreadable') {
    state = `the last probe answered "${lastVerdict.output}"`;
  } else {
    state = `last verdict ${lastVerdict.kind}`;
  }

  return `Warning: SystemUI's theme overlays on device ${deviceId} were not applied within ${String(timeoutInMilliseconds)}ms (${state}); `
    + 'proceeding anyway. When SystemUI applies them, Android relaunches Obsidian\'s activity and replaces its WebView, so an eval '
    + 'in flight then fails with EvalResultLostError naming a REPLACED page.';
}

/**
 * Reads the SystemUI theme overlays out of `cmd overlay list android`.
 *
 * @param output - The command's output.
 * @returns The overlays named `com.android.systemui:<name>`, in listed order.
 */
export function parseSystemThemeOverlays(output: string): SystemThemeOverlay[] {
  const overlays: SystemThemeOverlay[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = SYSTEM_UI_THEME_OVERLAY_PATTERN.exec(line);
    if (match?.groups === undefined) {
      continue;
    }
    overlays.push({ isEnabled: match.groups['state'] === 'x', name: String(match.groups['name']) });
  }
  return overlays;
}

/**
 * Decides whether SystemUI's theme is applied.
 *
 * `settled` when every SystemUI theme overlay is enabled. `no-theme-overlays` when the list answered and named
 * none, which an image without dynamic color does, so there is nothing to wait for. `unreadable` when the output
 * is not an overlay list at all (the overlay service not up yet, `Can't find service: overlay`).
 *
 * @param output - The output of {@link SYSTEM_THEME_PROBE_SCRIPT}.
 * @returns The verdict.
 */
export function resolveSystemThemeVerdict(output: string): SystemThemeVerdict {
  const overlays = parseSystemThemeOverlays(output);
  if (overlays.length === 0) {
    return /^\s*\[[ x-]\]\s+\S/mu.test(output) ? { kind: 'no-theme-overlays' } : { kind: 'unreadable', output: output.trim() };
  }

  const disabledOverlayNames = overlays.filter((overlay) => !overlay.isEnabled).map((overlay) => overlay.name);
  return disabledOverlayNames.length === 0 ? { kind: 'settled', overlayCount: overlays.length } : { disabledOverlayNames, kind: 'pending' };
}
