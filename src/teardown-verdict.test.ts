import {
  describe,
  expect,
  it
} from 'vitest';

import type { TeardownOutcome } from './teardown-verdict.ts';

import {
  buildTeardownMessage,
  resolveTeardownOutcome
} from './teardown-verdict.ts';
import { castTo } from './type-guards.ts';

const APPIUM_EVIDENCE = 'port 4723';
const APPIUM_SUBJECT = 'Auto-started Appium server';
const TIMEOUT_IN_MILLISECONDS = 15_000;

describe('resolveTeardownOutcome', () => {
  it('should report a process that exited on the first kill as stopped', () => {
    expect(resolveTeardownOutcome({ hasEscalated: false, isStopped: true })).toBe('stopped');
  });

  it('should distinguish a process that only exited after escalation', () => {
    expect(resolveTeardownOutcome({ hasEscalated: true, isStopped: true })).toBe('stopped-after-escalation');
  });

  it('should report a process that outlived the first kill as still running', () => {
    expect(resolveTeardownOutcome({ hasEscalated: false, isStopped: false })).toBe('still-running');
  });

  it('should report a process that outlived the escalation as still running', () => {
    expect(resolveTeardownOutcome({ hasEscalated: true, isStopped: false })).toBe('still-running');
  });
});

describe('buildTeardownMessage', () => {
  /*
   * The defect this module exists for: the old teardown printed `stopped.` on
   * the *attempt*. Only this branch may claim a stop, and it says what proved it.
   */
  it('should name the evidence when claiming a verified stop', () => {
    expect(buildTeardownMessage({
      evidence: APPIUM_EVIDENCE,
      outcome: 'stopped',
      subject: APPIUM_SUBJECT,
      timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
    })).toBe('Auto-started Appium server stopped (verified: port 4723 released).');
  });

  it('should record that a stop needed escalating', () => {
    expect(buildTeardownMessage({
      evidence: APPIUM_EVIDENCE,
      outcome: 'stopped-after-escalation',
      subject: APPIUM_SUBJECT,
      timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
    })).toBe('Auto-started Appium server stopped after escalation (verified: port 4723 released).');
  });

  it('should warn that a later run may adopt a survivor, naming the budget and the evidence', () => {
    expect(buildTeardownMessage({
      evidence: APPIUM_EVIDENCE,
      outcome: 'still-running',
      subject: APPIUM_SUBJECT,
      timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
    })).toBe(
      'WARNING: Auto-started Appium server did not exit within 15000ms and still holds port 4723; a later run may adopt it. Kill it before the next Android run.'
    );
  });

  it('should throw rather than invent a line for an outcome it does not recognize', () => {
    expect(() =>
      buildTeardownMessage({
        evidence: APPIUM_EVIDENCE,
        outcome: castTo<TeardownOutcome>('probably-fine'),
        subject: APPIUM_SUBJECT,
        timeoutInMilliseconds: TIMEOUT_IN_MILLISECONDS
      })
    ).toThrow('Unhandled value: probably-fine');
  });

  it('should carry the emulator\'s own subject and evidence', () => {
    expect(buildTeardownMessage({
      evidence: 'AVD "obsidian_test" on device emulator-5554',
      outcome: 'still-running',
      subject: 'Auto-started emulator',
      timeoutInMilliseconds: 20_000
    })).toBe(
      'WARNING: Auto-started emulator did not exit within 20000ms and still holds AVD "obsidian_test" on device emulator-5554; a later run may adopt it. Kill it before the next Android run.'
    );
  });
});
