import {
  describe,
  expect,
  it
} from 'vitest';

import {
  parsePosixProcessList,
  parseWindowsTaskList,
  selectEmulatorBackendPids
} from './emulator-backend.ts';

const TASK_LIST_OUTPUT = [
  '"emulator.exe","2832","Console","1","24,468 K"',
  '"qemu-system-x86_64-headless.exe","2896","Console","1","1,234,567 K"',
  '"node.exe","4104","Console","1","98,765 K"',
  ''
].join('\n');

describe('parseWindowsTaskList', () => {
  it('should parse the image name and PID of every CSV row', () => {
    expect(parseWindowsTaskList(TASK_LIST_OUTPUT)).toEqual([
      { name: 'emulator.exe', pid: 2832 },
      { name: 'qemu-system-x86_64-headless.exe', pid: 2896 },
      { name: 'node.exe', pid: 4104 }
    ]);
  });

  it('should keep the memory column\'s commas out of the parse', () => {
    expect(parseWindowsTaskList('"qemu-system-x86_64.exe","7","Services","0","1,048,576 K"')).toEqual([
      { name: 'qemu-system-x86_64.exe', pid: 7 }
    ]);
  });

  it('should skip a row without a numeric PID field', () => {
    expect(parseWindowsTaskList('"emulator.exe"\n"emulator.exe","not-a-pid"')).toEqual([]);
  });

  it('should skip blank lines', () => {
    expect(parseWindowsTaskList('\n\n"emulator.exe","2832","Console","1","24,468 K"\n\n')).toEqual([
      { name: 'emulator.exe', pid: 2832 }
    ]);
  });

  it('should return an empty array for empty output', () => {
    expect(parseWindowsTaskList('')).toEqual([]);
  });
});

describe('parsePosixProcessList', () => {
  it('should parse the PID and command name of every row', () => {
    expect(parsePosixProcessList('  1234 qemu-system-x86_64\n 5678 node\n')).toEqual([
      { name: 'qemu-system-x86_64', pid: 1234 },
      { name: 'node', pid: 5678 }
    ]);
  });

  it('should tolerate the column padding `ps` pads the PID with', () => {
    expect(parsePosixProcessList('   42     qemu-system-x86_64\n')).toEqual([
      { name: 'qemu-system-x86_64', pid: 42 }
    ]);
  });

  it('should skip a row with no command name', () => {
    expect(parsePosixProcessList('1234\n')).toEqual([]);
  });

  it('should skip a row whose first column is not a PID', () => {
    expect(parsePosixProcessList('PID COMMAND\n')).toEqual([]);
  });

  it('should return an empty array for empty output', () => {
    expect(parsePosixProcessList('')).toEqual([]);
  });
});

describe('selectEmulatorBackendPids', () => {
  /*
   * The whole point of the module: under `-no-window` the process that holds the
   * AVD is the `-headless` backend, and it is exactly the name the obvious
   * `-Name qemu-system-x86_64` filter does not match.
   */
  it('should select the headless QEMU backend', () => {
    expect(selectEmulatorBackendPids({
      knownPids: [],
      processes: [{ name: 'qemu-system-x86_64-headless.exe', pid: 2896 }]
    })).toEqual([2896]);
  });

  it('should select the windowed QEMU backend', () => {
    expect(selectEmulatorBackendPids({
      knownPids: [],
      processes: [{ name: 'qemu-system-x86_64.exe', pid: 2896 }]
    })).toEqual([2896]);
  });

  it('should select the emulator launcher', () => {
    expect(selectEmulatorBackendPids({
      knownPids: [],
      processes: [{ name: 'emulator.exe', pid: 2832 }]
    })).toEqual([2832]);
  });

  it('should select a backend named by its absolute path', () => {
    expect(selectEmulatorBackendPids({
      knownPids: [],
      processes: [{ name: '/opt/android-sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64', pid: 91 }]
    })).toEqual([91]);
  });

  it('should ignore processes that are not an emulator backend', () => {
    expect(selectEmulatorBackendPids({
      knownPids: [],
      processes: [
        { name: 'node.exe', pid: 4104 },
        { name: 'qemu-img.exe', pid: 4105 },
        { name: 'chrome.exe', pid: 4106 }
      ]
    })).toEqual([]);
  });

  /*
   * A backend that was already running before this run launched its own is
   * somebody else's emulator — another AVD, or one the user booted by hand.
   * Killing it would be the harness terminating a process it does not own.
   */
  it('should exclude a backend that was already running before this run started one', () => {
    expect(selectEmulatorBackendPids({
      knownPids: [2896],
      processes: [
        { name: 'qemu-system-x86_64-headless.exe', pid: 2896 },
        { name: 'qemu-system-x86_64-headless.exe', pid: 3001 }
      ]
    })).toEqual([3001]);
  });

  it('should return an empty array when nothing is running', () => {
    expect(selectEmulatorBackendPids({ knownPids: [], processes: [] })).toEqual([]);
  });
});
