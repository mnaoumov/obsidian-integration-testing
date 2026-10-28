import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildEmulatorArguments,
  buildEmulatorEnvironment,
  NETSIM_LOG_FILTER
} from './emulator-arguments.ts';

describe('buildEmulatorEnvironment', () => {
  it('should hand netsimd the bounded log filter when the caller set none', () => {
    const result = buildEmulatorEnvironment({ PATH: '/usr/bin' });
    expect(result.environment).toStrictEqual({ PATH: '/usr/bin', RUST_LOG: NETSIM_LOG_FILTER });
    expect(result.isNetsimLogGuarded).toBe(true);
  });

  it('should treat an empty RUST_LOG as unset', () => {
    const result = buildEmulatorEnvironment({ RUST_LOG: '' });
    expect(result.environment['RUST_LOG']).toBe(NETSIM_LOG_FILTER);
    expect(result.isNetsimLogGuarded).toBe(true);
  });

  it('should leave an explicit RUST_LOG alone and report the guard as off', () => {
    const result = buildEmulatorEnvironment({ RUST_LOG: 'debug' });
    expect(result.environment['RUST_LOG']).toBe('debug');
    expect(result.isNetsimLogGuarded).toBe(false);
  });

  it('should never mutate the environment it extends', () => {
    const baseEnvironment: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    buildEmulatorEnvironment(baseEnvironment);
    expect(baseEnvironment).toStrictEqual({ PATH: '/usr/bin' });
  });
});

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

  it('should use native DNS discovery when no resolvers are supplied', () => {
    const input = buildEmulatorArguments({ avdName: 'test-avd', isHidden: true, shouldReuseSnapshot: false });
    expect(input).not.toContain('-dns-server');
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
    expect(input).toStrictEqual(['-cores', '4', '-avd', 'MyDevice', '-no-snapshot-load', '-no-snapshot-save', '-no-window']);
  });

  it('should return visible input in correct order', () => {
    const input = buildEmulatorArguments({ avdName: 'MyDevice', isHidden: false, shouldReuseSnapshot: false });
    expect(input).toStrictEqual(['-cores', '4', '-avd', 'MyDevice', '-no-snapshot-load', '-no-snapshot-save']);
  });

  it('should return snapshot-reusing input in correct order', () => {
    const input = buildEmulatorArguments({ avdName: 'MyDevice', isHidden: true, shouldReuseSnapshot: true });
    expect(input).toStrictEqual(['-cores', '4', '-avd', 'MyDevice', '-no-window']);
  });
});

describe('emulator CPU budget', () => {
  it.each([
    [undefined, undefined, 4],
    [undefined, '2', 2],
    [8, '2', 2],
    [1, '2', 1],
    [2, undefined, 2],
    [undefined, '8', 4]
  ])('should resolve requested %s and budget %s to %s cores', (cpuCount, bulkCores, expected) => {
    const input = buildEmulatorArguments({ avdName: 'test', bulkCores, cpuCount, isHidden: true, shouldReuseSnapshot: false });
    expect(input[input.indexOf('-cores') + 1]).toBe(String(expected));
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '2junk', '9007199254740992'])('should reject invalid budget %s', (bulkCores) => {
    expect(() => buildEmulatorArguments({ avdName: 'test', bulkCores, isHidden: true, shouldReuseSnapshot: false })).toThrow('BULK_CORES');
  });

  it.each([0, -1, 1.5, NaN, Infinity, 9_007_199_254_740_992])('should reject invalid requested count %s', (cpuCount) => {
    expect(() => buildEmulatorArguments({ avdName: 'test', cpuCount, isHidden: true, shouldReuseSnapshot: false })).toThrow('emulatorCpuCount');
  });
});

describe('emulator DNS selection', () => {
  it('should use multiple host resolvers as one argument', () => {
    const input = buildEmulatorArguments({ avdName: 'test', hostDnsServers: ['192.0.2.1', '192.0.2.2'], isHidden: true, shouldReuseSnapshot: false });
    expect(input[input.indexOf('-dns-server') + 1]).toBe('192.0.2.1,192.0.2.2');
  });

  it('should prefer an explicit override to host resolvers', () => {
    const input = buildEmulatorArguments({ avdName: 'test', dnsServers: ['192.0.2.3'], hostDnsServers: ['192.0.2.1'], isHidden: true, shouldReuseSnapshot: false });
    expect(input[input.indexOf('-dns-server') + 1]).toBe('192.0.2.3');
  });

  it('should leave DNS discovery to the emulator when the host list is empty', () => {
    const input = buildEmulatorArguments({ avdName: 'test', hostDnsServers: [], isHidden: true, shouldReuseSnapshot: false });
    expect(input).not.toContain('-dns-server');
  });

  it('should allow an empty override to request native emulator discovery', () => {
    const input = buildEmulatorArguments({ avdName: 'test', dnsServers: [], hostDnsServers: ['192.0.2.1'], isHidden: true, shouldReuseSnapshot: false });
    expect(input).not.toContain('-dns-server');
  });
});
