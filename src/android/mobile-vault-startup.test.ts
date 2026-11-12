import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { strictProxy } from '../strict-proxy.ts';
import { probeMobileVaultStartup } from './mobile-vault-startup.ts';

const VAULT_PATH = '/sdcard/Documents/requested';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface MockOnboardingParams {
  readonly buttons?: string[];
  readonly detailsPath?: string;
  readonly rows?: string[];
}

interface MockPickerParams {
  readonly detailsPath?: string;
  readonly names?: string[];
}

function mockPicker(params: MockPickerParams): ReturnType<typeof vi.fn>[] {
  const options = params;
  const clicks: ReturnType<typeof vi.fn>[] = [];
  const actions = (options.names ?? ['requested']).map((name) => {
    const click = vi.fn();
    clicks.push(click);
    return strictProxy<HTMLElement>({
      click,
      querySelector: vi.fn().mockReturnValue({ textContent: name })
    });
  });
  const screen = strictProxy<HTMLElement>({
    classList: strictProxy<DOMTokenList>({ contains: (name) => name === 'mod-main' && !options.detailsPath }),
    querySelector: vi.fn().mockReturnValue(options.detailsPath ? { textContent: options.detailsPath } : null),
    querySelectorAll: vi.fn().mockReturnValue(actions)
  });
  vi.stubGlobal(
    'document',
    strictProxy<Document>({
      querySelector: vi.fn().mockReturnValue(screen),
      querySelectorAll: vi.fn().mockReturnValue([])
    })
  );
  vi.stubGlobal('localStorage', strictProxy<Storage>({ getItem: () => JSON.stringify([VAULT_PATH]) }));
  vi.stubGlobal('app', undefined);
  return clicks;
}

const CONTROLS_SELECTOR = ':scope .mobile-vault-chooser-action, :scope .mobile-onboarding-vault-list .list-item, :scope button';
const LABEL_SELECTOR = '.mobile-vault-chooser-action-name, .list-item-part.mod-extended';

// The 1.15 layout: `.mobile-onboarding-screen`, vault rows with a `.mod-extended` name part, and plain buttons.
function mockOnboarding(params: MockOnboardingParams): Map<string, ReturnType<typeof vi.fn>> {
  const clicks = new Map<string, ReturnType<typeof vi.fn>>();
  function control(label: string, hasNamePart: boolean): object {
    const click = vi.fn();
    clicks.set(label, click);
    return {
      click,
      querySelector: (selector: string): null | object => selector === LABEL_SELECTOR && hasNamePart ? { textContent: ` ${label} ` } : null,
      textContent: label
    };
  }
  const controls = [...(params.rows ?? []).map((row) => control(row, true)), ...(params.buttons ?? []).map((button) => control(button, false))];
  const screen = {
    classList: { contains: (name: string): boolean => name === 'mobile-onboarding-screen' },
    querySelector: (selector: string): null | object => selector === '.u-pop' && params.detailsPath ? { textContent: params.detailsPath } : null,
    querySelectorAll: (selector: string): object[] => selector === CONTROLS_SELECTOR ? controls : []
  };
  vi.stubGlobal('document', {
    querySelector: (): null => null,
    querySelectorAll: (selector: string): object[] => selector === '.mobile-onboarding-screen' ? [{}, screen] : []
  });
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([VAULT_PATH]) });
  vi.stubGlobal('app', undefined);
  return clicks;
}

