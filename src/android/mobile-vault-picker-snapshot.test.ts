import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  formatMobileVaultPickerSnapshot,
  snapshotMobileVaultPicker
} from './mobile-vault-picker-snapshot.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FakeElementParams {
  readonly className?: null | string;
  readonly descendants?: Record<string, FakeElement[]>;
  readonly text?: string;
}

interface StubPageParams {
  readonly bodyClass?: null | string;
  readonly chooser?: FakeElement | null;
  readonly modals?: FakeElement[];
  readonly onboardingScreens?: FakeElement[];
  readonly registered?: null | string;
  readonly selected?: null | string;
}

class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly textContent: string;

  public constructor(private readonly params: FakeElementParams = {}) {
    this.textContent = params.text ?? '';
  }

  public getAttribute(): null | string {
    return this.params.className ?? null;
  }

  public querySelector(selector: string): FakeElement | null {
    return this.params.descendants?.[selector]?.[0] ?? null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    return this.params.descendants?.[selector] ?? [];
  }
}

const CONTROLS_SELECTOR = ':scope .mobile-vault-chooser-action, :scope .mobile-onboarding-vault-list .list-item, :scope button';
const LABEL_SELECTOR = '.mobile-vault-chooser-action-name, .list-item-part.mod-extended';

function stubPage(params: StubPageParams): void {
  const body = Object.assign(new FakeElement({ className: params.bodyClass ?? null }), { innerText: '  Create  a\n new vault  ' });
  vi.stubGlobal('document', {
    body,
    querySelector: (selector: string) => selector === '.mobile-vault-chooser' ? params.chooser ?? null : null,
    querySelectorAll: (selector: string) => selector === '.modal-title' ? params.modals ?? [] : (selector === '.mobile-onboarding-screen' ? params.onboardingScreens ?? [] : [])
  });
  const storage: Record<string, null | string | undefined> = {
    'mobile-external-vaults': params.registered,
    'mobile-selected-vault': params.selected
  };
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage[key] ?? null });
}

describe('snapshotMobileVaultPicker', () => {
  it('reads the picker screens, actions, details and registry', () => {
    const action = new FakeElement({ descendants: { [LABEL_SELECTOR]: [new FakeElement({ text: ' temp-vault-a ' })] } });
    const details = new FakeElement({ text: '/sdcard/Documents/temp-vault-a' });
    const screen = new FakeElement({ className: 'mod-main', descendants: { '.u-pop': [details], [CONTROLS_SELECTOR]: [action] } });
    const chooser = new FakeElement();
    chooser.children.push(new FakeElement(), screen);
    stubPage({
      bodyClass: 'is-mobile',
      chooser,
      modals: [new FakeElement({ text: 'Trust author' })],
      registered: '["/sdcard/Documents/temp-vault-a"]',
      selected: '/sdcard/Documents/temp-vault-a'
    });
    expect(snapshotMobileVaultPicker()).toEqual({
      actionNames: ['temp-vault-a'],
      bodyClass: 'is-mobile',
      bodyText: 'Create a new vault',
      detailsPath: '/sdcard/Documents/temp-vault-a',
      modalTitles: ['Trust author'],
      pickerLayout: 'chooser',
      registeredVaults: ['/sdcard/Documents/temp-vault-a'],
      screenClasses: ['', 'mod-main'],
      selectedVault: '/sdcard/Documents/temp-vault-a'
    });
  });

  it('reads the 1.15 onboarding layout: vault rows by name, buttons by text', () => {
    const row = new FakeElement({ descendants: { [LABEL_SELECTOR]: [new FakeElement({ text: 'bootstrap' })] }, text: 'bootstrap' });
    const button = new FakeElement({ text: 'Create new vault' });
    const screen = new FakeElement({ className: 'mobile-onboarding-screen', descendants: { [CONTROLS_SELECTOR]: [row, button] } });
    stubPage({ onboardingScreens: [screen], registered: '[]' });
    expect(snapshotMobileVaultPicker()).toMatchObject({
      actionNames: ['bootstrap', 'Create new vault'],
      pickerLayout: 'onboarding',
      screenClasses: ['mobile-onboarding-screen']
    });
  });

  it('reports a page with no picker and an unset registry', () => {
    stubPage({});
    expect(snapshotMobileVaultPicker()).toMatchObject({
      actionNames: [],
      bodyClass: '',
      detailsPath: null,
      pickerLayout: null,
      registeredVaults: '(unset)',
      screenClasses: [],
      selectedVault: null
    });
  });

  it('runs from its own source text, as it does in the WebView', () => {
    stubPage({ registered: '["/v"]' });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- Rebuilding the function from its text is the point: a reference to module scope fails here as it does in the WebView.
    const rebuilt = new Function(`return (${snapshotMobileVaultPicker.toString()})();`) as () => unknown;
    expect(rebuilt()).toMatchObject({ bodyText: 'Create a new vault', registeredVaults: ['/v'] });
  });

  it('keeps a registry that is not a JSON array as raw text', () => {
    stubPage({ registered: '{"a":1}' });
    expect(snapshotMobileVaultPicker().registeredVaults).toBe('{"a":1}');
    stubPage({ registered: 'not json' });
    expect(snapshotMobileVaultPicker().registeredVaults).toBe('not json');
  });
});

describe('formatMobileVaultPickerSnapshot', () => {
  it('says when no snapshot could be taken', () => {
    expect(formatMobileVaultPickerSnapshot(null)).toBe('Page snapshot: unavailable.');
  });

  it('formats every field', () => {
    expect(formatMobileVaultPickerSnapshot({
      actionNames: ['a'],
      bodyClass: 'is-mobile',
      bodyText: 'text',
      detailsPath: null,
      modalTitles: [],
      pickerLayout: 'chooser',
      registeredVaults: ['/v'],
      screenClasses: ['mod-main'],
      selectedVault: null
    })).toBe(
      'Page snapshot: picker chooser; screens ["mod-main"]; actions ["a"]; details path (none); modals []; registered ["/v"]; '
        + 'selected (unset); body class "is-mobile"; text "text".'
    );
    expect(formatMobileVaultPickerSnapshot({
      actionNames: [],
      bodyClass: '',
      bodyText: '',
      detailsPath: '/v',
      modalTitles: [],
      pickerLayout: null,
      registeredVaults: '(unset)',
      screenClasses: [],
      selectedVault: '/v'
    })).toContain('picker absent; screens []; actions []; details path /v; modals []; registered (unset); selected /v;');
  });
});
