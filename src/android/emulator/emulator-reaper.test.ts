import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { EmulatorMarker } from './emulator-marker.ts';

import {
  buildEmulatorReaperArguments,
  buildEmulatorReaperBootstrap,
  buildEmulatorReaperRelayBootstrap,
  EMULATOR_REAPER_ENTRY_NAME,
  EMULATOR_REAPER_LOG_MAX_SIZE_IN_BYTES,
  parseEmulatorReaperArguments,
  resolveEmulatorReaperLogOpenFlag,
  resolveEmulatorReaperWatch
} from './emulator-reaper.ts';

const STARTED_AT_IN_MILLISECONDS = 1_757_600_000_000;
const LIVE_PID = 101;
const DEAD_PID = 202;
const RELAY_TEST_TIMEOUT_IN_MILLISECONDS = 30_000;
const RELAY_RECORD_WAIT_IN_MILLISECONDS = 20_000;
const RELAY_RECORD_POLL_INTERVAL_IN_MILLISECONDS = 50;

/**
 * What the fixture reaper reports about itself, so the relay's one property can be asserted.
 */
interface RelayRecord {
  /**
  The arguments the bootstrap handed it.
   */
  argv: string[];

  /**
  Its parent — the relay, which has already exited.
   */
  ppid: number;
}

function buildMarker(overrides?: Partial<EmulatorMarker>): EmulatorMarker {
  return {
    avdName: 'obsidian_test',
    deviceId: 'emulator-5554',
    ownedEmulatorPids: [DEAD_PID, LIVE_PID],
    ownerPid: 303,
    startedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS,
    ...overrides
  };
}

function checkIsPidAlive(pid: number): boolean {
  return pid === LIVE_PID;
}

describe('buildEmulatorReaperArguments / parseEmulatorReaperArguments', () => {
  it('round-trips what the reaper watches for', () => {
    const reaperArguments = { avdName: 'obsidian_test', startedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS };

    expect(parseEmulatorReaperArguments(buildEmulatorReaperArguments(reaperArguments))).toEqual(reaperArguments);
  });

  it.each([
    ['no arguments', []],
    ['an empty AVD name', ['', String(STARTED_AT_IN_MILLISECONDS)]],
    ['a missing launch time', ['obsidian_test']],
    ['an extra argument', ['obsidian_test', String(STARTED_AT_IN_MILLISECONDS), 'extra']],
    ['a launch time that is not a number', ['obsidian_test', 'soon']],
    ['a launch time that is not an integer', ['obsidian_test', '1.5']],
    ['a launch time of zero', ['obsidian_test', '0']],
    ['a negative launch time', ['obsidian_test', '-1']]
  ])('rejects %s', (_description, argv) => {
    expect(parseEmulatorReaperArguments(argv)).toBeUndefined();
  });
});

describe('resolveEmulatorReaperWatch', () => {
  it('watches while the armed emulator still has a live PID', () => {
    expect(resolveEmulatorReaperWatch({
      armedStartedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS,
      checkIsPidAlive,
      marker: buildMarker()
    })).toBe('watch');
  });

  it('stops watching once the marker is gone — the run stopped the emulator', () => {
    expect(resolveEmulatorReaperWatch({
      armedStartedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS,
      checkIsPidAlive,
      marker: undefined
    })).toBe('emulator-stopped');
  });

  it('stops watching once none of the marked PIDs is alive', () => {
    expect(resolveEmulatorReaperWatch({
      armedStartedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS,
      checkIsPidAlive,
      marker: buildMarker({ ownedEmulatorPids: [DEAD_PID] })
    })).toBe('emulator-stopped');
  });

  it('stops watching a marker that owns no PIDs at all', () => {
    expect(resolveEmulatorReaperWatch({
      armedStartedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS,
      checkIsPidAlive,
      marker: buildMarker({ ownedEmulatorPids: [] })
    })).toBe('emulator-stopped');
  });

  /*
   * A launch-time marker names the launcher and leaves the backend to the
   * pre-launch diff, which needs a host process listing this poll does not
   * make. Reading it as stopped from PIDs alone is how the reaper would walk
   * away from a running emulator; the reclaim judges it instead.
   */
  it('keeps watching a launch-time marker whose launcher has already exited', () => {
    expect(resolveEmulatorReaperWatch({
      armedStartedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS,
      checkIsPidAlive,
      marker: buildMarker({ ownedEmulatorPids: [DEAD_PID], preLaunchEmulatorPids: [] })
    })).toBe('watch');
  });

  it('stands down for a later emulator of the same AVD, even one that is running', () => {
    expect(resolveEmulatorReaperWatch({
      armedStartedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS,
      checkIsPidAlive,
      marker: buildMarker({ startedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS + 1 })
    })).toBe('superseded');
  });

  it('keeps watching after a takeover, which rewrites the owner but keeps the launch time', () => {
    expect(resolveEmulatorReaperWatch({
      armedStartedAtInMilliseconds: STARTED_AT_IN_MILLISECONDS,
      checkIsPidAlive,
      marker: buildMarker({ ownedEmulatorPids: [LIVE_PID], ownerPid: 404 })
    })).toBe('watch');
  });
});

describe('resolveEmulatorReaperLogOpenFlag', () => {
  it('appends to a log that does not exist yet', () => {
    expect(resolveEmulatorReaperLogOpenFlag(undefined)).toBe('a');
  });

  it('appends to a log at the cap', () => {
    expect(resolveEmulatorReaperLogOpenFlag(EMULATOR_REAPER_LOG_MAX_SIZE_IN_BYTES)).toBe('a');
  });

  it('starts a log past the cap afresh', () => {
    expect(resolveEmulatorReaperLogOpenFlag(EMULATOR_REAPER_LOG_MAX_SIZE_IN_BYTES + 1)).toBe('w');
  });
});

