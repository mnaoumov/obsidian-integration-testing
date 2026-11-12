import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianAndroidAppiumTransportOptions } from '../transport/transport-options.ts';
import type { SystemServerIdentity } from './framework-readiness.ts';

import {
  buildFrameworkNotReadyMessage,
  buildFrameworkProbeScript,
  checkIsSystemServerRestarted,
  DEFAULT_FRAMEWORK_READY_TIMEOUT_IN_MILLISECONDS,
  describeSystemServerIdentity,
  describeSystemServerRestart,
  FRAMEWORK_SERVICE_NAMES,
  parseFrameworkProbeOutput,
  resolveFrameworkProbeVerdict,
  resolveFrameworkReadyTimeoutInMilliseconds
} from './framework-readiness.ts';

const BASE_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

const ALL_FOUND = FRAMEWORK_SERVICE_NAMES.map((name) => `Service ${name}: found`).join('\n');
const COUNT_ONE: SystemServerIdentity = { count: 1, kind: 'start-count', uptime: '12345' };
const COUNT_TWO: SystemServerIdentity = { count: 2, kind: 'start-count', uptime: '98765' };
const PID_A: SystemServerIdentity = { kind: 'pid', pid: 512 };
const PID_B: SystemServerIdentity = { kind: 'pid', pid: 2048 };

describe('buildFrameworkProbeScript', () => {
  it('should read the identity and check every framework service in one script', () => {
    const script = buildFrameworkProbeScript();
    expect(script).toContain('getprop sys.system_server.start_count');
    expect(script).toContain('getprop sys.system_server.start_uptime');
    expect(script).toContain('pidof system_server');
    expect(script).toContain('for s in settings package activity input connectivity; do service check $s; done');
  });
});

describe('parseFrameworkProbeOutput', () => {
  it('should prefer the start count and list the found services', () => {
    const probe = parseFrameworkProbeOutput(`count=1\r\nuptime=12345\r\npid=512\r\n${ALL_FOUND}\r\n`);
    expect(probe).toEqual({ foundServices: [...FRAMEWORK_SERVICE_NAMES], identity: COUNT_ONE });
  });

  it('should fall back to the pid when the start count is not set', () => {
    const probe = parseFrameworkProbeOutput('count=\nuptime=\npid=512\nService settings: not found\nService package: found\n');
    expect(probe).toEqual({ foundServices: ['package'], identity: PID_A });
  });

  it('should report no identity when the pid is ambiguous or missing', () => {
    expect(parseFrameworkProbeOutput('count=\nuptime=\npid=512 513\n').identity).toBeUndefined();
    expect(parseFrameworkProbeOutput('count=0\nuptime=\npid=\n').identity).toBeUndefined();
    expect(parseFrameworkProbeOutput('').identity).toBeUndefined();
  });
});

describe('checkIsSystemServerRestarted', () => {
  it('should compare start counts and their uptime', () => {
    expect(checkIsSystemServerRestarted(COUNT_ONE, COUNT_ONE)).toBe(false);
    expect(checkIsSystemServerRestarted(COUNT_ONE, COUNT_TWO)).toBe(true);
    expect(checkIsSystemServerRestarted(COUNT_ONE, { ...COUNT_ONE, uptime: '1' })).toBe(true);
  });

  it('should compare pids', () => {
    expect(checkIsSystemServerRestarted(PID_A, PID_A)).toBe(false);
    expect(checkIsSystemServerRestarted(PID_A, PID_B)).toBe(true);
  });

  it('should not read a change of identity kind as a restart', () => {
    expect(checkIsSystemServerRestarted(COUNT_ONE, PID_A)).toBe(false);
    expect(checkIsSystemServerRestarted(PID_A, COUNT_ONE)).toBe(false);
  });
});

describe('resolveFrameworkProbeVerdict', () => {
  it('should be ready when every service is found and the identity is unchanged', () => {
    const probe = parseFrameworkProbeOutput(`count=1\nuptime=12345\n${ALL_FOUND}`);
    expect(resolveFrameworkProbeVerdict({ baseline: COUNT_ONE, probe })).toEqual({ kind: 'ready' });
  });

  it('should be ready with no baseline', () => {
    const probe = parseFrameworkProbeOutput(`count=1\nuptime=12345\n${ALL_FOUND}`);
    expect(resolveFrameworkProbeVerdict({ baseline: undefined, probe })).toEqual({ kind: 'ready' });
  });

  it('should report a restart before missing services', () => {
    const probe = parseFrameworkProbeOutput('count=2\nuptime=98765\nService settings: not found\n');
    expect(resolveFrameworkProbeVerdict({ baseline: COUNT_ONE, probe })).toEqual({ from: COUNT_ONE, kind: 'restarted', to: COUNT_TWO });
  });

  it('should name the missing services', () => {
    const probe = parseFrameworkProbeOutput('count=1\nuptime=12345\nService settings: not found\nService package: found\nService activity: found\nService input: found\nService connectivity: found\n');
    expect(resolveFrameworkProbeVerdict({ baseline: COUNT_ONE, probe })).toEqual({ kind: 'services-missing', missingServices: ['settings'] });
  });

  it('should count a missing system_server as not ready', () => {
    const probe = parseFrameworkProbeOutput(ALL_FOUND);
    expect(resolveFrameworkProbeVerdict({ baseline: COUNT_ONE, probe })).toEqual({ kind: 'services-missing', missingServices: ['system_server'] });
  });
});

