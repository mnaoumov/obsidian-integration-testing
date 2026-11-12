/**
 * @file
 * Self-contained WebView snapshot of what Obsidian Mobile shows when it never opened the requested vault.
 */

/**
What the WebView showed when the app-start phase ran out without an app.
 */
export interface MobileVaultPickerSnapshot {
  /**
  The labels of the vault rows, actions and buttons on the picker's last (incoming) screen.
   */
  readonly actionNames: readonly string[];
  /**
  The `class` attribute of `document.body`.
   */
  readonly bodyClass: string;
  /**
  The start of the page's visible text, whitespace collapsed.
   */
  readonly bodyText: string;
  /**
  The path the picker's details screen names, when one is showing.
   */
  readonly detailsPath: null | string;
  /**
  The titles of any open modals.
   */
  readonly modalTitles: readonly string[];
  /**
  Which picker layout the page shows: `.mobile-vault-chooser` (Obsidian Mobile up to 1.14), `.mobile-onboarding` (1.15), or neither.
   */
  readonly pickerLayout: 'chooser' | 'onboarding' | null;
  /**
  The vault paths in `mobile-external-vaults`, or the raw value when it is not a JSON array.
   */
  readonly registeredVaults: readonly string[] | string;
  /**
  The `class` attribute of each picker screen, oldest first.
   */
  readonly screenClasses: readonly string[];
  /**
  The value of `mobile-selected-vault`.
   */
  readonly selectedVault: null | string;
}

/**
 * Formats a snapshot for one line of a timeout message.
 *
 * @param snapshot - The snapshot, or `null` when it could not be taken.
 * @returns The line.
 */
export function formatMobileVaultPickerSnapshot(snapshot: MobileVaultPickerSnapshot | null): string {
  if (!snapshot) {
    return 'Page snapshot: unavailable.';
  }
  const registered = typeof snapshot.registeredVaults === 'string'
    ? snapshot.registeredVaults
    : JSON.stringify(snapshot.registeredVaults);
  return 'Page snapshot: '
    + `picker ${snapshot.pickerLayout ?? 'absent'}; `
    + `screens ${JSON.stringify(snapshot.screenClasses)}; `
    + `actions ${JSON.stringify(snapshot.actionNames)}; `
    + `details path ${snapshot.detailsPath ?? '(none)'}; `
    + `modals ${JSON.stringify(snapshot.modalTitles)}; `
    + `registered ${registered}; `
    + `selected ${snapshot.selectedVault ?? '(unset)'}; `
    + `body class "${snapshot.bodyClass}"; `
    + `text "${snapshot.bodyText}".`;
}

/**
 * Reads what the vault picker (or whatever stands in its place) shows, for a startup timeout message.
 *
 * Serialized into the WebView: keep it self-contained, and never let it throw.
 *
 * @returns The snapshot.
 */
export function snapshotMobileVaultPicker(): MobileVaultPickerSnapshot {
  // Declared inside: the function is serialized into the WebView, where a module constant does not exist.
  const BODY_TEXT_LENGTH = 300;
  const chooser = document.querySelector('.mobile-vault-chooser');
  const onboardingScreens = [...document.querySelectorAll('.mobile-onboarding-screen')];
  const screens = chooser ? [...chooser.children] : onboardingScreens;
  const screen = screens.at(-1);
  const rawRegistered = localStorage.getItem('mobile-external-vaults');
  let registeredVaults: readonly string[] | string = rawRegistered ?? '(unset)';
  try {
    const parsed: unknown = JSON.parse(rawRegistered ?? 'null');
    if (Array.isArray(parsed)) {
      registeredVaults = parsed.map(String);
    }
  } catch {
    // Keep the raw value.
  }
  return {
    actionNames: screen
      ? [...screen.querySelectorAll(':scope .mobile-vault-chooser-action, :scope .mobile-onboarding-vault-list .list-item, :scope button')].map((control) => (control.querySelector('.mobile-vault-chooser-action-name, .list-item-part.mod-extended') ?? control).textContent.trim())
      : [],
    bodyClass: document.body.getAttribute('class') ?? '',
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- Only the visible text says which screen is showing; the picker keeps hidden screens in the DOM.
    bodyText: document.body.innerText.replaceAll(/\s+/g, ' ').trim().slice(0, BODY_TEXT_LENGTH),
    detailsPath: screen?.querySelector('.u-pop')?.textContent ?? null,
    modalTitles: [...document.querySelectorAll('.modal-title')].map((element) => element.textContent),
    pickerLayout: chooser ? 'chooser' : (onboardingScreens.length > 0 ? 'onboarding' : null),
    registeredVaults,
    screenClasses: screens.map((element) => element.getAttribute('class') ?? ''),
    selectedVault: localStorage.getItem('mobile-selected-vault')
  };
}
