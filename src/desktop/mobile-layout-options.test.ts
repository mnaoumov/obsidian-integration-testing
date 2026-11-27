import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { MobileLayoutPageState } from './mobile-layout-options.ts';

import { noopAsync } from '../noop.ts';
import {
  buildMobileLayoutOverridePayload,
  buildMobileLayoutProbeExpression,
  buildMobileLayoutSwitchExpression,
  checkIsSameMobileLayoutViewport,
  DEFAULT_MOBILE_LAYOUT_VIEWPORT,
  describeMobileLayoutPending,
  MOBILE_LAYOUT_RELOAD_MARKER,
  MobileLayoutTimeoutError,
  parseMobileLayoutPageState,
  resolveMobileLayoutViewport,
  waitForMobileLayoutState
} from './mobile-layout-options.ts';

const READY_STATE: MobileLayoutPageState = {
  isLayoutReady: true,
  isMobileEmulationStored: true,
  isMobileLayout: true,
  isReloadPending: false,
  widthInPixels: 390
};

async function resolveLater<Value>(value: Value): Promise<Value> {
  await noopAsync();
  return value;
}

function runExpression(expression: string, windowStub: Record<string, unknown>): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- Runs the page script against a stub window, as the page would.
  const run = new Function('window', `return ${expression};`) as (window: Record<string, unknown>) => unknown;
  return run(windowStub);
}

describe('resolveMobileLayoutViewport', () => {
  it('should default to a 390x844 phone at twice the pixel density', () => {
    expect(resolveMobileLayoutViewport()).toStrictEqual(DEFAULT_MOBILE_LAYOUT_VIEWPORT);
  });

  it('should take each value given', () => {
    expect(resolveMobileLayoutViewport({ deviceScaleFactor: 3, heightInPixels: 700, widthInPixels: 360 })).toStrictEqual({
      deviceScaleFactor: 3,
      heightInPixels: 700,
      widthInPixels: 360
    });
  });

  it('should refuse a value that is not a positive finite number', () => {
    expect(() => resolveMobileLayoutViewport({ widthInPixels: 0 })).toThrow('widthInPixels must be a positive number, got 0.');
    expect(() => resolveMobileLayoutViewport({ heightInPixels: -1 })).toThrow('heightInPixels');
    expect(() => resolveMobileLayoutViewport({ deviceScaleFactor: NaN })).toThrow('deviceScaleFactor');
    expect(() => resolveMobileLayoutViewport({ deviceScaleFactor: Infinity })).toThrow('deviceScaleFactor');
  });

  it('should refuse a size that is not a whole number', () => {
    expect(() => resolveMobileLayoutViewport({ widthInPixels: 390.5 })).toThrow('whole number');
  });

  it('should accept a fractional scale factor', () => {
    expect(resolveMobileLayoutViewport({ deviceScaleFactor: 2.625 }).deviceScaleFactor).toBe(2.625);
  });
});

describe('buildMobileLayoutOverridePayload', () => {
  it('should build the CDP payload with Chromium mobile mode off', () => {
    expect(buildMobileLayoutOverridePayload(DEFAULT_MOBILE_LAYOUT_VIEWPORT)).toStrictEqual({
      deviceScaleFactor: 2,
      height: 844,
      mobile: false,
      width: 390
    });
  });
});

describe('checkIsSameMobileLayoutViewport', () => {
  it('should compare every field', () => {
    expect(checkIsSameMobileLayoutViewport(DEFAULT_MOBILE_LAYOUT_VIEWPORT, { ...DEFAULT_MOBILE_LAYOUT_VIEWPORT })).toBe(true);
    expect(checkIsSameMobileLayoutViewport(DEFAULT_MOBILE_LAYOUT_VIEWPORT, { ...DEFAULT_MOBILE_LAYOUT_VIEWPORT, widthInPixels: 360 })).toBe(false);
    expect(checkIsSameMobileLayoutViewport(DEFAULT_MOBILE_LAYOUT_VIEWPORT, { ...DEFAULT_MOBILE_LAYOUT_VIEWPORT, heightInPixels: 700 })).toBe(false);
    expect(checkIsSameMobileLayoutViewport(DEFAULT_MOBILE_LAYOUT_VIEWPORT, { ...DEFAULT_MOBILE_LAYOUT_VIEWPORT, deviceScaleFactor: 3 })).toBe(false);
  });
});

