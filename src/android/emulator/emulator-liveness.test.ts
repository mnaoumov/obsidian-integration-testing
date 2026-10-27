import {
  describe,
  expect,
  it
} from 'vitest';

import type { ResolveEmulatorLivenessVerdictParams } from './emulator-liveness.ts';

import {
  buildEmulatorLivenessMessage,
  resolveEmulatorLivenessVerdict
} from './emulator-liveness.ts';

const EMULATOR_DEVICE_ID = 'emulator-5554';
const HANDSET_DEVICE_ID = '3C15BN001Y900000';
const PROBE_TIMEOUT_IN_MILLISECONDS = 15_000;

function resolve(overrides: Partial<ResolveEmulatorLivenessVerdictParams>): ReturnType<typeof resolveEmulatorLivenessVerdict> {
  return resolveEmulatorLivenessVerdict({
    consoleProbe: 'answered',
    deviceId: EMULATOR_DEVICE_ID,
    isListedByAdb: true,
    shellProbe: 'answered',
    ...overrides
  });
}

describe('resolveEmulatorLivenessVerdict', () => {
  it('should report alive when the guest answers', () => {
    expect(resolve({ shellProbe: 'answered' })).toBe('alive');
  });

  /*
   * A guest that answers settles it without consulting the console, so a healthy
   * run never pays for the second probe — and a console that happens to be
   * unreachable cannot fail a device that is demonstrably working.
   */
  it('should report alive on a working guest even when the console is silent', () => {
    expect(resolve({ consoleProbe: 'no-answer', shellProbe: 'answered' })).toBe('alive');
  });

  it('should report device-gone when adb no longer lists the device', () => {
    expect(resolve({ isListedByAdb: false, shellProbe: 'no-answer' })).toBe('device-gone');
  });

  /*
   * The measured signature: neither layer answers. See the file header for the
   * six hand-boots this classifies.
   */
  it('should convict the emulator when neither the guest nor the console answers', () => {
    expect(resolve({ consoleProbe: 'no-answer', shellProbe: 'no-answer' })).toBe('emulator-wedged');
  });

  it('should blame the guest when the console still answers', () => {
    expect(resolve({ consoleProbe: 'answered', shellProbe: 'no-answer' })).toBe('guest-unresponsive');
  });

  /*
   * The regression this module's probe-outcome doc exists for. An earlier draft
   * read a failed console probe as "the emulator answered, with an error" and
   * so reported `guest-unresponsive` for a device whose emulator then had to be
   * killed by PID. `adb ... emu` is routed by the adb server, which refuses an
   * `offline` device before the console is ever reached.
   */
  it('should convict the emulator when the console probe merely failed', () => {
    expect(resolve({ consoleProbe: 'no-answer', shellProbe: 'no-answer' })).not.toBe('guest-unresponsive');
  });

  /*
   * `adb … emu` errors against a physical handset however healthy it is, so its
   * silence there is not evidence — the same restraint `classifyAvdProbe` shows.
   */
  it('should never convict a non-emulator device on a silent console', () => {
    expect(resolve({ consoleProbe: 'no-answer', deviceId: HANDSET_DEVICE_ID, shellProbe: 'no-answer' })).toBe('guest-unresponsive');
  });
});

describe('buildEmulatorLivenessMessage', () => {
  it('should name the emulator, not the device, when the emulator is wedged', () => {
    const message = buildEmulatorLivenessMessage({
      deviceId: EMULATOR_DEVICE_ID,
      emulatorOutput: '',
      probeTimeoutInMilliseconds: PROBE_TIMEOUT_IN_MILLISECONDS,
      verdict: 'emulator-wedged'
    });

    expect(message).toContain('the EMULATOR is wedged');
    expect(message).toContain('15000ms');
    expect(message).toContain(EMULATOR_DEVICE_ID);
  });

  /*
   * The whole point: the reader must be told NOT to go and run `adb devices`,
   * because it lists the device and reads as a clean bill of health.
   */
  it('should warn that adb devices will mislead the reader', () => {
    const message = buildEmulatorLivenessMessage({
      deviceId: EMULATOR_DEVICE_ID,
      emulatorOutput: '',
      probeTimeoutInMilliseconds: PROBE_TIMEOUT_IN_MILLISECONDS,
      verdict: 'emulator-wedged'
    });

    expect(message).toContain('will still list this device and will mislead you');
  });

  it('should append the emulator output when there is any', () => {
    const message = buildEmulatorLivenessMessage({
      deviceId: EMULATOR_DEVICE_ID,
      emulatorOutput: 'ERROR | detected a hanging thread \'QEMU2 main loop\'',
      probeTimeoutInMilliseconds: PROBE_TIMEOUT_IN_MILLISECONDS,
      verdict: 'emulator-wedged'
    });

    expect(message).toContain('Emulator output');
    expect(message).toContain('hanging thread \'QEMU2 main loop\'');
  });

  it('should point at the idle budget when the guest is the unresponsive half', () => {
    const message = buildEmulatorLivenessMessage({
      deviceId: EMULATOR_DEVICE_ID,
      emulatorOutput: '',
      probeTimeoutInMilliseconds: PROBE_TIMEOUT_IN_MILLISECONDS,
      verdict: 'guest-unresponsive'
    });

    expect(message).toContain('emulator\'s own console did');
    expect(message).toContain('deviceIdleTimeoutInMilliseconds');
  });

  /*
   * The one host where this was chased to the end lost a week to the emulator
   * build, the system image and the hypervisor before anybody asked what was
   * filtering its sockets — which is what it turned out to be. Both recurring
   * verdicts must name that first, so the next reader spends the week on
   * something else.
   */
  it.each(['emulator-wedged', 'guest-unresponsive'] as const)('should send a recurring %s to the host\'s socket filters first', (verdict) => {
    const message = buildEmulatorLivenessMessage({
      deviceId: EMULATOR_DEVICE_ID,
      emulatorOutput: '',
      probeTimeoutInMilliseconds: PROBE_TIMEOUT_IN_MILLISECONDS,
      verdict
    });

    expect(message).toContain('filters this host\'s sockets');
    expect(message).toContain('VPN');
  });

  it('should say the device left when adb no longer lists it', () => {
    const message = buildEmulatorLivenessMessage({
      deviceId: EMULATOR_DEVICE_ID,
      emulatorOutput: '',
      probeTimeoutInMilliseconds: PROBE_TIMEOUT_IN_MILLISECONDS,
      verdict: 'device-gone'
    });

    expect(message).toContain('no longer lists it');
  });
});
