import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildAppiumNotReadyMessage,
  resolveAppiumStartupDeadline,
  resolveAppiumStartupPhase
} from './appium-startup-progress.ts';

const NPM_NOTICES = 'npm notice run advanced-metadata-cache@2.3.0 npx\nnpm notice run appium --log-timestamp --port 4723\n';
const DRIVER_LOAD_OUTPUT = `${NPM_NOTICES}2026-10-29 10:21:06:876 - [Appium] Welcome to Appium v3.7.0\n2026-10-29 10:21:06:880 - [Appium] Requiring driver at C:\\Users\\me\\.appium\\node_modules\\appium-uiautomator2-driver\\build\\lib\\index.js\n`;

describe('resolveAppiumStartupPhase', () => {
  it('should read output with no Appium line as launching', () => {
    expect(resolveAppiumStartupPhase('')).toBe('launching');
    expect(resolveAppiumStartupPhase(NPM_NOTICES)).toBe('launching');
  });

  it('should read output carrying an Appium line as loading the driver', () => {
    expect(resolveAppiumStartupPhase(DRIVER_LOAD_OUTPUT)).toBe('loading-driver');
  });
});

describe('resolveAppiumStartupDeadline', () => {
  it('should count the launch budget from the spawn until Appium prints', () => {
    expect(resolveAppiumStartupDeadline({
      appiumOutputSeenAtInMilliseconds: undefined,
      driverLoadTimeoutInMilliseconds: 600_000,
      launchedAtInMilliseconds: 1000,
      startTimeoutInMilliseconds: 180_000
    })).toBe(181_000);
  });

  it('should count the driver-load budget from Appium\'s first line', () => {
    expect(resolveAppiumStartupDeadline({
      appiumOutputSeenAtInMilliseconds: 6000,
      driverLoadTimeoutInMilliseconds: 600_000,
      launchedAtInMilliseconds: 1000,
      startTimeoutInMilliseconds: 180_000
    })).toBe(606_000);
  });
});

describe('buildAppiumNotReadyMessage', () => {
  it('should blame npm when only npm notices were printed', () => {
    const message = buildAppiumNotReadyMessage({
      driverLoadElapsedInMilliseconds: undefined,
      driverLoadTimeoutInMilliseconds: 600_000,
      outputTail: NPM_NOTICES,
      phase: 'launching',
      startTimeoutInMilliseconds: 180_000
    });
    expect(message).toContain('did not become ready within 180000ms (`appiumStartTimeoutInMilliseconds`).');
    expect(message).toContain('npx was still resolving the command');
    expect(message).toContain('Appium server output (tail):\nnpm notice run');
  });

  it('should say nothing about npm when there was no output at all', () => {
    const message = buildAppiumNotReadyMessage({
      driverLoadElapsedInMilliseconds: undefined,
      driverLoadTimeoutInMilliseconds: 600_000,
      outputTail: '  \n',
      phase: 'launching',
      startTimeoutInMilliseconds: 180_000
    });
    expect(message).toBe('Auto-started Appium server did not become ready within 180000ms (`appiumStartTimeoutInMilliseconds`).');
  });

  it('should name the driver load and its budget once Appium was running', () => {
    const message = buildAppiumNotReadyMessage({
      driverLoadElapsedInMilliseconds: 600_412,
      driverLoadTimeoutInMilliseconds: 600_000,
      outputTail: DRIVER_LOAD_OUTPUT,
      phase: 'loading-driver',
      startTimeoutInMilliseconds: 180_000
    });
    expect(message).toContain('still loading its drivers 600412ms after it printed its first line');
    expect(message).toContain('`appiumDriverLoadTimeoutInMilliseconds`');
    expect(message).not.toContain('npx was still resolving');
    expect(message).toContain('[Appium] Requiring driver');
  });

  it('should fall back to the budget when the elapsed time is unknown', () => {
    expect(buildAppiumNotReadyMessage({
      driverLoadElapsedInMilliseconds: undefined,
      driverLoadTimeoutInMilliseconds: 600_000,
      outputTail: '',
      phase: 'loading-driver',
      startTimeoutInMilliseconds: 180_000
    })).toContain('still loading its drivers 600000ms after');
  });
});