describe('buildMobileLayoutProbeExpression', () => {
  it('should read a laid-out mobile page', () => {
    const json = runExpression(buildMobileLayoutProbeExpression(), {
      app: { workspace: { layoutReady: true } },
      document: { body: { classList: { contains: (name: string): boolean => name === 'is-mobile' } } },
      innerWidth: 390,
      localStorage: { getItem: (key: string): null | string => key === 'EmulateMobile' ? '1' : null },
      [MOBILE_LAYOUT_RELOAD_MARKER]: true
    });
    expect(parseMobileLayoutPageState(String(json))).toStrictEqual({
      isLayoutReady: true,
      isMobileEmulationStored: true,
      isMobileLayout: true,
      isReloadPending: true,
      widthInPixels: 390
    });
  });

  it('should read a page with no app, no body and an unreadable local storage without throwing', () => {
    const json = runExpression(buildMobileLayoutProbeExpression(), {
      document: { body: null },
      innerWidth: 1200,
      localStorage: {
        getItem: (): never => {
          throw new Error('denied');
        }
      }
    });
    expect(parseMobileLayoutPageState(String(json))).toStrictEqual({
      isLayoutReady: false,
      isMobileEmulationStored: false,
      isMobileLayout: false,
      isReloadPending: false,
      widthInPixels: 1200
    });
  });
});

describe('buildMobileLayoutSwitchExpression', () => {
  it('should mark the page and switch the emulation from a timer', () => {
    const emulateMobile = vi.fn();
    let scheduled: (() => void) | undefined;
    const windowStub: Record<string, unknown> = {
      app: { emulateMobile },
      setTimeout: (callback: () => void): void => {
        scheduled = callback;
      }
    };
    expect(runExpression(buildMobileLayoutSwitchExpression(true), windowStub)).toBe('scheduled');
    expect(windowStub[MOBILE_LAYOUT_RELOAD_MARKER]).toBe(true);
    expect(emulateMobile).not.toHaveBeenCalled();
    scheduled?.();
    expect(emulateMobile).toHaveBeenCalledWith(true);
  });

  it('should switch it off', () => {
    const emulateMobile = vi.fn();
    runExpression(buildMobileLayoutSwitchExpression(false), {
      app: { emulateMobile },
      setTimeout: (callback: () => void): void => {
        callback();
      }
    });
    expect(emulateMobile).toHaveBeenCalledWith(false);
  });

  it('should report a page with no emulateMobile and leave it unmarked', () => {
    const windowStub: Record<string, unknown> = { app: {} };
    expect(runExpression(buildMobileLayoutSwitchExpression(true), windowStub)).toBe('missing');
    expect(windowStub[MOBILE_LAYOUT_RELOAD_MARKER]).toBeUndefined();
    expect(runExpression(buildMobileLayoutSwitchExpression(true), {})).toBe('missing');
  });
});

describe('parseMobileLayoutPageState', () => {
  it('should refuse text that is not a state', () => {
    expect(parseMobileLayoutPageState('not json')).toBeNull();
    expect(parseMobileLayoutPageState('null')).toBeNull();
    expect(parseMobileLayoutPageState('5')).toBeNull();
    expect(parseMobileLayoutPageState(JSON.stringify({ ...READY_STATE, widthInPixels: '390' }))).toBeNull();
    expect(parseMobileLayoutPageState(JSON.stringify({ ...READY_STATE, isLayoutReady: 1 }))).toBeNull();
    expect(parseMobileLayoutPageState(JSON.stringify({ ...READY_STATE, isMobileEmulationStored: 1 }))).toBeNull();
    expect(parseMobileLayoutPageState(JSON.stringify({ ...READY_STATE, isMobileLayout: 1 }))).toBeNull();
    expect(parseMobileLayoutPageState(JSON.stringify({ ...READY_STATE, isReloadPending: 1 }))).toBeNull();
  });
});

