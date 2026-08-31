import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildResolveInputExpression,
  codePointOf,
  toCdpInputCommands,
  toCdpModifiers
} from './mobile-input.ts';

describe('buildResolveInputExpression', () => {
  it('should resolve with a null error on success', () => {
    expect(buildResolveInputExpression('7'))
      .toBe('window.__obsidianIntegrationTesting?.resolveInput?.("7", null)');
  });

  it('should carry the failure message through to the renderer', () => {
    expect(buildResolveInputExpression('7', 'boom'))
      .toBe('window.__obsidianIntegrationTesting?.resolveInput?.("7", "boom")');
  });

  it('should escape a message that would otherwise break out of the expression', () => {
    const expression = buildResolveInputExpression('7', 'he said "stop"\n); alert(1); //');

    expect(expression).toContain(String.raw`\"stop\"`);
    expect(expression).toContain(String.raw`\n`);
    expect(expression.endsWith('//")')).toBe(true);
  });

  it('should optional-chain the whole call, so answering a page that has navigated is a no-op', () => {
    expect(buildResolveInputExpression('7')).toContain('?.resolveInput?.(');
  });
});

describe('codePointOf', () => {
  it('should return the code point of a single character', () => {
    expect(codePointOf('0')).toBe(48);
    expect(codePointOf('9')).toBe(57);
    expect(codePointOf('A')).toBe(65);
    expect(codePointOf('Z')).toBe(90);
  });

  it('should read the FIRST code point of a longer string', () => {
    expect(codePointOf('AB')).toBe(65);
  });

  it('should treat an astral-plane character as one code point, not a surrogate half', () => {
    expect(codePointOf('😀')).toBe(0x1_F6_00);
  });

  it('should throw on an empty string, the case every call site would otherwise guard against', () => {
    expect(() => codePointOf('')).toThrow('codePointOf received an empty string.');
  });
});

describe('toCdpModifiers', () => {
  it('should be zero for no modifiers', () => {
    expect(toCdpModifiers([])).toBe(0);
  });

  it('should map each resolved modifier name to its CDP bit', () => {
    expect(toCdpModifiers(['alt'])).toBe(1);
    expect(toCdpModifiers(['control'])).toBe(2);
    expect(toCdpModifiers(['meta'])).toBe(4);
    expect(toCdpModifiers(['shift'])).toBe(8);
  });

  it('should combine modifiers into one bitmask', () => {
    expect(toCdpModifiers(['control', 'shift'])).toBe(10);
    expect(toCdpModifiers(['alt', 'control', 'meta', 'shift'])).toBe(15);
  });

  it('should ignore an unknown name rather than throw, so a drifted twin still presses the key', () => {
    expect(toCdpModifiers(['control', 'hyper'])).toBe(2);
  });
});

describe('toCdpInputCommands: pointer', () => {
  it('should expand a tap into a touch pair, releasing with an empty touchPoints list', () => {
    expect(toCdpInputCommands({ kind: 'tap', modifiers: [], x: 10.5, y: 20.5 })).toEqual([
      {
        method: 'Input.dispatchTouchEvent',
        params: { modifiers: 0, touchPoints: [{ x: 10.5, y: 20.5 }], type: 'touchStart' }
      },
      {
        method: 'Input.dispatchTouchEvent',
        params: { modifiers: 0, touchPoints: [], type: 'touchEnd' }
      }
    ]);
  });

  it('should add a dwell before the release for a long press, and only for a long press', () => {
    const [, tapRelease] = toCdpInputCommands({ kind: 'tap', modifiers: [], x: 1, y: 2 });
    const [, longPressRelease] = toCdpInputCommands({ kind: 'longPress', modifiers: [], x: 1, y: 2 });

    expect(tapRelease?.delayBeforeInMilliseconds).toBeUndefined();
    expect(longPressRelease?.delayBeforeInMilliseconds).toBe(600);
  });

  it('should never delay the press itself', () => {
    const [press] = toCdpInputCommands({ kind: 'longPress', modifiers: [], x: 1, y: 2 });

    expect(press?.delayBeforeInMilliseconds).toBeUndefined();
  });

  it('should carry modifiers on both halves of the gesture', () => {
    const commands = toCdpInputCommands({ kind: 'tap', modifiers: ['shift'], x: 1, y: 2 });

    expect(commands.map((command) => command.params['modifiers'])).toEqual([8, 8]);
  });
});

