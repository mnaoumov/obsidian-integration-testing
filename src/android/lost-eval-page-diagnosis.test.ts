import {
  describe,
  expect,
  it
} from 'vitest';

import type { LostEvalPageState } from './lost-eval-page-diagnosis.ts';

import {
  describeLostEvalPage,
  LOST_EVAL_PAGE_STATE_PROBE_EXPRESSION,
  parseLostEvalPageState,
  selectPageReplacementLogLines
} from './lost-eval-page-diagnosis.ts';

const PAGE_STATE: LostEvalPageState = {
  hasNamespace: false,
  href: 'http://localhost/',
  isLayoutReady: false,
  pageAgeInMilliseconds: 800,
  readyState: 'complete'
};

describe('LOST_EVAL_PAGE_STATE_PROBE_EXPRESSION', () => {
  it('should read the page state it is parsed back into', () => {
    const fakeWindow = { __obsidianIntegrationTesting: {}, app: { workspace: { layoutReady: true } } };
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- Runs the probe against stubbed page globals.
    const probe = new Function('window', 'location', 'performance', 'document', `return ${LOST_EVAL_PAGE_STATE_PROBE_EXPRESSION};`) as (
      ...arguments_: unknown[]
    ) => string;
    const raw = probe(fakeWindow, { href: 'http://localhost/' }, { now: (): number => 1500.4 }, { readyState: 'complete' });

    expect(parseLostEvalPageState(raw)).toEqual({
      hasNamespace: true,
      href: 'http://localhost/',
      isLayoutReady: true,
      pageAgeInMilliseconds: 1500,
      readyState: 'complete'
    });
  });
});

describe('parseLostEvalPageState', () => {
  it.each([
    ['not JSON', 'nope'],
    ['a non-object', '42'],
    ['null', 'null'],
    ['a missing field', JSON.stringify({ hasNamespace: true })]
  ])('should return null for %s', (_description, raw) => {
    expect(parseLostEvalPageState(raw)).toBeNull();
  });
});

describe('selectPageReplacementLogLines', () => {
  it('should keep only lines naming a renderer or app process going away, newest last and at most eight', () => {
    const lines = [
      '11-12 03:59:43.100 I/chromium(1234): [INFO:CONSOLE] hello',
      '11-12 03:59:43.200 W/cr_AwContents(1234): onRenderProcessGone: crashed renderer',
      '11-12 03:59:43.300 I/ActivityManager( 500): Process md.obsidian (pid 1234) has died',
      ...Array.from({ length: 10 }, (_, index) => `11-12 03:59:44.${String(index)} I/lowmemorykiller( 99): Kill ${String(index)}`)
    ];

    const selected = selectPageReplacementLogLines(lines.join('\r\n'));

    expect(selected).toHaveLength(8);
    expect(selected.at(-1)).toContain('Kill 9');
    expect(selectPageReplacementLogLines(lines.slice(0, 3).join('\n'))).toEqual([lines[1], lines[2]]);
  });

  it('should keep the theme-overlay relaunch of Obsidian\'s activity and a SystemUI death, but not another app\'s relaunch', () => {
    // Captured from obsidian_test on 2026-11-12 (one guest core), shortened.
    const lines = [
      '11-12 05:47:09.289 I/ActivityManager(  633): Process com.android.systemui (pid 922) has died',
      '11-12 05:48:10.865 I/ActivityTaskManager(  633): Config changes=80000000 {1.0 310mcc260mnc [en_US]}',
      '11-12 05:48:10.968 V/AppCompatResourceOverlayPolicy(  633): doResourceOverlayChangesAffectActivity: result: true componentName: ComponentInfo{md.obsidian/md.obsidian.MainActivity} overlayPathsAdded: {}',
      '11-12 05:46:16.472 V/AppCompatResourceOverlayPolicy(  633): doResourceOverlayChangesAffectActivity: result: true componentName: ComponentInfo{com.android.settings/com.android.settings.Settings}'
    ];

    expect(selectPageReplacementLogLines(lines.join('\n'))).toEqual([lines[0], lines[2]]);
  });
});

describe('describeLostEvalPage', () => {
  it('should call a page younger than the eval a replacement, with its age and state', () => {
    const diagnosis = describeLostEvalPage({ logLines: [], pageState: PAGE_STATE, sinceEvalStartInMilliseconds: 2000 });

    expect(diagnosis).toContain('REPLACED');
    expect(diagnosis).toContain('loaded 800ms ago, 1200ms after the eval started');
    expect(diagnosis).toContain('harness namespace absent');
    expect(diagnosis).toContain('layout not ready');
    expect(diagnosis).toContain('names no renderer or app process going away');
  });

  it('should say the result was lost in the driver when the same page is still loaded', () => {
    const diagnosis = describeLostEvalPage({
      logLines: [],
      pageState: { ...PAGE_STATE, hasNamespace: true, isLayoutReady: true, pageAgeInMilliseconds: 90_000 },
      sinceEvalStartInMilliseconds: 2000
    });

    expect(diagnosis).toContain('still loaded');
    expect(diagnosis).toContain('layout ready');
    expect(diagnosis).toContain('harness namespace present');
  });

  it('should say an older page without the namespace is not the one the closure ran in', () => {
    const diagnosis = describeLostEvalPage({
      logLines: [],
      pageState: { ...PAGE_STATE, pageAgeInMilliseconds: 90_000 },
      sinceEvalStartInMilliseconds: 2000
    });

    expect(diagnosis).toContain('not the page the closure ran in');
  });

  it('should report a failed probe and quote the device log', () => {
    const withError = describeLostEvalPage({
      logLines: ['W/cr_AwContents: onRenderProcessGone'],
      pageState: null,
      probeError: 'no such window',
      sinceEvalStartInMilliseconds: 2000
    });

    expect(withError).toContain('could not be asked what page it shows now: no such window.');
    expect(withError).toContain('The device log says:\n  W/cr_AwContents: onRenderProcessGone');

    expect(describeLostEvalPage({ logLines: [], pageState: null, sinceEvalStartInMilliseconds: 1 })).toContain('shows now.');
  });
});
