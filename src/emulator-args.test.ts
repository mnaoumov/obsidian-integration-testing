import {
  describe,
  expect,
  it
} from 'vitest';

import { buildEmulatorArgs } from './emulator-args.ts';

describe('buildEmulatorArgs', () => {
  it('should include the AVD name', () => {
    const args = buildEmulatorArgs('Pixel_6_API_33');
    expect(args).toContain('Pixel_6_API_33');
    expect(args[args.indexOf('-avd') + 1]).toBe('Pixel_6_API_33');
  });

  it('should disable snapshot saving', () => {
    const args = buildEmulatorArgs('test-avd');
    expect(args).toContain('-no-snapshot-save');
  });

  it('should configure DNS server for network access', () => {
    const args = buildEmulatorArgs('test-avd');
    expect(args).toContain('-dns-server');
    expect(args[args.indexOf('-dns-server') + 1]).toBe('8.8.8.8');
  });

  it('should return args in correct order', () => {
    const args = buildEmulatorArgs('MyDevice');
    expect(args).toStrictEqual(['-avd', 'MyDevice', '-no-snapshot-save', '-dns-server', '8.8.8.8']);
  });
});
