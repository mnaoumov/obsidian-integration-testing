import {
  describe,
  expect,
  it
} from 'vitest';

import { buildEmulatorArguments } from './emulator-arguments.ts';

describe('buildEmulatorArguments', () => {
  it('should include the AVD name', () => {
    const input = buildEmulatorArguments({ avdName: 'Pixel_6_API_33', isHidden: true, shouldReuseSnapshot: false });
    expect(input).toContain('Pixel_6_API_33');
    expect(input[input.indexOf('-avd') + 1]).toBe('Pixel_6_API_33');
  });

  it('should cold-boot by default, neither loading nor saving a snapshot', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true, shouldReuseSnapshot: false });
    expect(input).toContain('-no-snapshot-load');
    expect(input).toContain('-no-snapshot-save');
  });

  it('should load and save when snapshot reuse is opted into', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true, shouldReuseSnapshot: true });
    expect(input).not.toContain('-no-snapshot-load');
    expect(input).not.toContain('-no-snapshot-save');
  });

  /*
   * The regression this file's header exists for: loading a snapshot this
   * harness never writes is the one combination that is never correct.
   */
  it('should never suppress the save without also suppressing the load', () => {
    for (const shouldReuseSnapshot of [false, true]) {
      const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true, shouldReuseSnapshot });
      expect(input.includes('-no-snapshot-save')).toBe(input.includes('-no-snapshot-load'));
    }
  });

  it('should configure DNS server for network access', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true, shouldReuseSnapshot: false });
    expect(input).toContain('-dns-server');
    expect(input[input.indexOf('-dns-server') + 1]).toBe('8.8.8.8');
  });

  it('should run headless (-no-window) when hidden', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true, shouldReuseSnapshot: false });
    expect(input).toContain('-no-window');
  });

  it('should not pass -no-window when the emulator is visible', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: false, shouldReuseSnapshot: false });
    expect(input).not.toContain('-no-window');
  });

  it('should return hidden input in correct order', () => {
    const input = buildEmulatorArguments({ avdName: 'MyDevice', isHidden: true, shouldReuseSnapshot: false });
    expect(input).toStrictEqual(['-avd', 'MyDevice', '-no-snapshot-load', '-no-snapshot-save', '-dns-server', '8.8.8.8', '-no-window']);
  });

  it('should return visible input in correct order', () => {
    const input = buildEmulatorArguments({ avdName: 'MyDevice', isHidden: false, shouldReuseSnapshot: false });
    expect(input).toStrictEqual(['-avd', 'MyDevice', '-no-snapshot-load', '-no-snapshot-save', '-dns-server', '8.8.8.8']);
  });

  it('should return snapshot-reusing input in correct order', () => {
    const input = buildEmulatorArguments({ avdName: 'MyDevice', isHidden: true, shouldReuseSnapshot: true });
    expect(input).toStrictEqual(['-avd', 'MyDevice', '-dns-server', '8.8.8.8', '-no-window']);
  });
});
