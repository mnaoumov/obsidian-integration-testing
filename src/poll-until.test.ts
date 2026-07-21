import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { pollUntil } from './poll-until.ts';

/**
 * Builds an injectable clock that advances by `stepInMilliseconds` on every read.
 *
 * @param stepInMilliseconds - How much time each read advances.
 * @returns A `nowInMilliseconds` function.
 */
function makeClock(stepInMilliseconds: number): () => number {
  let currentInMilliseconds = 0;
  return (): number => {
    const value = currentInMilliseconds;
    currentInMilliseconds += stepInMilliseconds;
    return value;
  };
}

describe('pollUntil', () => {
  it('returns immediately when the first attempt is accepted', async () => {
    const attempt = vi.fn(() => Promise.resolve('ready'));
    const sleep = vi.fn(() => Promise.resolve());

    const result = await pollUntil({
      attempt,
      intervalInMilliseconds: 10,
      nowInMilliseconds: makeClock(0),
      sleep,
      timeoutInMilliseconds: 1000,
      until: (value) => value === 'ready'
    });

    expect(result).toBe('ready');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until an attempt is accepted, sleeping between attempts', async () => {
    let calls = 0;
    const attempt = vi.fn(() => {
      calls++;
      return Promise.resolve(calls);
    });
    const sleep = vi.fn(() => Promise.resolve());

    const result = await pollUntil({
      attempt,
      intervalInMilliseconds: 10,
      nowInMilliseconds: makeClock(0),
      sleep,
      timeoutInMilliseconds: 1000,
      until: (value) => value >= 3
    });

    expect(result).toBe(3);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('rejects with the timeout message once the budget elapses', async () => {
    const attempt = vi.fn(() => Promise.resolve('never'));
    const sleep = vi.fn(() => Promise.resolve());

    await expect(pollUntil({
      attempt,
      intervalInMilliseconds: 10,
      // Each read advances 100ms, so the deadline (500ms) is crossed quickly.
      nowInMilliseconds: makeClock(100),
      sleep,
      timeoutInMilliseconds: 500,
      timeoutMessage: 'waiting for readiness',
      until: () => false
    })).rejects.toThrow('pollInObsidian timed out after 500 milliseconds: waiting for readiness');
  });

  it('omits the suffix when no timeout message is given', async () => {
    await expect(pollUntil({
      attempt: () => Promise.resolve(false),
      intervalInMilliseconds: 10,
      nowInMilliseconds: makeClock(100),
      sleep: () => Promise.resolve(),
      timeoutInMilliseconds: 500,
      until: (value) => value
    })).rejects.toThrow(/^pollInObsidian timed out after 500 milliseconds$/);
  });
});
