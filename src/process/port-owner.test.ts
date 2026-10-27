import {
  describe,
  expect,
  it
} from 'vitest';

import {
  parsePosixLsofPids,
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
