import {
  describe,
  expect,
  it
} from 'vitest';

import type {
  PageSettleState,
  SettleOptions
} from './settle-options.ts';

import { noopAsync } from '../noop.ts';
import {
  buildSettleRootMissingMessage,
  buildSettleTimeoutMessage,
  DEFAULT_SETTLE_QUIET_IN_MILLISECONDS,
  DEFAULT_SETTLE_TIMEOUT_IN_MILLISECONDS,
  describeUnsettledReasons,
  PageNotSettledError,
  resolveSettleOptions,
  waitForSettledState
} from './settle-options.ts';

interface FakeClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const QUIET_STATE: PageSettleState = { incompleteImageCount: 0, isFontLoading: false, sinceLastChangeInMilliseconds: 1000 };

describe('resolveSettleOptions', () => {
  it('should apply the defaults', () => {
    expect(DEFAULT_SETTLE_QUIET_IN_MILLISECONDS).toBe(150);
    expect(resolveSettleOptions({})).toEqual({
      quietInMilliseconds: 150,
      root: null,
      timeoutInMilliseconds: DEFAULT_SETTLE_TIMEOUT_IN_MILLISECONDS
    });
  });

  it('should keep given values', () => {
    expect(resolveSettleOptions({ quietInMilliseconds: 0, root: '.workspace', timeoutInMilliseconds: 500 })).toEqual({
      quietInMilliseconds: 0,
      root: '.workspace',
      timeoutInMilliseconds: 500
    });
  });

  it('should refuse a bad quiet window or timeout', () => {
    expect(() => resolveSettleOptions({ quietInMilliseconds: -5 })).toThrow('quietInMilliseconds must be a number of milliseconds from 0, got -5');
    expect(() => resolveSettleOptions({ quietInMilliseconds: NaN })).toThrow('got NaN');
    expect(() => resolveSettleOptions({ timeoutInMilliseconds: 0 })).toThrow('timeoutInMilliseconds must be a positive number of milliseconds, got 0');
    expect(() => resolveSettleOptions({ timeoutInMilliseconds: Infinity })).toThrow('got Infinity');
    expect(() => resolveSettleOptions({ quietInMilliseconds: 500, timeoutInMilliseconds: 500 })).toThrow(
      'quietInMilliseconds (500 ms) is not below timeoutInMilliseconds (500 ms)'
    );
  });

  it('should refuse an empty or non-string root', () => {
    expect(() => resolveSettleOptions({ root: '' })).toThrow('root must be a non-empty CSS selector, got ""');
    expect(() => resolveSettleOptions(JSON.parse('{"root":3}') as SettleOptions)).toThrow('got 3');
  });
});

describe('describeUnsettledReasons', () => {
  it('should be empty for a settled page', () => {
    expect(describeUnsettledReasons(QUIET_STATE, 150)).toEqual([]);
  });

  it('should name a lost watch alone', () => {
    expect(describeUnsettledReasons({ incompleteImageCount: 3, isFontLoading: true, sinceLastChangeInMilliseconds: null }, 150)).toEqual([
      'the watch was lost, probably because the window reloaded during the wait'
    ]);
  });

  it('should list the DOM, fonts and images in order', () => {
    expect(describeUnsettledReasons({ incompleteImageCount: 2, isFontLoading: true, sinceLastChangeInMilliseconds: 39.6 }, 150)).toEqual([
      'the DOM changed 40 ms ago',
      'a font is still loading',
      '2 images in view have not finished loading'
    ]);
  });

  it('should use the singular for one image', () => {
    expect(describeUnsettledReasons({ ...QUIET_STATE, incompleteImageCount: 1 }, 150)).toEqual(['1 image in view has not finished loading']);
  });
});

describe('messages', () => {
  it('should name the root that matches nothing, or the missing body', () => {
    expect(buildSettleRootMissingMessage('.x')).toContain('nothing matches root ".x"');
    expect(buildSettleRootMissingMessage(null)).toContain('has no <body>');
  });

  it('should name the budget, the reasons and the three ways out', () => {
    expect(buildSettleTimeoutMessage({
      quietInMilliseconds: 150,
      reasons: ['the DOM changed 5 ms ago', 'a font is still loading'],
      root: null,
      timeoutInMilliseconds: 10_000
    })).toBe(
      'waitForSettledPage: the page was not quiet for 150 ms within 10000 ms (the DOM changed 5 ms ago; a font is still loading). '
        + 'Raise timeoutInMilliseconds if the app is slow, pass root to watch only the part that matters (something elsewhere keeps changing), or lower quietInMilliseconds.'
    );
  });

  it('should name the root and cope with a page that settled just after the budget', () => {
    const message = buildSettleTimeoutMessage({ quietInMilliseconds: 50, reasons: [], root: '.view', timeoutInMilliseconds: 1000 });
    expect(message).toContain('".view" was not quiet');
    expect(message).toContain('it settled just after the budget ran out');
  });

  it('should carry the data and the cause on the error', () => {
    const cause = new Error('gone');
    const error = new PageNotSettledError({ cause, quietInMilliseconds: 150, reasons: ['r'], root: '.a', timeoutInMilliseconds: 900 });
    expect(error.name).toBe('PageNotSettledError');
    expect(error.reasons).toEqual(['r']);
    expect(error.root).toBe('.a');
    expect(error.quietInMilliseconds).toBe(150);
    expect(error.timeoutInMilliseconds).toBe(900);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('(r)');
    expect(new PageNotSettledError({ quietInMilliseconds: 150, reasons: [], root: null, timeoutInMilliseconds: 900 }).cause).toBeUndefined();
  });
});

describe('waitForSettledState', () => {
  function createClock(): FakeClock {
    let time = 0;
    return {
      now: () => time,
      sleep: async (milliseconds: number): Promise<void> => {
        time += milliseconds;
        await noopAsync();
      }
    };
  }

  it('should return as soon as a read is settled', async () => {
    const clock = createClock();
    const states: PageSettleState[] = [{ ...QUIET_STATE, sinceLastChangeInMilliseconds: 10 }, QUIET_STATE];
    let reads = 0;
    const reasons = await waitForSettledState({
      intervalInMilliseconds: 50,
      nowInMilliseconds: clock.now,
      quietInMilliseconds: 150,
      readState: async () => {
        reads++;
        await noopAsync();
        return states.shift() ?? QUIET_STATE;
      },
      sleep: clock.sleep,
      timeoutInMilliseconds: 1000
    });
    expect(reasons).toEqual([]);
    expect(reads).toBe(2);
  });

  it('should return the last reasons once the budget runs out', async () => {
    const clock = createClock();
    let reads = 0;
    const reasons = await waitForSettledState({
      intervalInMilliseconds: 50,
      nowInMilliseconds: clock.now,
      quietInMilliseconds: 150,
      readState: async () => {
        reads++;
        await noopAsync();
        return { ...QUIET_STATE, isFontLoading: true };
      },
      sleep: clock.sleep,
      timeoutInMilliseconds: 200
    });
    expect(reasons).toEqual(['a font is still loading']);
    expect(reads).toBe(5);
  });
});
