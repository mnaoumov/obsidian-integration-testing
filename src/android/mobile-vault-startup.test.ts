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
      querySelector: vi.fn().mockReturnValue(screen)
    })
  );
  vi.stubGlobal('localStorage', strictProxy<Storage>({ getItem: () => JSON.stringify([VAULT_PATH]) }));
  vi.stubGlobal('app', undefined);
  return clicks;
}

describe('probeMobileVaultStartup', () => {
  it('waits through a reload with no picker yet', () => {
    vi.stubGlobal('app', undefined);
    vi.stubGlobal('document', strictProxy<Document>({ querySelector: () => null }));
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true })).toMatchObject({ hasApp: false, pickerAction: 'waiting', vaultPath: null });
  });

  it('waits if the picker container has no screen yet', () => {
    vi.stubGlobal('app', undefined);
    vi.stubGlobal('document', strictProxy<Document>({ querySelector: () => null }));
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true }).pickerAction).toBe('waiting');
  });

  it('waits for a requested app whose workspace is still loading', () => {
    vi.stubGlobal('app', { vault: { adapter: { basePath: VAULT_PATH } } });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true })).toMatchObject({ hasApp: true, hasWorkspace: false, isLayoutReady: false });
  });

  it('does not accept an app before its adapter is constructed', () => {
    vi.stubGlobal('app', { vault: {} });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true }).hasApp).toBe(false);
  });

  it('does not select a vault absent from the registry', () => {
    const clicks = mockPicker({});
    vi.stubGlobal('localStorage', strictProxy<Storage>({ getItem: () => null }));
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true }).pickerAction).toBe('waiting');
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('waits if the requested details have no opening action yet', () => {
    const clicks = mockPicker({ detailsPath: VAULT_PATH, names: ['Rename vault'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true }).pickerAction).toBe('waiting');
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('selects the requested registered vault without requiring an app', () => {
    const clicks = mockPicker({ names: ['old-vault', 'requested'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true }).pickerAction).toBe('selected-vault');
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });

  it('opens only details naming the full requested path', () => {
    const clicks = mockPicker({ detailsPath: VAULT_PATH, names: ['Open vault', 'Delete vault'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true }).pickerAction).toBe('opened-vault');
    expect(clicks[0]).toHaveBeenCalledOnce();
    expect(clicks[1]).not.toHaveBeenCalled();
  });

  it('does not open another vault with the same basename', () => {
    const clicks = mockPicker({ detailsPath: '/other/requested', names: ['Open vault'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true }).pickerAction).toBe('waiting');
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('refuses ambiguous picker names', () => {
    const clicks = mockPicker({ names: ['requested', 'requested'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true }).pickerAction).toBe('waiting');
    expect(clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
  });

  it('does not click again while the opening action is pending', () => {
    const clicks = mockPicker({ detailsPath: VAULT_PATH, names: ['Open vault'] });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: false }).hasApp).toBe(false);
    expect(clicks[0]).not.toHaveBeenCalled();
  });

  it('rejects a ready app for a previous vault', () => {
    vi.stubGlobal('app', { vault: { adapter: { basePath: '/sdcard/Documents/old' } }, workspace: { layoutReady: true } });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true })).toMatchObject({ hasApp: false, vaultPath: '/sdcard/Documents/old' });
  });

  it('accepts normal startup only for the requested live vault', () => {
    vi.stubGlobal('app', { vault: { adapter: { basePath: VAULT_PATH } }, workspace: { layoutReady: true } });
    expect(probeMobileVaultStartup({ deviceVaultPath: VAULT_PATH, shouldRecoverPicker: true })).toMatchObject({ hasApp: true, hasWorkspace: true, isLayoutReady: true, vaultPath: VAULT_PATH });
  });
});
