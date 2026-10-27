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
  readonly pickerAction: 'opened-vault' | 'selected-vault' | 'waiting';
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
 * has no `app`, so recovery must use the picker DOM. A basename selects details;
 * only the full path in those details authorizes clicking Open vault. Startup is
 * accepted only when the live adapter belongs to the requested vault.
 *
 * @param params - The requested vault and whether opening may be initiated.
 * @returns Startup progress and identity evidence from this WebView.
 */
export function probeMobileVaultStartup(params: ProbeMobileVaultStartupParams): MobileVaultStartupProbeResult {
  const { deviceVaultPath, shouldRecoverPicker } = params;
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

  // During a slide transition both screens exist; the incoming one is last.
  const screen = document.querySelector('.mobile-vault-chooser > :last-child');
  if (!screen) {
    return result;
  }
  const actions = [...screen.querySelectorAll<HTMLElement>('.mobile-vault-chooser-action')];
  const detailsPath = screen.querySelector('.u-pop')?.textContent;
  if (detailsPath === deviceVaultPath) {
    const open = actions.find((action) => action.querySelector('.mobile-vault-chooser-action-name')?.textContent === 'Open vault');
    if (open) {
      open.click();
      return { ...result, pickerAction: 'opened-vault' };
    }
  } else if (screen.classList.contains('mod-main')) {
    const registered = JSON.parse(localStorage.getItem('mobile-external-vaults') ?? '[]') as string[];
    const name = deviceVaultPath.slice(deviceVaultPath.lastIndexOf('/') + 1);
    const matches = actions.filter((action) => action.querySelector('.mobile-vault-chooser-action-name')?.textContent === name);
    if (registered.includes(deviceVaultPath) && matches.length === 1) {
      matches[0]?.click();
      return { ...result, pickerAction: 'selected-vault' };
    }
  }
  return result;
}