describe('toCdpInputCommands: key', () => {
  it('should mirror the desktop rawKeyDown -> char -> keyUp shape for a printable character', () => {
    expect(toCdpInputCommands({ key: 'a', kind: 'key', modifiers: [] })).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { code: 'KeyA', key: 'a', modifiers: 0, type: 'rawKeyDown', windowsVirtualKeyCode: 65 } },
      { method: 'Input.dispatchKeyEvent', params: { code: 'KeyA', key: 'a', modifiers: 0, text: 'a', type: 'char', windowsVirtualKeyCode: 65 } },
      { method: 'Input.dispatchKeyEvent', params: { code: 'KeyA', key: 'a', modifiers: 0, type: 'keyUp', windowsVirtualKeyCode: 65 } }
    ]);
  });

  it('should skip the char event for a key that produces no text, exactly as a real key does', () => {
    const commands = toCdpInputCommands({ key: 'Escape', kind: 'key', modifiers: [] });

    expect(commands.map((command) => command.params['type'])).toEqual(['rawKeyDown', 'keyUp']);
    expect(commands.every((command) => command.params['text'] === undefined)).toBe(true);
  });

  it('should give Enter and Tab their real text, so a trusted Enter inserts a newline', () => {
    const enterChar = toCdpInputCommands({ key: 'Enter', kind: 'key', modifiers: [] })[1];
    const tabChar = toCdpInputCommands({ key: 'Tab', kind: 'key', modifiers: [] })[1];

    expect(enterChar?.params['text']).toBe('\r');
    expect(enterChar?.params['windowsVirtualKeyCode']).toBe(13);
    expect(tabChar?.params['text']).toBe('\t');
    expect(tabChar?.params['windowsVirtualKeyCode']).toBe(9);
  });

  it('should resolve a digit to its Digit code', () => {
    const [rawKeyDown] = toCdpInputCommands({ key: '2', kind: 'key', modifiers: [] });

    expect(rawKeyDown?.params['code']).toBe('Digit2');
    expect(rawKeyDown?.params['windowsVirtualKeyCode']).toBe(50);
  });

  it('should upper-case the virtual key code while keeping the typed character verbatim', () => {
    const commands = toCdpInputCommands({ key: 'z', kind: 'key', modifiers: [] });

    expect(commands[0]?.params['windowsVirtualKeyCode']).toBe(90);
    expect(commands[1]?.params['text']).toBe('z');
  });

  it('should carry a character with no stable physical key as text with an empty code', () => {
    const commands = toCdpInputCommands({ key: '€', kind: 'key', modifiers: [] });

    expect(commands[0]?.params['code']).toBe('');
    expect(commands[1]?.params['text']).toBe('€');
  });

  it('should treat a single astral-plane code point as one character rather than a name', () => {
    const commands = toCdpInputCommands({ key: '😀', kind: 'key', modifiers: [] });

    expect(commands[1]?.params['text']).toBe('😀');
  });

  it('should apply modifiers to every event of the press', () => {
    const commands = toCdpInputCommands({ key: 'a', kind: 'key', modifiers: ['control'] });

    expect(commands.map((command) => command.params['modifiers'])).toEqual([2, 2, 2]);
  });

  it('should throw on an unknown multi-character key name rather than press nothing', () => {
    expect(() => toCdpInputCommands({ key: 'Ctrl+K', kind: 'key', modifiers: [] }))
      .toThrow('pressKey received an unknown key name on mobile: "Ctrl+K"');
  });
});
