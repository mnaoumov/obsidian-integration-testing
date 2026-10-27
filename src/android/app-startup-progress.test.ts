import {
  describe,
  expect,
  it
} from 'vitest';

import type {
  AppStartupMilestone,
  BuildStartupTimeoutMessageParams
} from './app-startup-progress.ts';

import {
  buildStartupTimeoutMessage,
  checkAppStarted,
  checkLayoutReady,
  classifyAppStartupProbe,
  compareAppStartupMilestones
} from './app-startup-progress.ts';

const BASE_MESSAGE_PARAMS: BuildStartupTimeoutMessageParams = {
  elapsedInMilliseconds: 90_123,
  milestone: 'no-app',
  phase: 'layout-ready',
  pollCount: 3,
  slowestRoundTripInMilliseconds: 41_000,
  timeoutInMilliseconds: 90_000
};

describe('classifyAppStartupProbe', () => {
  it('should report no-webview when the probe could not run', () => {
    expect(classifyAppStartupProbe(undefined)).toBe('no-webview');
  });

  it('should report no-app when the global app object is absent', () => {
    expect(classifyAppStartupProbe({ hasApp: false, hasWorkspace: false, isLayoutReady: false })).toBe('no-app');
  });

  it('should report no-workspace when the app exists but its workspace does not', () => {
    expect(classifyAppStartupProbe({ hasApp: true, hasWorkspace: false, isLayoutReady: false })).toBe('no-workspace');
  });

  it('should report workspace-not-ready when the workspace exists but has not laid out', () => {
    expect(classifyAppStartupProbe({ hasApp: true, hasWorkspace: true, isLayoutReady: false })).toBe('workspace-not-ready');
  });

  it('should report layout-ready once the workspace has laid out', () => {
    expect(classifyAppStartupProbe({ hasApp: true, hasWorkspace: true, isLayoutReady: true })).toBe('layout-ready');
  });
});

describe('compareAppStartupMilestones', () => {
  it('should order a less advanced milestone below a more advanced one', () => {
    expect(compareAppStartupMilestones('no-webview', 'layout-ready')).toBeLessThan(0);
  });

  it('should order a more advanced milestone above a less advanced one', () => {
    expect(compareAppStartupMilestones('workspace-not-ready', 'no-app')).toBeGreaterThan(0);
  });

  it('should treat the same milestone as equal', () => {
    expect(compareAppStartupMilestones('no-workspace', 'no-workspace')).toBe(0);
  });
});

describe('checkAppStarted', () => {
  it.each<[AppStartupMilestone, boolean]>([
    ['no-webview', false],
    ['no-app', false],
    ['no-workspace', true],
    ['workspace-not-ready', true],
    ['layout-ready', true]
  ])('should report %s as started=%s', (milestone, expected) => {
    expect(checkAppStarted(milestone)).toBe(expected);
  });
});

describe('checkLayoutReady', () => {
  it('should be satisfied only by layout-ready', () => {
    expect(checkLayoutReady('layout-ready')).toBe(true);
    expect(checkLayoutReady('workspace-not-ready')).toBe(false);
    expect(checkLayoutReady('no-webview')).toBe(false);
  });
});

describe('buildStartupTimeoutMessage', () => {
  it('should name the phase, the budget and the elapsed time', () => {
    const message = buildStartupTimeoutMessage(BASE_MESSAGE_PARAMS);

    expect(message).toContain('Obsidian layout did not become ready within 90000ms');
    expect(message).toContain('elapsed 90123ms');
  });

  it('should name the furthest milestone reached', () => {
    const message = buildStartupTimeoutMessage(BASE_MESSAGE_PARAMS);

    expect(message).toContain('the WebView answered, but `globalThis.app` never appeared');
  });

  it('should report the probe count and slowest round-trip', () => {
    const message = buildStartupTimeoutMessage(BASE_MESSAGE_PARAMS);

    expect(message).toContain('Probed 3 time(s), slowest round-trip 41000ms');
  });

  it('should use the app-start wording for the app-start phase', () => {
    const message = buildStartupTimeoutMessage({
      ...BASE_MESSAGE_PARAMS,
      milestone: 'no-webview',
      phase: 'app-start'
    });

    expect(message).toContain('Obsidian Mobile did not finish starting');
    expect(message).toContain('the WebView never answered a single probe');
  });

  it('should describe the remaining milestones', () => {
    expect(buildStartupTimeoutMessage({ ...BASE_MESSAGE_PARAMS, milestone: 'no-workspace' }))
      .toContain('`globalThis.app` appeared, but `app.workspace` never did');
    expect(buildStartupTimeoutMessage({ ...BASE_MESSAGE_PARAMS, milestone: 'workspace-not-ready' }))
      .toContain('`app.workspace` exists, but `layoutReady` never became true');
    expect(buildStartupTimeoutMessage({ ...BASE_MESSAGE_PARAMS, milestone: 'layout-ready' }))
      .toContain('the workspace finished laying out');
  });

  it('should point at the contended-guest reading rather than only at the budget', () => {
    const message = buildStartupTimeoutMessage(BASE_MESSAGE_PARAMS);

    expect(message).toContain('deviceIdleTimeoutInMilliseconds');
  });
});
