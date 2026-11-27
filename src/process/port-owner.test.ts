import {
  describe,
  expect,
  it
} from 'vitest';

import {
  buildPortOwnerQuery,
  excludeProtectedPids,
  parsePosixLsofPids,
  parseProcStatParentPid,
  parseWindowsNetstatPids
} from './port-owner.ts';

const APPIUM_PORT = 4723;

const NETSTAT_OUTPUT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:4723           0.0.0.0:0              LISTENING       12345',
  '  TCP    [::]:4723              [::]:0                 LISTENING       12345',
  '  TCP    127.0.0.1:4723         127.0.0.1:54321        ESTABLISHED     999',
  '  TCP    0.0.0.0:5554           0.0.0.0:0              LISTENING       2896',
  '  UDP    0.0.0.0:5353           *:*                                    777',
  ''
].join('\n');

describe('parseWindowsNetstatPids', () => {
  it('should return the PID listening on the port', () => {
    expect(parseWindowsNetstatPids({ netstatOutput: NETSTAT_OUTPUT, port: APPIUM_PORT })).toEqual([12_345]);
  });

  it('should report a PID once even though IPv4 and IPv6 both list it', () => {
    const output = [
      '  TCP    0.0.0.0:4723           0.0.0.0:0              LISTENING       12345',
      '  TCP    [::]:4723              [::]:0                 LISTENING       12345'
    ].join('\n');

    expect(parseWindowsNetstatPids({ netstatOutput: output, port: APPIUM_PORT })).toEqual([12_345]);
  });

  it('should ignore a connection to the port that is not listening on it', () => {
    const output = '  TCP    127.0.0.1:4723         127.0.0.1:54321        ESTABLISHED     999';

    expect(parseWindowsNetstatPids({ netstatOutput: output, port: APPIUM_PORT })).toEqual([]);
  });

  it('should ignore another port whose number is a suffix of nothing here', () => {
    expect(parseWindowsNetstatPids({ netstatOutput: NETSTAT_OUTPUT, port: 5554 })).toEqual([2896]);
  });

  it('should not confuse a port with one that merely ends in the same digits', () => {
    const output = '  TCP    0.0.0.0:14723          0.0.0.0:0              LISTENING       12345';

    expect(parseWindowsNetstatPids({ netstatOutput: output, port: APPIUM_PORT })).toEqual([]);
  });

  it('should ignore the UDP rows, which carry no state column', () => {
    const output = '  UDP    0.0.0.0:4723           *:*                                    777';

    expect(parseWindowsNetstatPids({ netstatOutput: output, port: APPIUM_PORT })).toEqual([]);
  });

  it('should ignore a truncated row with no PID', () => {
    const output = '  TCP    0.0.0.0:4723           0.0.0.0:0              LISTENING';

    expect(parseWindowsNetstatPids({ netstatOutput: output, port: APPIUM_PORT })).toEqual([]);
  });

  it('should return an empty array for empty output', () => {
    expect(parseWindowsNetstatPids({ netstatOutput: '', port: APPIUM_PORT })).toEqual([]);
  });
});

describe('parsePosixLsofPids', () => {
  it('should return one PID per line', () => {
    expect(parsePosixLsofPids('12345\n12346\n')).toEqual([12_345, 12_346]);
  });

  it('should report a PID once even when lsof lists it twice', () => {
    expect(parsePosixLsofPids('12345\n12345\n')).toEqual([12_345]);
  });

  it('should ignore blank lines', () => {
    expect(parsePosixLsofPids('\n12345\n\n')).toEqual([12_345]);
  });

  it('should return an empty array for empty output', () => {
    expect(parsePosixLsofPids('')).toEqual([]);
  });
});

describe('buildPortOwnerQuery', () => {
  it('should list the whole netstat table on Windows', () => {
    expect(buildPortOwnerQuery({ platform: 'win32', port: APPIUM_PORT })).toEqual({ command: 'netstat', commandArguments: ['-ano'] });
  });

  // A CDP client holds a socket on the port too; without -sTCP:LISTEN the teardown killed its own test runner.
  it('should ask lsof for listeners only on Linux', () => {
    expect(buildPortOwnerQuery({ platform: 'linux', port: APPIUM_PORT })).toEqual({
      command: 'lsof',
      commandArguments: ['-ti', 'tcp:4723', '-sTCP:LISTEN']
    });
  });

  it('should ask lsof for listeners only on macOS', () => {
    expect(buildPortOwnerQuery({ platform: 'darwin', port: APPIUM_PORT }).commandArguments).toContain('-sTCP:LISTEN');
  });
});

describe('excludeProtectedPids', () => {
  it('should drop the protected PIDs and keep the order of the rest', () => {
    expect(excludeProtectedPids({ pids: [30, 10, 20, 40], protectedPids: [10, 40] })).toEqual([30, 20]);
  });

  it('should return every PID when none is protected', () => {
    expect(excludeProtectedPids({ pids: [1, 2], protectedPids: [] })).toEqual([1, 2]);
  });
});

describe('parseProcStatParentPid', () => {
  it('should read the parent PID', () => {
    expect(parseProcStatParentPid('3014 (node) S 2990 3014 2990 0 -1 4194560')).toBe(2990);
  });

  it('should read past a command name holding spaces and parentheses', () => {
    expect(parseProcStatParentPid('77 (vitest (fork) worker) R 42 77 42 0')).toBe(42);
  });

  it('should return null for a line with no command name', () => {
    expect(parseProcStatParentPid('garbage')).toBeNull();
  });

  it('should return null for a line cut short after the command name', () => {
    expect(parseProcStatParentPid('77 (node) S')).toBeNull();
  });
});
