import {
  describe,
  expect,
  it
} from 'vitest';

import type { LayoutProblem } from './layout-options.ts';

import {
  buildFocusStartMessage,
  buildLayoutFailureMessage,
  buildNoChecksMessage,
  buildRootMissingMessage,
  capLayoutProblems,
  DEFAULT_MAXIMUM_FOCUS_STOP_COUNT,
  DEFAULT_MINIMUM_TOUCH_SIZE_IN_PIXELS,
  DEFAULT_TOUCH_TARGET_SELECTOR,
  resolveLayoutCheckOptions
} from './layout-options.ts';

describe('resolveLayoutCheckOptions', () => {
  it('fills in every default for a bare root', () => {
    expect(resolveLayoutCheckOptions({ root: '.modal' })).toEqual({
      focusRing: {
        ignoreSelector: null,
        isEnabled: false,
        maximumStopCount: DEFAULT_MAXIMUM_FOCUS_STOP_COUNT,
        shouldStayInside: false,
        startSelector: null
      },
      overflow: { ignoreSelector: null, isEnabled: true },
      root: '.modal',
      touchTargets: {
        ignoreSelector: null,
        isEnabled: null,
        minimumSizeInPixels: DEFAULT_MINIMUM_TOUCH_SIZE_IN_PIXELS,
        selector: DEFAULT_TOUCH_TARGET_SELECTOR
      }
    });
  });

  it('reads booleans as on and off', () => {
    const resolved = resolveLayoutCheckOptions({ focusRing: true, overflow: false, root: '.modal', touchTargets: false });
    expect(resolved.focusRing.isEnabled).toBe(true);
    expect(resolved.overflow.isEnabled).toBe(false);
    expect(resolved.touchTargets.isEnabled).toBe(false);
  });

  it('reads option objects as on, with their values', () => {
    const resolved = resolveLayoutCheckOptions({
      focusRing: { ignoreSelector: '.skip', maximumStopCount: 5, shouldStayInside: true, startSelector: 'button' },
      overflow: { ignoreSelector: 'pre' },
      root: '.modal',
      touchTargets: { ignoreSelector: '.small', minimumSizeInPixels: 48, selector: 'button' }
    });
    expect(resolved.focusRing).toEqual({
      ignoreSelector: '.skip',
      isEnabled: true,
      maximumStopCount: 5,
      shouldStayInside: true,
      startSelector: 'button'
    });
    expect(resolved.overflow).toEqual({ ignoreSelector: 'pre', isEnabled: true });
    expect(resolved.touchTargets).toEqual({ ignoreSelector: '.small', isEnabled: true, minimumSizeInPixels: 48, selector: 'button' });
  });

  it('keeps the defaults of an empty option object', () => {
    const resolved = resolveLayoutCheckOptions({ focusRing: {}, overflow: {}, root: '.modal', touchTargets: {} });
    expect(resolved.focusRing.maximumStopCount).toBe(DEFAULT_MAXIMUM_FOCUS_STOP_COUNT);
    expect(resolved.focusRing.shouldStayInside).toBe(false);
    expect(resolved.overflow.ignoreSelector).toBeNull();
    expect(resolved.touchTargets.minimumSizeInPixels).toBe(DEFAULT_MINIMUM_TOUCH_SIZE_IN_PIXELS);
    expect(resolved.touchTargets.selector).toBe(DEFAULT_TOUCH_TARGET_SELECTOR);
  });

  it.each([
    [null, 'pass an object'],
    [['.modal'], 'pass an object'],
    [{}, 'root is required'],
    [{ root: '' }, 'root must be a non-empty CSS selector'],
    [{ root: 42 }, 'root must be a non-empty CSS selector, got 42'],
    [{ root: '.modal', size: 1 }, 'unknown key(s) in the options: size'],
    [{ overflow: 'yes', root: '.modal' }, 'overflow must be true, false or an object'],
    [{ overflow: { ignore: 'pre' }, root: '.modal' }, 'unknown key(s) in overflow: ignore'],
    [{ root: '.modal', touchTargets: 3 }, 'touchTargets must be true, false or an object'],
    [{ root: '.modal', touchTargets: { minSize: 3 } }, 'unknown key(s) in touchTargets: minSize'],
    [{ root: '.modal', touchTargets: { minimumSizeInPixels: 0 } }, 'touchTargets.minimumSizeInPixels must be a number'],
    [{ root: '.modal', touchTargets: { minimumSizeInPixels: 'big' } }, 'touchTargets.minimumSizeInPixels must be a number'],
    [{ root: '.modal', touchTargets: { minimumSizeInPixels: Infinity } }, 'got null'],
    [{ root: '.modal', touchTargets: { selector: ' ' } }, 'touchTargets.selector must be a non-empty CSS selector'],
    [{ focusRing: 'on', root: '.modal' }, 'focusRing must be true, false or an object'],
    [{ focusRing: { from: 'a' }, root: '.modal' }, 'unknown key(s) in focusRing: from'],
    [{ focusRing: { maximumStopCount: 0 }, root: '.modal' }, 'focusRing.maximumStopCount must be a whole number from 1 to 100'],
    [{ focusRing: { maximumStopCount: 101 }, root: '.modal' }, 'focusRing.maximumStopCount must be a whole number'],
    [{ focusRing: { maximumStopCount: 1.5 }, root: '.modal' }, 'focusRing.maximumStopCount must be a whole number'],
    [{ focusRing: { maximumStopCount: '3' }, root: '.modal' }, 'focusRing.maximumStopCount must be a whole number'],
    [{ focusRing: { shouldStayInside: 'yes' }, root: '.modal' }, 'focusRing.shouldStayInside must be true or false'],
    [{ focusRing: { startSelector: '' }, root: '.modal' }, 'focusRing.startSelector must be a non-empty CSS selector']
  ])('refuses %j', (options, message) => {
    expect(() => resolveLayoutCheckOptions(options)).toThrow(message);
  });

  it('names a value JSON cannot represent by its string form', () => {
    expect(() => resolveLayoutCheckOptions({ root: '.modal', touchTargets: { minimumSizeInPixels: Symbol('size') } })).toThrow(
      'got Symbol(size)'
    );
  });
});

