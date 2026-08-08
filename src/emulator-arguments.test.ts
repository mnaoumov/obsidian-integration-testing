import {
  describe,
  expect,
  it
} from 'vitest';

import { buildEmulatorArguments } from './emulator-arguments.ts';

describe('buildEmulatorArguments', () => {
  it('should include the AVD name', () => {
    const input = buildEmulatorArguments({ avdName: 'Pixel_6_API_33', isHidden: true });
    expect(input).toContain('Pixel_6_API_33');
    expect(input[input.indexOf('-avd') + 1]).toBe('Pixel_6_API_33');
  });

  it('should disable snapshot saving', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true });
    expect(input).toContain('-no-snapshot-save');
  });

  it('should configure DNS server for network access', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true });
    expect(input).toContain('-dns-server');
    expect(input[input.indexOf('-dns-server') + 1]).toBe('8.8.8.8');
  });

  it('should run headless (-no-window) when hidden', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true });
    expect(input).toContain('-no-window');
  });

  it('should not pass -no-window when the emulator is visible', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: false });
    expect(input).not.toContain('-no-window');
  });

  it('should return hidden input in correct order', () => {
    const input = buildEmulatorArguments({ avdName: 'MyDevice', isHidden: true });
    expect(input).toStrictEqual(['-avd', 'MyDevice', '-no-snapshot-save', '-dns-server', '8.8.8.8', '-no-window']);
  });

  it('should return visible input in correct order', () => {
    const input = buildEmulatorArguments({ avdName: 'MyDevice', isHidden: false });
    expect(input).toStrictEqual(['-avd', 'MyDevice', '-no-snapshot-save', '-dns-server', '8.8.8.8']);
  });
});