describe('describeSystemServerRestart', () => {
  it('should describe each identity kind', () => {
    expect(describeSystemServerIdentity(COUNT_ONE)).toBe('start count 1');
    expect(describeSystemServerIdentity(PID_A)).toBe('pid 512');
    expect(describeSystemServerRestart({ from: COUNT_ONE, to: COUNT_TWO })).toBe('start count 1 -> 2');
    expect(describeSystemServerRestart({ from: PID_A, to: PID_B })).toBe('pid 512 -> 2048');
    expect(describeSystemServerRestart({ from: COUNT_ONE, to: PID_B })).toBe('start count 1 -> pid 2048');
  });
});

describe('buildFrameworkNotReadyMessage', () => {
  it('should name the restart and attach the crash and watchdog lines', () => {
    const message = buildFrameworkNotReadyMessage({
      crashLog: '--------- beginning of crash\nE AndroidRuntime: FATAL EXCEPTION IN SYSTEM PROCESS: main\n',
      deviceId: 'emulator-5554',
      lastVerdict: { kind: 'services-missing', missingServices: ['settings', 'activity'] },
      restarts: [{ from: COUNT_ONE, to: COUNT_TWO }],
      systemLog: 'I ActivityManager: unrelated\nW Watchdog: *** WATCHDOG KILLING SYSTEM PROCESS: Blocked in handler\n',
      timeoutInMilliseconds: 180_000
    });
    expect(message).toContain('did not come back within 180000ms after system_server restarted (start count 1 -> 2)');
    expect(message).toContain('Services still not registered at the last probe: settings, activity.');
    expect(message).toContain('FATAL EXCEPTION IN SYSTEM PROCESS');
    expect(message).toContain('WATCHDOG KILLING SYSTEM PROCESS');
    expect(message).not.toContain('unrelated');
    expect(message).not.toContain('beginning of crash');
  });

  it('should say when nothing answered and the logs could not be read', () => {
    const message = buildFrameworkNotReadyMessage({
      crashLog: null,
      deviceId: 'emulator-5554',
      lastVerdict: undefined,
      restarts: [],
      systemLog: '',
      timeoutInMilliseconds: 1000
    });
    expect(message).toContain('was not ready within 1000ms');
    expect(message).toContain('No framework probe was answered at all');
    expect(message).toContain('(could not be read)');
    expect(message).toContain('(empty)');
  });

  it('should report a restart seen by the last probe', () => {
    const message = buildFrameworkNotReadyMessage({
      crashLog: '',
      deviceId: 'emulator-5554',
      lastVerdict: { from: PID_A, kind: 'restarted', to: PID_B },
      restarts: [{ from: PID_A, to: PID_B }],
      systemLog: '',
      timeoutInMilliseconds: 1000
    });
    expect(message).toContain('The last probe saw system_server restart again (pid 512 -> 2048).');
  });

  it('should add nothing for a ready last verdict', () => {
    const message = buildFrameworkNotReadyMessage({
      crashLog: '',
      deviceId: 'emulator-5554',
      lastVerdict: { kind: 'ready' },
      restarts: [],
      systemLog: '',
      timeoutInMilliseconds: 1000
    });
    expect(message).not.toContain('last probe');
  });

  it('should keep only the last lines of a long log', () => {
    const longLog = Array.from({ length: 100 }, (_, index) => `E line ${String(index)}`).join('\n');
    const message = buildFrameworkNotReadyMessage({
      crashLog: longLog,
      deviceId: 'emulator-5554',
      lastVerdict: undefined,
      restarts: [],
      systemLog: '',
      timeoutInMilliseconds: 1000
    });
    expect(message).toContain('E line 99');
    expect(message).not.toContain('E line 59\n');
  });
});

describe('resolveFrameworkReadyTimeoutInMilliseconds', () => {
  it('should default and honour an override, including 0', () => {
    expect(resolveFrameworkReadyTimeoutInMilliseconds(BASE_OPTIONS)).toBe(DEFAULT_FRAMEWORK_READY_TIMEOUT_IN_MILLISECONDS);
    expect(resolveFrameworkReadyTimeoutInMilliseconds({ ...BASE_OPTIONS, frameworkReadyTimeoutInMilliseconds: 5000 })).toBe(5000);
    expect(resolveFrameworkReadyTimeoutInMilliseconds({ ...BASE_OPTIONS, frameworkReadyTimeoutInMilliseconds: 0 })).toBe(0);
  });
});
