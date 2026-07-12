import {
  describe,
  expect,
  it
} from 'vitest';

import type { CheckRendererBootStateParams } from './renderer-boot-detection.ts';

import {
  checkRendererBootState,
  DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS,
  resolveDeadBootGraceInMilliseconds
} from './renderer-boot-detection.ts';

// A terminally-dead boot: grace elapsed, no `window.app`, complete + empty body.
const DEAD_BOOT: CheckRendererBootStateParams = {
  bodyChildElementCount: 0,
  hasGraceElapsed: true,
  hasWindowApp: false,
  isDocumentComplete: true
};

describe('checkRendererBootState', () => {
  it('should be dead once the grace has elapsed with no window.app and an empty, complete document', () => {
    expect(checkRendererBootState(DEAD_BOOT)).toBe('dead');
  });

  it('should be pending whenever window.app is defined, even with an empty, complete document', () => {
    expect(checkRendererBootState({ ...DEAD_BOOT, hasWindowApp: true })).toBe('pending');
  });

  it('should be pending before the grace has elapsed, even with an empty, complete document', () => {
    expect(checkRendererBootState({ ...DEAD_BOOT, hasGraceElapsed: false })).toBe('pending');
  });

  it('should be pending when the body already has rendered content (a slow-but-valid boot)', () => {
    expect(checkRendererBootState({ ...DEAD_BOOT, bodyChildElementCount: 1 })).toBe('pending');
  });

  it('should be pending while the document is not yet complete', () => {
    expect(checkRendererBootState({ ...DEAD_BOOT, isDocumentComplete: false })).toBe('pending');
  });
});

describe('resolveDeadBootGraceInMilliseconds', () => {
  it('should default to 10000ms when the option is omitted', () => {
    expect(resolveDeadBootGraceInMilliseconds()).toBe(10000);
    expect(resolveDeadBootGraceInMilliseconds({})).toBe(10000);
    expect(DEFAULT_DEAD_BOOT_GRACE_IN_MILLISECONDS).toBe(10000);
  });

  it('should use the provided value when the option is set', () => {
    const CUSTOM_GRACE_IN_MILLISECONDS = 5000;
    expect(
      resolveDeadBootGraceInMilliseconds({ deadBootGraceInMilliseconds: CUSTOM_GRACE_IN_MILLISECONDS })
    ).toBe(CUSTOM_GRACE_IN_MILLISECONDS);
  });

  it('should allow 0 to disable fast-fail', () => {
    expect(resolveDeadBootGraceInMilliseconds({ deadBootGraceInMilliseconds: 0 })).toBe(0);
  });
});
