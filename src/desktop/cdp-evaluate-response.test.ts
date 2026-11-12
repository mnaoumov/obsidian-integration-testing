import {
  describe,
  expect,
  it
} from 'vitest';

import { CollectedPromiseError } from '../eval/collected-promise-error.ts';
import {
  checkIsCollectedPromiseMessage,
  NO_OUTPUT,
  resolveCdpEvaluateResult
} from './cdp-evaluate-response.ts';

describe('checkIsCollectedPromiseMessage', () => {
  it('should match the message Chromium sends for a collected promise', () => {
    expect(checkIsCollectedPromiseMessage('Promise was collected')).toBe(true);
  });

  it('should not match another protocol error', () => {
    expect(checkIsCollectedPromiseMessage('Cannot find context with specified id')).toBe(false);
  });
});

describe('resolveCdpEvaluateResult', () => {
  it('should throw CollectedPromiseError for the reply Chromium sends when the awaited promise was collected', () => {
    // Captured from a live desktop run.
    const response = { error: { code: -32_000, message: 'Promise was collected' }, id: 12 };

    expect(() => resolveCdpEvaluateResult(response)).toThrow(CollectedPromiseError);
    expect(() => resolveCdpEvaluateResult(response)).toThrow(/garbage-collected/);
  });

  it('should keep the protocol error as the cause', () => {
    let caught: unknown;
    try {
      resolveCdpEvaluateResult({ error: { message: 'Promise was collected' } });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CollectedPromiseError);
    expect((caught as CollectedPromiseError).transportName).toBe('desktop (CDP)');
    expect(((caught as CollectedPromiseError).cause as Error).message).toBe('CDP Runtime.evaluate failed: Promise was collected');
  });

  it('should throw any other protocol error rather than return no output', () => {
    expect(() => resolveCdpEvaluateResult({ error: { message: 'Cannot find context with specified id' } }))
      .toThrow('CDP Runtime.evaluate failed: Cannot find context with specified id');
  });

  it('should throw the exception description when the closure threw', () => {
    expect(() =>
      resolveCdpEvaluateResult({
        result: { exceptionDetails: { exception: { description: 'Error: boom' }, text: 'Uncaught' } }
      })
    ).toThrow('CDP evaluation error: Error: boom');
  });

  it('should fall back to the exception text when there is no description', () => {
    expect(() => resolveCdpEvaluateResult({ result: { exceptionDetails: { text: 'Uncaught' } } }))
      .toThrow('CDP evaluation error: Uncaught');
  });

  it('should return no output for an undefined result', () => {
    expect(resolveCdpEvaluateResult({ result: { result: { type: 'undefined' } } })).toBe(NO_OUTPUT);
  });

  it('should return no output for a reply with no result', () => {
    expect(resolveCdpEvaluateResult({})).toBe(NO_OUTPUT);
  });

  it('should return the value as a string', () => {
    expect(resolveCdpEvaluateResult({ result: { result: { type: 'string', value: '{"a":1}' } } })).toBe('{"a":1}');
  });
});
