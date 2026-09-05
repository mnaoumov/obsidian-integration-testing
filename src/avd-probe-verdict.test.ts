import {
  describe,
  expect,
  it
} from 'vitest';

import type {
  AvdProbeOutcome,
  AvdProbeResult
} from './avd-probe-verdict.ts';

import {
  buildAvdProbeSummary,
  buildUnreadableDevicesMessage,
  checkIsEmulatorDeviceId,
  classifyAvdProbe,
  resolveAvdProbeVerdict
} from './avd-probe-verdict.ts';
import { castTo } from './type-guards.ts';

const AVD_NAME = 'obsidian_test';
const PROBE_TIMEOUT_IN_MILLISECONDS = 5000;

describe('checkIsEmulatorDeviceId', () => {
  it('should accept a locally started emulator', () => {
    expect(checkIsEmulatorDeviceId('emulator-5554')).toBe(true);
  });

  it('should reject a physical handset serial', () => {
    expect(checkIsEmulatorDeviceId('R58M1234ABC')).toBe(false);
  });

  it('should reject a TCP-attached device, whose console cannot be asked', () => {
    expect(checkIsEmulatorDeviceId('192.168.1.10:5555')).toBe(false);
  });

  it('should reject a non-numeric console port', () => {
    expect(checkIsEmulatorDeviceId('emulator-abc')).toBe(false);
  });
});

describe('classifyAvdProbe', () => {
  it('should report a match when the device answered the wanted AVD', () => {
    expect(classifyAvdProbe({ avdName: AVD_NAME, deviceId: 'emulator-5554', probedAvdName: AVD_NAME })).toBe('match');
  });

  it('should report another AVD when the device answered a different name', () => {
    expect(classifyAvdProbe({ avdName: AVD_NAME, deviceId: 'emulator-5554', probedAvdName: 'obsidian_screenshots' })).toBe('other-avd');
  });

  it('should report no answer when the probe did not answer', () => {
    expect(classifyAvdProbe({ avdName: AVD_NAME, deviceId: 'emulator-5554', probedAvdName: undefined })).toBe('no-answer');
  });

  it('should report no answer for an empty answer, which reads nothing back', () => {
    expect(classifyAvdProbe({ avdName: AVD_NAME, deviceId: 'emulator-5554', probedAvdName: '' })).toBe('no-answer');
  });

  it('should never probe a non-emulator, whose console cannot answer however healthy it is', () => {
    expect(classifyAvdProbe({ avdName: AVD_NAME, deviceId: 'R58M1234ABC', probedAvdName: undefined })).toBe('not-an-emulator');
  });
});

describe('resolveAvdProbeVerdict', () => {
  it('should start a new emulator when nothing is connected', () => {
    expect(resolveAvdProbeVerdict([])).toStrictEqual({ verdict: 'start-new' });
  });

  it('should reuse the device serving the wanted AVD', () => {
    const results: AvdProbeResult[] = [
      { deviceId: 'emulator-5554', outcome: 'other-avd' },
      { deviceId: 'emulator-5556', outcome: 'match' }
    ];

    expect(resolveAvdProbeVerdict(results)).toStrictEqual({ deviceId: 'emulator-5556', verdict: 'reuse' });
  });

  it('should start a new emulator when every device answered a different AVD', () => {
    const results: AvdProbeResult[] = [
      { deviceId: 'emulator-5554', outcome: 'other-avd' },
      { deviceId: 'R58M1234ABC', outcome: 'not-an-emulator' }
    ];

    expect(resolveAvdProbeVerdict(results)).toStrictEqual({ verdict: 'start-new' });
  });

  it('should refuse rather than launch beside a device that did not answer', () => {
    const results: AvdProbeResult[] = [
      { deviceId: 'emulator-5554', outcome: 'no-answer' },
      { deviceId: 'emulator-5556', outcome: 'other-avd' }
    ];

    expect(resolveAvdProbeVerdict(results)).toStrictEqual({ unreadableDeviceIds: ['emulator-5554'], verdict: 'refuse' });
  });

  it('should collect every unreadable device, so the refusal names them all', () => {
    const results: AvdProbeResult[] = [
      { deviceId: 'emulator-5554', outcome: 'no-answer' },
      { deviceId: 'emulator-5556', outcome: 'no-answer' }
    ];

    expect(resolveAvdProbeVerdict(results)).toStrictEqual({
      unreadableDeviceIds: ['emulator-5554', 'emulator-5556'],
      verdict: 'refuse'
    });
  });

  /*
   * The precedence that keeps an unrelated wedged AVD from blocking a run that
   * has already found everything it needs.
   */
  it('should reuse a match even when a sibling device did not answer', () => {
    const results: AvdProbeResult[] = [
      { deviceId: 'emulator-5554', outcome: 'no-answer' },
      { deviceId: 'emulator-5556', outcome: 'match' }
    ];

    expect(resolveAvdProbeVerdict(results)).toStrictEqual({ deviceId: 'emulator-5556', verdict: 'reuse' });
  });

  it('should throw rather than guess at an outcome it does not recognize', () => {
    const results: AvdProbeResult[] = [{ deviceId: 'emulator-5554', outcome: castTo<AvdProbeOutcome>('probably-fine') }];

    expect(() => resolveAvdProbeVerdict(results)).toThrow('Unhandled value: probably-fine');
  });
});

describe('buildAvdProbeSummary', () => {
  it('should say so when nothing was connected', () => {
    expect(buildAvdProbeSummary([])).toBe('no devices');
  });

  it('should name what each device answered', () => {
    const results: AvdProbeResult[] = [
      { deviceId: 'emulator-5554', outcome: 'no-answer' },
      { deviceId: 'emulator-5556', outcome: 'other-avd' }
    ];

    expect(buildAvdProbeSummary(results)).toBe('emulator-5554=no-answer, emulator-5556=other-avd');
  });
});

describe('buildUnreadableDevicesMessage', () => {
  it('should name the single device, the budget, the collision and the recovery', () => {
    const message = buildUnreadableDevicesMessage({
      avdName: AVD_NAME,
      probeTimeoutInMilliseconds: PROBE_TIMEOUT_IN_MILLISECONDS,
      unreadableDeviceIds: ['emulator-5554']
    });

    expect(message).toContain('AVD "obsidian_test"');
    expect(message).toContain('device emulator-5554 did not answer');
    expect(message).toContain('`adb -s emulator-5554 emu avd name`');
    expect(message).toContain('within 5000ms');
    expect(message).toContain('Running multiple emulators with the same AVD');
    expect(message).toContain('`adb kill-server`');
  });

  it('should pluralize for several devices, without naming a per-device command', () => {
    const message = buildUnreadableDevicesMessage({
      avdName: AVD_NAME,
      probeTimeoutInMilliseconds: PROBE_TIMEOUT_IN_MILLISECONDS,
      unreadableDeviceIds: ['emulator-5554', 'emulator-5556']
    });

    expect(message).toContain('devices emulator-5554, emulator-5556 did not answer');
    expect(message).toContain('`adb -s <device> emu avd name`');
    expect(message).toContain('Kill the unresponsive devices');
  });
});