describe('capLayoutProblems', () => {
  function overflow(where: string): LayoutProblem {
    return { check: 'overflow', detail: 'wide', where };
  }

  function ring(where: string): LayoutProblem {
    return { check: 'focus-ring', detail: 'none', where };
  }

  it('keeps every problem under the limit and reports no cut', () => {
    const problems = [overflow('a'), ring('b')];
    expect(capLayoutProblems(problems, 2)).toEqual({ cuts: [], problems });
  });

  it('cuts each kind to the limit, keeping the order, and reports the totals of the cut kinds', () => {
    const problems = [overflow('a'), ring('b'), overflow('c'), overflow('d'), ring('e')];
    expect(capLayoutProblems(problems, 2)).toEqual({
      cuts: [{ check: 'overflow', total: 3 }],
      problems: [overflow('a'), ring('b'), overflow('c'), ring('e')]
    });
  });
});

describe('buildLayoutFailureMessage', () => {
  it('lists one problem in the singular, with no hint for overflow', () => {
    expect(buildLayoutFailureMessage({
      cuts: [],
      minimumSizeInPixels: 44,
      problems: [{ check: 'overflow', detail: 'scrollWidth 300 > clientWidth 200', where: 'div.wide' }],
      root: '.modal'
    })).toBe('assertLayout(): 1 problem inside ".modal":\n  - horizontal overflow: div.wide (scrollWidth 300 > clientWidth 200)');
  });

  it('lists every problem, the cuts and one hint per kind', () => {
    const message = buildLayoutFailureMessage({
      cuts: [{ check: 'touch-target', total: 12 }],
      minimumSizeInPixels: 48,
      problems: [
        { check: 'touch-target', detail: '20 x 20 px', where: 'button.tiny' },
        { check: 'focus-ring', detail: 'no change', where: 'button.flat' },
        { check: 'focus-escape', detail: 'Tab 3 moved focus out', where: 'div.outside' }
      ],
      root: '.modal'
    });
    expect(message).toContain('3 problems inside ".modal"');
    expect(message).toContain('  - touch target too small: button.tiny (20 x 20 px)');
    expect(message).toContain('  - no focus ring: button.flat (no change)');
    expect(message).toContain('  - focus left the root: div.outside (Tab 3 moved focus out)');
    expect(message).toContain('  - touch target too small: (first 1 of 12)');
    expect(message).toContain('at least 48 px');
    expect(message).toContain('a resting box-shadow does not count');
    expect(message).toContain('Keep Tab inside a modal');
  });
});

describe('buildFocusStartMessage', () => {
  it('says nothing can take focus when no start selector was given', () => {
    expect(buildFocusStartMessage({ outcome: 'no-start', root: '.modal', startSelector: null })).toContain('nothing inside ".modal" can take focus');
  });

  it('says the start selector matches nothing', () => {
    expect(buildFocusStartMessage({ outcome: 'no-start', root: '.modal', startSelector: '.first' })).toContain(
      'focusRing.startSelector ".first" matches nothing'
    );
  });

  it('says the start did not take focus, naming the selector when there is one', () => {
    expect(buildFocusStartMessage({ outcome: 'not-focused', root: '.modal', startSelector: null })).toContain(
      'the element where the Tab walk starts did not take focus'
    );
    expect(buildFocusStartMessage({ outcome: 'not-focused', root: '.modal', startSelector: '.first' })).toContain(
      'the element where the Tab walk starts (".first") did not take focus'
    );
  });

  it('says the start is outside the root', () => {
    expect(buildFocusStartMessage({ outcome: 'outside-root', root: '.modal', startSelector: 'body' })).toContain(
      'focusRing.startSelector "body" is not inside ".modal"'
    );
  });
});

describe('the fixed messages', () => {
  it('names the missing root', () => {
    expect(buildRootMissingMessage('.modal')).toContain('nothing matches the root ".modal"');
  });

  it('says every check is off', () => {
    expect(buildNoChecksMessage()).toContain('nothing to check');
  });
});