describe('buildEmulatorReaperBootstrap', () => {
  /*
   * Run for real with `node -e`, exactly as the spawn does: the script is only
   * worth anything if Node loads each form the module ships as and finds the
   * entry in it.
   */
  let fixtureDirectory = '';

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'emulator-reaper-bootstrap-'));
    writeFileSync(
      join(fixtureDirectory, 'esm-entry.mjs'),
      `export function ${EMULATOR_REAPER_ENTRY_NAME}(argv) { console.log(JSON.stringify({ argv, form: 'esm' })); }\n`
    );
    writeFileSync(
      join(fixtureDirectory, 'cjs-entry.cjs'),
      `exports.${EMULATOR_REAPER_ENTRY_NAME} = function (argv) { console.log(JSON.stringify({ argv, form: 'cjs' })); };\n`
    );
    // A computed key hides the export from Node's static analysis, leaving only `default`.
    writeFileSync(
      join(fixtureDirectory, 'cjs-default-only.cjs'),
      `const name = '${EMULATOR_REAPER_ENTRY_NAME}';\nmodule.exports = { [name](argv) { console.log(JSON.stringify({ argv, form: 'default' })); } };\n`
    );
    writeFileSync(
      join(fixtureDirectory, 'failing-entry.mjs'),
      `export async function ${EMULATOR_REAPER_ENTRY_NAME}() { throw new Error('reaper blew up'); }\n`
    );
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  });

  function runBootstrap(fileName: string): ReturnType<typeof spawnSync> {
    return spawnSync(
      process.execPath,
      ['-e', buildEmulatorReaperBootstrap(), pathToFileURL(join(fixtureDirectory, fileName)).href, 'obsidian_test', '42'],
      { encoding: 'utf-8' }
    );
  }

  it.each([
    ['an ESM module', 'esm-entry.mjs', 'esm'],
    ['a CJS module with a named export', 'cjs-entry.cjs', 'cjs'],
    ['a CJS module whose export only its default carries', 'cjs-default-only.cjs', 'default']
  ])('hands the arguments after the module URL to the entry of %s', (_description, fileName, form) => {
    const result = runBootstrap(fileName);

    expect(result.status).toBe(0);
    expect(JSON.parse(String(result.stdout))).toEqual({ argv: ['obsidian_test', '42'], form });
  });

  it('reports an entry that rejects, and exits non-zero', () => {
    const result = runBootstrap('failing-entry.mjs');

    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain('reaper blew up');
  });
});

describe('buildEmulatorReaperRelayBootstrap', () => {
  /*
   * The relay exists for exactly one property — the reaper must not be a child
   * of the run that asked for one, or a kill that walks the run's process tree
   * takes it too — so the test asserts that property against real processes.
   * It fails against a spawn that skips the relay: there the reaper's parent is
   * the caller, and the caller is still running.
   */
  let fixtureDirectory = '';

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'emulator-reaper-relay-'));
    writeFileSync(
      join(fixtureDirectory, 'entry.mjs'),
      `import process from 'node:process';\nexport function ${EMULATOR_REAPER_ENTRY_NAME}(argv) { console.log(JSON.stringify({ argv, ppid: process.ppid })); }\n`
    );
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  });

  it('starts the reaper under a parent that has already exited, and keeps its output on the spawner\'s log', async () => {
    // A file descriptor, not a pipe: the spawner hands the reaper its capped log this way, and a pipe would keep `spawnSync` waiting for the reaper itself.
    const logFilePath = join(fixtureDirectory, 'relay.log');
    const logFileDescriptor = openSync(logFilePath, 'w');
    let relayResult: ReturnType<typeof spawnSync>;
    try {
      relayResult = spawnSync(
        process.execPath,
        [
          '-e',
          buildEmulatorReaperRelayBootstrap(),
          buildEmulatorReaperBootstrap(),
          pathToFileURL(join(fixtureDirectory, 'entry.mjs')).href,
          'obsidian_test',
          '42'
        ],
        { stdio: ['ignore', logFileDescriptor, logFileDescriptor] }
      );
    } finally {
      closeSync(logFileDescriptor);
    }

    // `spawnSync` returning at all is the first half of the property: the relay exited on its own, without waiting for the reaper.
    expect(relayResult.status).toBe(0);

    const record: RelayRecord = await readRelayRecord(logFilePath);

    expect(record.argv).toEqual(['obsidian_test', '42']);
    // The second half: the reaper's parent is that already-exited relay, so no edge leads back to this process.
    expect(record.ppid).toBe(relayResult.pid);
    expect(record.ppid).not.toBe(process.pid);
  }, RELAY_TEST_TIMEOUT_IN_MILLISECONDS);

  async function readRelayRecord(logFilePath: string): Promise<RelayRecord> {
    // The reaper outlives the relay by design, so its line reaches the log after `spawnSync` has already returned.
    const deadline = Date.now() + RELAY_RECORD_WAIT_IN_MILLISECONDS;
    for (;;) {
      const line = readFileSync(logFilePath, 'utf-8').trim();
      if (line) {
        return JSON.parse(line) as RelayRecord;
      }

      if (Date.now() > deadline) {
        throw new Error(`The reaper wrote nothing to ${logFilePath} within ${String(RELAY_RECORD_WAIT_IN_MILLISECONDS)}ms.`);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, RELAY_RECORD_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }
  }
});
