import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildSessionTerminatedMessage,
  classifyWebViewProbeFailure
} from './webview-probe-failure.ts';

describe('classifyWebViewProbeFailure', () => {
  it('reads Appium\'s terminated-session answer as session-terminated', () => {
    expect(classifyWebViewProbeFailure(new Error('WebDriverError: A session is either terminated or not started when running "execute/sync" with method "POST"')))
      .toBe('session-terminated');
  });

  it('reads the W3C invalid session id as session-terminated', () => {
    class InvalidSessionIdError extends Error {
      public override name = 'invalid session id';
    }
    expect(classifyWebViewProbeFailure(new InvalidSessionIdError('session deleted'))).toBe('session-terminated');
  });

  it('reads a closed ChromeDriver window as window-closed', () => {
    expect(classifyWebViewProbeFailure(new Error('no such window: target window already closed'))).toBe('window-closed');
    expect(classifyWebViewProbeFailure(new Error('from unknown error: web view not found'))).toBe('window-closed');
  });

  it('finds the driver\'s answer in the cause chain', () => {
    const error = new Error('execute/sync failed', { cause: new Error('no such window: target window already closed') });
    expect(classifyWebViewProbeFailure(error)).toBe('window-closed');
  });

  it('prefers session-terminated when both appear', () => {
    const error = new Error('no such window', { cause: new Error('A session is either terminated or not started') });
    expect(classifyWebViewProbeFailure(error)).toBe('session-terminated');
  });

  it('reads anything else as other', () => {
    expect(classifyWebViewProbeFailure(new Error('javascript error: app is not defined'))).toBe('other');
    expect(classifyWebViewProbeFailure('timeout')).toBe('other');
    expect(classifyWebViewProbeFailure(undefined)).toBe('other');
  });

  it('survives a cyclic cause chain', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });
    Object.defineProperty(inner, 'cause', { value: outer });
    expect(classifyWebViewProbeFailure(outer)).toBe('other');
  });
});

describe('buildSessionTerminatedMessage', () => {
  it('names the phase, the elapsed time, the vault and the cause', () => {
    const message = buildSessionTerminatedMessage({
      deviceVaultPath: '/sdcard/Documents/temp-vault-x',
      elapsedInMilliseconds: 3996,
      error: new Error('A session is either terminated or not started'),
      phase: 'app-start'
    });

    expect(message).toContain('phase "app-start"');
    expect(message).toContain('after 3996ms');
    expect(message).toContain('/sdcard/Documents/temp-vault-x');
    expect(message).toContain('A session is either terminated or not started');
  });
});
