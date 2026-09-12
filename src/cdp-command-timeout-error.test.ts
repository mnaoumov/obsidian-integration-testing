import {
  describe,
  expect,
  it
} from 'vitest';

import { CdpCommandTimeoutError } from './cdp-command-timeout-error.ts';

const TIMEOUT_IN_MILLISECONDS = 30_000;

describe('CdpCommandTimeoutError', () => {
  // The wording predates the type and is what appears in every existing log, so it is kept verbatim.
  it('should report the elapsed budget and the method that got no answer', () => {
    const error = new CdpCommandTimeoutError({ method: 'Runtime.evaluate', timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS });

    expect(error.message).toBe('CDP command timed out after 30000ms: Runtime.evaluate');
    expect(error.name).toBe('CdpCommandTimeoutError');
  });

  // It exists to be told apart: only the eval carrying a caller's closure is re-reported as a cap overrun.
  it('should carry the method and budget for an instanceof-matching caller', () => {
    const error = new CdpCommandTimeoutError({ method: 'Page.navigate', timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS });

    expect(error).toBeInstanceOf(CdpCommandTimeoutError);
    expect(error.method).toBe('Page.navigate');
    expect(error.timeoutInMilliseconds).toBe(TIMEOUT_IN_MILLISECONDS);
  });
});
