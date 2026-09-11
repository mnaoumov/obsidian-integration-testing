import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
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
  EMULATOR_REAPER_ENTRY_NAME,
  EMULATOR_REAPER_LOG_MAX_SIZE_IN_BYTES,
  parseEmulatorReaperArguments,
  resolveEmulatorReaperLogOpenFlag,
  resolveEmulatorReaperWatch
} from './emulator-reaper.ts';

const STARTED_AT_IN_MILLISECONDS = 1_757_600_000_000;
const LIVE_PID = 101;
const DEAD_PID = 202;

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
