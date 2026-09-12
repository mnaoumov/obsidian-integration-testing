import {
  describe,
  expect,
  it
} from 'vitest';

import {
  EvalCapExceededError,
  isScriptTimeoutError
} from './eval-cap-exceeded-error.ts';

const CAP_IN_MILLISECONDS = 30_000;

describe('EvalCapExceededError', () => {
  it('should name the cap, the transport, and the option that sets it', () => {
    const error = new EvalCapExceededError({
      capInMilliseconds: CAP_IN_MILLISECONDS,
      cause: new Error('script timeout'),
      optionName: 'scriptTimeoutInMilliseconds',
      transportName: 'Android (Appium)'
    });

    expect(error.message).toContain('30000ms');
    expect(error.message).toContain('Android (Appium)');
    expect(error.message).toContain('scriptTimeoutInMilliseconds');
  });

  // The whole point of the error: the reader has to be sent to the fix, not left with a timeout.
  it('should point at pollInObsidian rather than at the device', () => {
    const error = new EvalCapExceededError({
      capInMilliseconds: CAP_IN_MILLISECONDS,
      cause: new Error('script timeout'),
      optionName: 'commandTimeoutInMilliseconds',
      transportName: 'desktop (CDP)'
    });

    expect(error.message).toContain('pollInObsidian');
    expect(error.message).toContain('waitUntil');
  });

  it('should keep the raw transport error as its cause', () => {
    const cause = new Error('script timeout');
    const error = new EvalCapExceededError({
      capInMilliseconds: CAP_IN_MILLISECONDS,
      cause,
      optionName: 'scriptTimeoutInMilliseconds',
      transportName: 'Android (Appium)'
    });

    expect(error.cause).toBe(cause);
    expect(error.name).toBe('EvalCapExceededError');
    expect(error.capInMilliseconds).toBe(CAP_IN_MILLISECONDS);
    expect(error.transportName).toBe('Android (Appium)');
  });
});

describe('isScriptTimeoutError', () => {
  // The shape WebDriver actually raises: a generic error whose only mark is the W3C code in its text.
  it('should recognize a WebDriver script timeout by its message', () => {
    expect(isScriptTimeoutError(new Error('script timeout: result was not received in 30 seconds'))).toBe(true);
  });

  it('should recognize it by its name, whatever the message says', () => {
    const error = new Error('Something went wrong');
    // Defined rather than assigned: `unicorn/no-error-property-assignment` bans writing `name` on a
    // Built-in error, and the shape under test is a client that renamed the W3C code into a type.
    Object.defineProperty(error, 'name', { value: 'ScriptTimeoutError' });
    expect(isScriptTimeoutError(error)).toBe(true);
  });

  it('should not claim an unrelated transport failure', () => {
    expect(isScriptTimeoutError(new Error('no such window: target window already closed'))).toBe(false);
  });

  it('should not throw on a non-error value', () => {
    expect(isScriptTimeoutError('script timeout')).toBe(false);
    expect(isScriptTimeoutError(undefined)).toBe(false);
  });
});
