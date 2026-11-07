import {
  describe,
  expect,
  it
} from 'vitest';

import {
  checkIsAppReadyAfterWindowRecovery,
  describeAppReadyAfterWindowRecoveryProbe
} from './app-ready-after-window-recovery.ts';

describe('checkIsAppReadyAfterWindowRecovery', () => {
  it('is ready only with app, plugins and a laid-out workspace', () => {
    expect(checkIsAppReadyAfterWindowRecovery({ hasApp: true, hasPlugins: true, isLayoutReady: true })).toBe(true);
    expect(checkIsAppReadyAfterWindowRecovery({ hasApp: true, hasPlugins: true, isLayoutReady: false })).toBe(false);
    expect(checkIsAppReadyAfterWindowRecovery({ hasApp: true, hasPlugins: false, isLayoutReady: true })).toBe(false);
    expect(checkIsAppReadyAfterWindowRecovery({ hasApp: false, hasPlugins: false, isLayoutReady: false })).toBe(false);
  });

  it('is not ready for an answer that is not a probe', () => {
    expect(checkIsAppReadyAfterWindowRecovery(undefined)).toBe(false);
    expect(checkIsAppReadyAfterWindowRecovery(null)).toBe(false);
    expect(checkIsAppReadyAfterWindowRecovery('"ok"')).toBe(false);
  });
});

describe('describeAppReadyAfterWindowRecoveryProbe', () => {
  it('names the first missing piece', () => {
    expect(describeAppReadyAfterWindowRecoveryProbe(undefined)).toBe('the WebView did not answer the probe');
    expect(describeAppReadyAfterWindowRecoveryProbe({ hasApp: false, hasPlugins: false, isLayoutReady: false })).toBe('`globalThis.app` does not exist yet');
    expect(describeAppReadyAfterWindowRecoveryProbe({ hasApp: true, hasPlugins: false, isLayoutReady: false })).toBe('`app.plugins` does not exist yet');
    expect(describeAppReadyAfterWindowRecoveryProbe({ hasApp: true, hasPlugins: true, isLayoutReady: false })).toBe('`app.workspace.layoutReady` is not true yet');
    expect(describeAppReadyAfterWindowRecoveryProbe({ hasApp: true, hasPlugins: true, isLayoutReady: true })).toBe('ready');
  });
});
