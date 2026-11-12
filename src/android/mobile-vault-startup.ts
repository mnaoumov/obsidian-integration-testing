/**
 * @file
 * Self-contained WebView probe for requested-vault startup and picker recovery.
 */

import type { StartupProbeResult } from './app-startup-progress.ts';

/**
Startup evidence, including the live vault identity and any picker action.
 */
export interface MobileVaultStartupProbeResult extends StartupProbeResult {
  /**
  The picker action performed by this probe.
   */
  readonly pickerAction: 'opened-vault' | 'restored-registration' | 'selected-vault' | 'waiting';
  /**
  The live adapter's path, rather than the selected localStorage entry.
   */
  readonly vaultPath: null | string;
}

/**
Parameters for {@link probeMobileVaultStartup}.
 */
export interface ProbeMobileVaultStartupParams {
  /**
  The full path registered on the device.
   */
  readonly deviceVaultPath: string;
  /**
  Whether the picker may still initiate opening this vault.
   */
  readonly shouldRecoverPicker: boolean;
  /**
  Whether a picker whose registry lacks the requested vault may register it again and reload.
   */
  readonly shouldRestoreRegistration: boolean;
}

interface LoadingAdapter {
  readonly basePath?: string;
}

interface LoadingApp {
  readonly vault?: LoadingVault;
  readonly workspace?: LoadingWorkspace;
}

interface LoadingVault {
  readonly adapter?: LoadingAdapter;
}

interface LoadingWorkspace {
  readonly layoutReady?: boolean;
}

/**
 * Probes startup and escapes the mobile vault picker through its own opening action.
 *
 * This function is serialized into the WebView: keep it self-contained. The picker
 * has no `app`, so recovery must use the picker DOM, in either of its layouts: the
 * `.mobile-vault-chooser` screens of Obsidian Mobile up to 1.14, or the
 * `.mobile-onboarding-screen` ones of 1.15 (vault rows in `.mobile-onboarding-vault-list`,
 * actions as buttons). A basename selects details;
 * only the full path in those details authorizes clicking Open vault. Startup is
 * accepted only when the live adapter belongs to the requested vault. A picker whose
 * registry lacks the requested vault never got the registration (or lost it), so,
 * when allowed, the probe writes it again in this page and reloads.
 *
 * @param params - The requested vault and whether opening may be initiated.
 * @returns Startup progress and identity evidence from this WebView.
 */
export function probeMobileVaultStartup(params: ProbeMobileVaultStartupParams): MobileVaultStartupProbeResult {
  const { deviceVaultPath, shouldRecoverPicker, shouldRestoreRegistration } = params;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Startup must inspect the global before the namespace exists.
  const app = globalThis.app as LoadingApp | undefined;
  const vaultPath = app?.vault?.adapter?.basePath ?? null;
  const hasRequestedApp = !!app && vaultPath === deviceVaultPath;
  const result: MobileVaultStartupProbeResult = {
    hasApp: hasRequestedApp,
    hasWorkspace: hasRequestedApp && !!app.workspace,
    isLayoutReady: hasRequestedApp && !!app.workspace?.layoutReady,
    pickerAction: 'waiting',
    vaultPath
  };
  if (app || !shouldRecoverPicker) {
    return result;
  }

  // Declared inside: this function is serialized into the WebView.
  function restoreRegistration(registered: string[]): MobileVaultStartupProbeResult {
    // The registration never reached this page's storage, or the page wrote over it: write it again here.
    localStorage.setItem('mobile-external-vaults', JSON.stringify([...registered, deviceVaultPath]));
    localStorage.setItem('mobile-selected-vault', deviceVaultPath);
    localStorage.setItem(`enable-plugin-${deviceVaultPath}`, 'true');
    location.reload();
    return { ...result, pickerAction: 'restored-registration' };
  }

  // A control's label: a legacy action's name element, an onboarding vault row's name part, or a button's own text.
  function labelOf(control: HTMLElement): string {
    return (control.querySelector('.mobile-vault-chooser-action-name, .list-item-part.mod-extended') ?? control).textContent.trim();
  }

  function selectOnMainScreen(controls: HTMLElement[]): MobileVaultStartupProbeResult {
    const registered = JSON.parse(localStorage.getItem('mobile-external-vaults') ?? '[]') as string[];
    if (!registered.includes(deviceVaultPath)) {
      return shouldRestoreRegistration ? restoreRegistration(registered) : result;
    }
    const name = deviceVaultPath.slice(deviceVaultPath.lastIndexOf('/') + 1);
    const matches = controls.filter((control) => labelOf(control) === name);
    if (matches.length !== 1) {
      return result;
    }
    matches[0]?.click();
    return { ...result, pickerAction: 'selected-vault' };
  }

  // Obsidian Mobile up to 1.14 draws `.mobile-vault-chooser` screens; 1.15 draws `.mobile-onboarding-screen`.
  // During a slide transition both screens exist; the incoming one is last.
  const onboardingScreens = [...document.querySelectorAll('.mobile-onboarding-screen')];
  const screen = document.querySelector('.mobile-vault-chooser > :last-child') ?? onboardingScreens.at(-1);
  if (!screen) {
    return result;
  }
  const controls = [...screen.querySelectorAll<HTMLElement>(':scope .mobile-vault-chooser-action, :scope .mobile-onboarding-vault-list .list-item, :scope button')];
  const detailsPath = screen.querySelector('.u-pop')?.textContent;
  if (detailsPath === deviceVaultPath) {
    const open = controls.find((control) => labelOf(control) === 'Open vault');
    if (open) {
      open.click();
      return { ...result, pickerAction: 'opened-vault' };
    }
  } else if (screen.classList.contains('mod-main') || screen.classList.contains('mobile-onboarding-screen')) {
    return selectOnMainScreen(controls);
  }
  return result;
}
