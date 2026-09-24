import {
  describe,
  expect,
  it
} from 'vitest';

import type { EmulatorProcessQuery } from './emulator-backend.ts';

import {
  buildEmulatorProcessQueries,
  checkIsNoMatchReported,
  parseEmulatorProcessQueryOutput,
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

/**
 * What `tasklist` prints, with exit 0, when a filter matched nothing — captured
 * from this host on 2026-09-23.
 */
const TASK_LIST_NO_MATCH_OUTPUT = 'INFO: No tasks are running which match the specified criteria.\r\n';

describe('buildEmulatorProcessQueries', () => {
  it('should ask tasklist for each emulator image-name prefix on Windows', () => {
    expect(buildEmulatorProcessQueries('win32')).toEqual([
      { command: 'tasklist', commandArguments: ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq emulator*'], isFiltered: true },
      { command: 'tasklist', commandArguments: ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq qemu-system*'], isFiltered: true }
    ]);
  });

  it('should keep the whole-host ps listing on POSIX', () => {
    expect(buildEmulatorProcessQueries('linux')).toEqual([
      { command: 'ps', commandArguments: ['-eo', 'pid=,comm='], isFiltered: false }
    ]);
  });

  /*
   * The filter and the selection are two spellings of one set of names. A
   * backend the filter never asks for is a backend no run can ever own, so every
   * name the selection accepts must start with a prefix the filter asks for.
   */
  it('should ask for every image name the backend selection accepts', () => {
    const prefixes = buildEmulatorProcessQueries('win32').map((query) => (query.commandArguments.at(-1) ?? '').replace('IMAGENAME eq ', '').replace('*', ''));
    const names = ['emulator.exe', 'emulator64-x86_64.exe', 'qemu-system-x86_64.exe', 'qemu-system-x86_64-headless.exe'];

    for (const name of names) {
      expect(selectEmulatorBackendPids({ knownPids: [], processes: [{ name, pid: 1 }] })).toEqual([1]);
      expect(prefixes.some((prefix) => name.startsWith(prefix))).toBe(true);
    }
  });
});

describe('checkIsNoMatchReported', () => {
  it('should recognize tasklist\'s no-match notice on a filtered query', () => {
    expect(checkIsNoMatchReported({ output: TASK_LIST_NO_MATCH_OUTPUT, query: getFirstQuery('win32') })).toBe(true);
  });

  it('should not read silence as a no-match answer', () => {
    expect(checkIsNoMatchReported({ output: '', query: getFirstQuery('win32') })).toBe(false);
  });

  it('should never let a whole-host listing answer "none"', () => {
    expect(checkIsNoMatchReported({ output: TASK_LIST_NO_MATCH_OUTPUT, query: getFirstQuery('linux') })).toBe(false);
  });
});

describe('parseEmulatorProcessQueryOutput', () => {
  it('should parse a tasklist answer as CSV', () => {
    expect(parseEmulatorProcessQueryOutput({ output: TASK_LIST_OUTPUT, query: getFirstQuery('win32') })).toHaveLength(3);
  });

  it('should parse the no-match notice to no rows', () => {
    expect(parseEmulatorProcessQueryOutput({ output: TASK_LIST_NO_MATCH_OUTPUT, query: getFirstQuery('win32') })).toEqual([]);
  });

  it('should parse a ps answer as columns', () => {
    expect(parseEmulatorProcessQueryOutput({ output: '  42 qemu-system-x86_64\n', query: getFirstQuery('linux') })).toEqual([
      { name: 'qemu-system-x86_64', pid: 42 }
    ]);
  });
});

function getFirstQuery(platform: NodeJS.Platform): EmulatorProcessQuery {
  const [query] = buildEmulatorProcessQueries(platform);
  if (!query) {
    throw new Error(`No emulator process query for ${platform}.`);
  }

  return query;
}
