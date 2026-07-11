import {
  describe,
  expect,
  it
} from 'vitest';

import { buildEmulatorArgs } from './emulator-args.ts';

describe('buildEmulatorArgs', () => {
  it('should include the AVD name', () => {
    const args = buildEmulatorArgs({ avdName: 'Pixel_6_API_33', isHidden: true });
    expect(args).toContain('Pixel_6_API_33');
    expect(args[args.indexOf('-avd') + 1]).toBe('Pixel_6_API_33');
  });

  it('should disable snapshot saving', () => {
    const args = buildEmulatorArgs({ avdName: 'test-avd', isHidden: true });
    expect(args).toContain('-no-snapshot-save');
  });

  it('should configure DNS server for network access', () => {
    const args = buildEmulatorArgs({ avdName: 'test-avd', isHidden: true });
    expect(args).toContain('-dns-server');
    expect(args[args.indexOf('-dns-server') + 1]).toBe('8.8.8.8');
  });

  it('should run headless (-no-window) when hidden', () => {
    const args = buildEmulatorArgs({ avdName: 'test-avd', isHidden: true });
    expect(args).toContain('-no-window');
  });

  it('should not pass -no-window when the emulator is visible', () => {
    const args = buildEmulatorArgs({ avdName: 'test-avd', isHidden: false });
    expect(args).not.toContain('-no-window');
  });

  it('should return hidden args in correct order', () => {
    const args = buildEmulatorArgs({ avdName: 'MyDevice', isHidden: true });
    expect(args).toStrictEqual(['-avd', 'MyDevice', '-no-snapshot-save', '-dns-server', '8.8.8.8', '-no-window']);
  });

  it('should return visible args in correct order', () => {
    const args = buildEmulatorArgs({ avdName: 'MyDevice', isHidden: false });
    expect(args).toStrictEqual(['-avd', 'MyDevice', '-no-snapshot-save', '-dns-server', '8.8.8.8']);
  });
});