describe('probeMobileVaultStartup on the 1.15 onboarding layout', () => {
  it('selects the requested vault row on the last screen', () => {
    const clicks = mockOnboarding({ buttons: ['Create new vault'], rows: ['bootstrap', 'requested'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('selected-vault');
    expect(clicks.get('requested')).toHaveBeenCalledOnce();
    expect(clicks.get('bootstrap')).not.toHaveBeenCalled();
  });

  it('opens the requested vault from its details buttons', () => {
    const clicks = mockOnboarding({ buttons: ['Open vault', 'Open vault in restricted mode', 'Delete vault'], detailsPath: VAULT_PATH });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('opened-vault');
    expect(clicks.get('Open vault')).toHaveBeenCalledOnce();
    expect(clicks.get('Open vault in restricted mode')).not.toHaveBeenCalled();
    expect(clicks.get('Delete vault')).not.toHaveBeenCalled();
  });

  it('opens nothing on another vault\'s details', () => {
    const clicks = mockOnboarding({ buttons: ['Open vault'], detailsPath: '/other/requested' });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('waiting');
    expect(clicks.get('Open vault')).not.toHaveBeenCalled();
  });
});

describe('probeMobileVaultStartup', () => {
  it('waits through a reload with no picker yet', () => {
    vi.stubGlobal('app', undefined);
    vi.stubGlobal('document', strictProxy<Document>({ querySelector: vi.fn().mockReturnValue(null), querySelectorAll: vi.fn().mockReturnValue([]) }));
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false })).toMatchObject({ hasApp: false, pickerAction: 'waiting', vaultPath: null });
  });

  it('waits if the picker container has no screen yet', () => {
    vi.stubGlobal('app', undefined);
    vi.stubGlobal('document', strictProxy<Document>({ querySelector: vi.fn().mockReturnValue(null), querySelectorAll: vi.fn().mockReturnValue([]) }));
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('waiting');
  });

  it('waits for a requested app whose workspace is still loading', () => {
    vi.stubGlobal('app', { vault: { adapter: { basePath: VAULT_PATH } } });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false })).toMatchObject({ hasApp: true, hasWorkspace: false, isLayoutReady: false });
  });

  it('does not accept an app before its adapter is constructed', () => {
    vi.stubGlobal('app', { vault: {} });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).hasApp).toBe(false);
  });

  it('does not select a vault absent from the registry', () => {
    const clicks = mockPicker({});
    vi.stubGlobal('localStorage', strictProxy<Storage>({ getItem: () => null }));
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('waiting');
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('registers a vault absent from the registry again, when allowed, and reloads', () => {
    const clicks = mockPicker({ names: ['old-vault'] });
    const storage = new Map<string, string>([['mobile-external-vaults', JSON.stringify(['/sdcard/Documents/old-vault'])]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    });
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: true }).pickerAction).toBe('restored-registration');
    expect(JSON.parse(storage.get('mobile-external-vaults') ?? '[]')).toEqual(['/sdcard/Documents/old-vault', VAULT_PATH]);
    expect(storage.get('mobile-selected-vault')).toBe(VAULT_PATH);
    expect(storage.get(`enable-plugin-${VAULT_PATH}`)).toBe('true');
    expect(reload).toHaveBeenCalledOnce();
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('waits if the requested details have no opening action yet', () => {
    const clicks = mockPicker({ detailsPath: VAULT_PATH, names: ['Rename vault'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('waiting');
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('selects the requested registered vault without requiring an app', () => {
    const clicks = mockPicker({ names: ['old-vault', 'requested'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('selected-vault');
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });

  it('opens only details naming the full requested path', () => {
    const clicks = mockPicker({ detailsPath: VAULT_PATH, names: ['Open vault', 'Delete vault'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('opened-vault');
    expect(clicks[0]).toHaveBeenCalledOnce();
    expect(clicks[1]).not.toHaveBeenCalled();
  });

  it('does not open another vault with the same basename', () => {
    const clicks = mockPicker({ detailsPath: '/other/requested', names: ['Open vault'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('waiting');
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('refuses ambiguous picker names', () => {
    const clicks = mockPicker({ names: ['requested', 'requested'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false }).pickerAction).toBe('waiting');
    expect(clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
  });

  it('does not click again while the opening action is pending', () => {
    const clicks = mockPicker({ detailsPath: VAULT_PATH, names: ['Open vault'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: false, shouldRestoreRegistration: false }).hasApp).toBe(false);
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('rejects a ready app for a previous vault', () => {
    vi.stubGlobal('app', { vault: { adapter: { basePath: '/sdcard/Documents/old' } }, workspace: { layoutReady: true } });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false })).toMatchObject({ hasApp: false, vaultPath: '/sdcard/Documents/old' });
  });

  it('accepts normal startup only for the requested live vault', () => {
    vi.stubGlobal('app', { vault: { adapter: { basePath: VAULT_PATH } }, workspace: { layoutReady: true } });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true, shouldRestoreRegistration: false })).toMatchObject({ hasApp: true, hasWorkspace: true, isLayoutReady: true, vaultPath: VAULT_PATH });
  });
});
