import {
  describe,
  expect,
  it
} from 'vitest';

import type {
  ResolveWedgedAppiumServerRemedyParams,
  WedgedAppiumServerReportReason
} from './wedged-appium-server.ts';

import {
  buildWedgedAppiumServerMessage,
  checkIsAppiumDeviceNotFoundError,
  checkIsAppiumStatusReady,
  resolveWedgedAppiumServerRemedy
} from './wedged-appium-server.ts';

const APPIUM_ORIGIN = 'http://localhost:4723';
const DEVICE_ID = 'emulator-5554';
const DEVICE_NOT_FOUND_ERROR = new Error('Could not find a connected Android device in 20000ms');

function makeMessage(reason: WedgedAppiumServerReportReason, serverPid?: number, serverAgeInMilliseconds?: number): string {
  return buildWedgedAppiumServerMessage({
    appiumOrigin: APPIUM_ORIGIN,
    deviceId: DEVICE_ID,
    reason,
    ...(serverAgeInMilliseconds !== undefined && { serverAgeInMilliseconds }),
    ...(serverPid !== undefined && { serverPid })
  });
}

function makeRemedyParams(overrides?: Partial<ResolveWedgedAppiumServerRemedyParams>): ResolveWedgedAppiumServerRemedyParams {
  return {
    connectedDeviceIds: [DEVICE_ID],
    deviceId: DEVICE_ID,
    error: DEVICE_NOT_FOUND_ERROR,
    isAdoptedServer: true,
    isAutoStartAllowed: true,
    isHarnessOwnedServer: true,
    ...overrides
  };
}

describe('checkIsAppiumDeviceNotFoundError', () => {
  it('should recognize the appium-adb device-enumeration failure', () => {
    expect(checkIsAppiumDeviceNotFoundError(DEVICE_NOT_FOUND_ERROR)).toBe(true);
  });

  it('should recognize it through a wrapping cause chain', () => {
    expect(checkIsAppiumDeviceNotFoundError(new Error('Failed to create session', { cause: DEVICE_NOT_FOUND_ERROR }))).toBe(true);
  });

  it('should not match an unrelated error', () => {
    expect(checkIsAppiumDeviceNotFoundError(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('should tolerate a non-error value', () => {
    expect(checkIsAppiumDeviceNotFoundError('Could not find a connected Android device in 20000ms')).toBe(true);
    expect(checkIsAppiumDeviceNotFoundError(undefined)).toBe(false);
  });
});

describe('checkIsAppiumStatusReady', () => {
  it('should accept a ready server', () => {
    expect(checkIsAppiumStatusReady(JSON.stringify({ value: { build: { version: '3.5.2' }, ready: true } }))).toBe(true);
  });

  it('should reject a server that reports itself shutting down', () => {
    expect(checkIsAppiumStatusReady(JSON.stringify({ value: { message: 'The server is shutting down', ready: false } }))).toBe(false);
  });

  it('should read an unwrapped ready flag', () => {
    expect(checkIsAppiumStatusReady(JSON.stringify({ ready: false }))).toBe(false);
    expect(checkIsAppiumStatusReady(JSON.stringify({ ready: true }))).toBe(true);
  });

  it('should treat an omitted flag as ready', () => {
    expect(checkIsAppiumStatusReady(JSON.stringify({ value: { build: { version: '3.5.2' } } }))).toBe(true);
  });

  it('should treat a non-boolean flag as ready', () => {
    expect(checkIsAppiumStatusReady(JSON.stringify({ value: { ready: 'yes' } }))).toBe(true);
  });

  it('should treat a malformed or non-object body as ready', () => {
    expect(checkIsAppiumStatusReady('<html>Not Appium</html>')).toBe(true);
    expect(checkIsAppiumStatusReady('null')).toBe(true);
    expect(checkIsAppiumStatusReady('"ready"')).toBe(true);
  });
});

describe('resolveWedgedAppiumServerRemedy', () => {
  it('should leave an unrelated error alone', () => {
    expect(resolveWedgedAppiumServerRemedy(makeRemedyParams({ error: new Error('ECONNREFUSED') })))
      .toEqual({ reason: 'other-error', remedy: 'not-wedged' });
  });

  it('should leave the error alone when the host cannot see the device either', () => {
    expect(resolveWedgedAppiumServerRemedy(makeRemedyParams({ connectedDeviceIds: [] })))
      .toEqual({ reason: 'device-absent', remedy: 'not-wedged' });
  });

  it('should only report when this run started the server itself', () => {
    expect(resolveWedgedAppiumServerRemedy(makeRemedyParams({ isAdoptedServer: false })))
      .toEqual({ reason: 'freshly-started', remedy: 'report' });
  });

  it('should only report when auto-start is disabled', () => {
    expect(resolveWedgedAppiumServerRemedy(makeRemedyParams({ isAutoStartAllowed: false })))
      .toEqual({ reason: 'auto-start-disabled', remedy: 'report' });
  });

  it('should only report a server this harness did not start', () => {
    expect(resolveWedgedAppiumServerRemedy(makeRemedyParams({ isHarnessOwnedServer: false })))
      .toEqual({ reason: 'foreign-server', remedy: 'report' });
  });

  it('should restart an adopted server an earlier run started', () => {
    expect(resolveWedgedAppiumServerRemedy(makeRemedyParams()))
      .toEqual({ reason: 'harness-owned', remedy: 'restart' });
  });
});

describe('buildWedgedAppiumServerMessage', () => {
  it('should name the server and the device, and warn that adb will mislead', () => {
    const message = makeMessage('foreign-server');
    expect(message).toContain(`The Appium server at ${APPIUM_ORIGIN} cannot see Android device ${DEVICE_ID}`);
    expect(message).toContain('`adb devices` will list the device and mislead you');
  });

  it('should give reason-specific advice', () => {
    expect(makeMessage('foreign-server')).toContain('was not started by obsidian-integration-testing');
    expect(makeMessage('auto-start-disabled')).toContain('`shouldAutoStartAppium: false`');
    expect(makeMessage('freshly-started')).toContain('restarting it would change nothing');
    expect(makeMessage('restart-did-not-help')).toContain('a fresh one still could not serve this run');
  });

  it('should omit provenance when the server PID is unknown', () => {
    expect(makeMessage('foreign-server')).not.toContain('pid ');
  });

  it('should report the PID alone when the age is unknown', () => {
    const message = makeMessage('restart-did-not-help', 12_345);
    expect(message).toContain('(pid 12345)');
    expect(message).not.toContain('running for');
  });

  it('should report the age in seconds under a minute', () => {
    expect(makeMessage('restart-did-not-help', 12_345, 30_000)).toContain('(pid 12345, running for 30s)');
  });

  it('should report the age in minutes from a minute up', () => {
    expect(makeMessage('restart-did-not-help', 12_345, 3_780_000)).toContain('(pid 12345, running for 63min)');
  });
});
