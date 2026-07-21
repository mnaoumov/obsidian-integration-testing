import {
  describe,
  expect,
  it
} from 'vitest';

import { buildProcessExitMessage } from './process-exit-message.ts';

describe('buildProcessExitMessage', () => {
  it('should describe a premature exit with a code', () => {
    expect(
      buildProcessExitMessage({
        exitInfo: { code: 1, signal: null },
        output: '',
        outputLabel: 'Appium server output',
        subject: 'Auto-started Appium server'
      })
    ).toBe('Auto-started Appium server exited prematurely with code 1 during startup.');
  });

  it('should describe a signal termination', () => {
    expect(
      buildProcessExitMessage({
        exitInfo: { code: null, signal: 'SIGKILL' },
        output: '',
        outputLabel: 'Emulator output',
        subject: 'Android emulator'
      })
    ).toBe('Android emulator was terminated by signal SIGKILL during startup.');
  });

  it('should describe a spawn failure', () => {
    expect(
      buildProcessExitMessage({
        exitInfo: { code: null, signal: null, spawnError: 'spawn emulator ENOENT' },
        output: '',
        outputLabel: 'Emulator output',
        subject: 'Android emulator'
      })
    ).toBe('Android emulator failed to start (spawn emulator ENOENT) during startup.');
  });

  it('should render a null code as (null)', () => {
    expect(
      buildProcessExitMessage({
        exitInfo: { code: null, signal: null },
        output: '',
        outputLabel: 'Appium server output',
        subject: 'Auto-started Appium server'
      })
    ).toBe('Auto-started Appium server exited prematurely with code (null) during startup.');
  });

  it('should append the trimmed output tail under the given label', () => {
    expect(
      buildProcessExitMessage({
        exitInfo: { code: 1, signal: null },
        output: '\n  Error: could not find driver uiautomator2  \n',
        outputLabel: 'Appium server output',
        subject: 'Auto-started Appium server'
      })
    ).toBe(
      'Auto-started Appium server exited prematurely with code 1 during startup.\n\n'
        + 'Appium server output (tail):\nError: could not find driver uiautomator2'
    );
  });

  it('should omit the output section when the output is blank', () => {
    expect(
      buildProcessExitMessage({
        exitInfo: { code: 1, signal: null },
        output: '   \n  ',
        outputLabel: 'Emulator output',
        subject: 'Android emulator'
      })
    ).toBe('Android emulator exited prematurely with code 1 during startup.');
  });
});
