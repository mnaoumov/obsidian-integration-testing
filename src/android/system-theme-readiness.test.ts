import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildSystemThemeNotSettledWarning,
  parseSystemThemeOverlays,
  resolveSystemThemeVerdict
} from './system-theme-readiness.ts';

// The shape of `cmd overlay list android` on obsidian_test (API 37), captured on 2026-11-12, shortened.
function buildOverlayList(themeState: ' ' | 'x'): string {
  return [
    'android',
    '[x] android.auto_generated_characteristics_rro',
    '[ ] com.android.internal.display.cutout.emulation.corner',
    '[x] com.android.internal.systemui.navbar.gestural',
    `[${themeState}] com.android.systemui:neutral`,
    `[${themeState}] com.android.systemui:accent`,
    `[${themeState}] com.android.systemui:dynamic`,
    ''
  ].join('\r\n');
}

describe('parseSystemThemeOverlays', () => {
  it('should read only the SystemUI theme overlays and their state', () => {
    expect(parseSystemThemeOverlays(buildOverlayList('x'))).toEqual([
      { isEnabled: true, name: 'com.android.systemui:neutral' },
      { isEnabled: true, name: 'com.android.systemui:accent' },
      { isEnabled: true, name: 'com.android.systemui:dynamic' }
    ]);
  });
});

describe('resolveSystemThemeVerdict', () => {
  it('should be settled when every theme overlay is enabled', () => {
    expect(resolveSystemThemeVerdict(buildOverlayList('x'))).toEqual({ kind: 'settled', overlayCount: 3 });
  });

  it('should be pending, naming the disabled overlays, while SystemUI has them off', () => {
    expect(resolveSystemThemeVerdict(buildOverlayList(' '))).toEqual({
      disabledOverlayNames: ['com.android.systemui:neutral', 'com.android.systemui:accent', 'com.android.systemui:dynamic'],
      kind: 'pending'
    });
  });

  it('should be pending when only some theme overlays are enabled', () => {
    const output = '[x] com.android.systemui:neutral\n[ ] com.android.systemui:accent\n';

    expect(resolveSystemThemeVerdict(output)).toEqual({ disabledOverlayNames: ['com.android.systemui:accent'], kind: 'pending' });
  });

  it('should find nothing to wait for on an overlay list without SystemUI theme overlays', () => {
    expect(resolveSystemThemeVerdict('android\n[x] android.auto_generated_characteristics_rro\n')).toEqual({ kind: 'no-theme-overlays' });
  });

  it('should call output that is not an overlay list unreadable', () => {
    expect(resolveSystemThemeVerdict('cmd: Can\'t find service: overlay\n')).toEqual({ kind: 'unreadable', output: 'cmd: Can\'t find service: overlay' });
    expect(resolveSystemThemeVerdict('')).toEqual({ kind: 'unreadable', output: '' });
  });
});

describe('buildSystemThemeNotSettledWarning', () => {
  it('should name the disabled overlays and the consequence', () => {
    const warning = buildSystemThemeNotSettledWarning({
      deviceId: 'emulator-5554',
      lastVerdict: { disabledOverlayNames: ['com.android.systemui:accent'], kind: 'pending' },
      timeoutInMilliseconds: 240_000
    });

    expect(warning).toContain('device emulator-5554 were not applied within 240000ms (still disabled: com.android.systemui:accent)');
    expect(warning).toContain('EvalResultLostError');
  });

  it('should say when no probe answered, and quote an unreadable answer', () => {
    expect(buildSystemThemeNotSettledWarning({ deviceId: 'd', lastVerdict: null, timeoutInMilliseconds: 1 })).toContain('(no overlay probe answered)');
    expect(buildSystemThemeNotSettledWarning({ deviceId: 'd', lastVerdict: { kind: 'unreadable', output: 'boom' }, timeoutInMilliseconds: 1 }))
      .toContain('(the last probe answered "boom")');
    expect(buildSystemThemeNotSettledWarning({ deviceId: 'd', lastVerdict: { kind: 'settled', overlayCount: 3 }, timeoutInMilliseconds: 1 }))
      .toContain('(last verdict settled)');
  });
});