describe('describeMobileLayoutPending', () => {
  it('should report nothing for a page in the asked-for layout', () => {
    expect(describeMobileLayoutPending({ isOn: true, state: READY_STATE, widthInPixels: 390 })).toStrictEqual([]);
    expect(describeMobileLayoutPending({ isOn: true, state: { ...READY_STATE, widthInPixels: 1 }, widthInPixels: null })).toStrictEqual([]);
  });

  it('should report a page that did not answer', () => {
    expect(describeMobileLayoutPending({ isOn: true, state: null, widthInPixels: 390 })).toStrictEqual([
      'the page did not answer (it is still reloading)'
    ]);
  });

  it('should report everything still missing', () => {
    expect(describeMobileLayoutPending({
      isOn: true,
      state: { isLayoutReady: false, isMobileEmulationStored: true, isMobileLayout: false, isReloadPending: true, widthInPixels: 1200 },
      widthInPixels: 390
    })).toStrictEqual([
      'the page has not reloaded since the emulation was switched',
      'the workspace layout is not ready',
      'the body lacks is-mobile',
      'the viewport is 1200 pixels wide, not 390'
    ]);
    expect(describeMobileLayoutPending({ isOn: false, state: READY_STATE, widthInPixels: null })).toStrictEqual([
      'the body still has is-mobile'
    ]);
  });

  it('should not check the layout when asked only for the width', () => {
    expect(describeMobileLayoutPending({ isOn: null, state: { ...READY_STATE, isMobileLayout: false }, widthInPixels: 390 })).toStrictEqual([]);
  });
});

describe('waitForMobileLayoutState', () => {
  it('should read until the page reaches the layout', async () => {
    const states: (MobileLayoutPageState | null)[] = [null, { ...READY_STATE, isReloadPending: true }, READY_STATE];
    const sleep = vi.fn(noopAsync);
    const state = await waitForMobileLayoutState({
      intervalInMilliseconds: 100,
      isOn: true,
      nowInMilliseconds: () => 0,
      readState: async () => resolveLater(states.shift() ?? null),
      sleep,
      timeoutInMilliseconds: 1000,
      widthInPixels: 390
    });
    expect(state).toStrictEqual(READY_STATE);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('should throw naming what was missing once the budget runs out', async () => {
    let now = 0;
    const promise = waitForMobileLayoutState({
      intervalInMilliseconds: 100,
      isOn: true,
      nowInMilliseconds: () => now,
      readState: async () => resolveLater({ ...READY_STATE, isMobileLayout: false }),
      sleep: async (milliseconds) => {
        now += milliseconds;
        await noopAsync();
      },
      timeoutInMilliseconds: 250,
      widthInPixels: 390
    });
    await expect(promise).rejects.toThrow(MobileLayoutTimeoutError);
    await expect(promise).rejects.toThrow('The mobile layout was not turned on within 250 ms: the body lacks is-mobile.');
  });

  it('should carry the direction, reasons and budget on the error', async () => {
    const error = await waitForMobileLayoutState({
      intervalInMilliseconds: 100,
      isOn: false,
      nowInMilliseconds: () => 0,
      readState: async () => resolveLater(null),
      sleep: noopAsync,
      timeoutInMilliseconds: 0,
      widthInPixels: null
    }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(MobileLayoutTimeoutError);
    const timeoutError = error as MobileLayoutTimeoutError;
    expect(timeoutError.name).toBe('MobileLayoutTimeoutError');
    expect(timeoutError.isOn).toBe(false);
    expect(timeoutError.reasons).toStrictEqual(['the page did not answer (it is still reloading)']);
    expect(timeoutError.timeoutInMilliseconds).toBe(0);
    expect(timeoutError.message).toBe('The mobile layout was not turned off within 0 ms: the page did not answer (it is still reloading).');
  });

  it('should name a wait for the width alone as a resize', async () => {
    await expect(waitForMobileLayoutState({
      intervalInMilliseconds: 100,
      isOn: null,
      nowInMilliseconds: () => 0,
      readState: async () => resolveLater({ ...READY_STATE, widthInPixels: 1200 }),
      sleep: noopAsync,
      timeoutInMilliseconds: 0,
      widthInPixels: 390
    })).rejects.toThrow('The mobile layout was not resized within 0 ms: the viewport is 1200 pixels wide, not 390.');
  });
});
