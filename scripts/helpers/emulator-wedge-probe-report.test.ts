/**
 * @file
 *
 * Tests for the emulator-wedge probe's report.
 *
 * The sample lines below are the real shapes the two platform commands print —
 * `ps -p <pid> -o pid=,cputimes=,rss=` on POSIX, and the `'{0} {1} {2}' -f` line
 * the Windows branch formats from `Get-Process`. One parser reads both, which is
 * exactly the agreement worth pinning: the columns are positional, so a platform
 * branch that reordered them would still parse and would report a resident set
 * size as CPU seconds.
 *
 * The report assertions guard the one reading the whole probe exists to
 * produce — that a wedged backend was at **0%**, blocked rather than starved.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import type {
  BackendSample,
  ProbeTick
} from './emulator-wedge-probe-report.ts';

import {
  buildProbeReport,
  computeCpuPercent,
  formatProbeTick,
  parseBackendSample
} from './emulator-wedge-probe-report.ts';

const BYTES_PER_KIBIBYTE = 1024;
const EMULATOR_ARGUMENTS = ['-avd', 'obsidian_test', '-no-snapshot-load', '-no-snapshot-save', '-dns-server', '8.8.8.8', '-no-window'];

function buildSample(overrides: Partial<BackendSample> = {}): BackendSample {
  return { cpuTimeInSeconds: 100, pid: 10_004, residentSetSizeInBytes: 6 * BYTES_PER_KIBIBYTE ** 3, ...overrides };
}

function buildTick(overrides: Partial<ProbeTick> = {}): ProbeTick {
  return {
    backend: buildSample(),
    cpuPercent: 0,
    elapsedInMilliseconds: 80_000,
    freeMemoryInBytes: 12 * BYTES_PER_KIBIBYTE ** 3,
    verdict: 'alive',
    ...overrides
  };
}

describe('parseBackendSample', () => {
  it('reads the POSIX `ps -o pid=,cputimes=,rss=` shape', () => {
    expect(parseBackendSample('  10004        37 6103516\n')).toEqual({
      cpuTimeInSeconds: 37,
      pid: 10_004,
      residentSetSizeInBytes: 6_103_516 * BYTES_PER_KIBIBYTE
    });
  });

  it('reads the line the Windows branch formats from Get-Process', () => {
    expect(parseBackendSample('10004 37 6103516\r\n')).toEqual({
      cpuTimeInSeconds: 37,
      pid: 10_004,
      residentSetSizeInBytes: 6_103_516 * BYTES_PER_KIBIBYTE
    });
  });

  it('reports no sample when the process is gone and the command printed nothing', () => {
    expect(parseBackendSample('')).toBeUndefined();
  });

  it('reports no sample when a column is missing rather than guessing which one', () => {
    expect(parseBackendSample('10004 37')).toBeUndefined();
  });

  it('reports no sample when a column is not a number', () => {
    expect(parseBackendSample('10004 - 6103516')).toBeUndefined();
  });
});

describe('computeCpuPercent', () => {
  it('reports 0% for a backend that consumed no CPU between samples -- the wedge signature', () => {
    const sample = buildSample({ cpuTimeInSeconds: 37 });
    expect(computeCpuPercent({ current: sample, intervalInMilliseconds: 5000, previous: sample })).toBe(0);
  });

  it('reports one fully busy core as 100%', () => {
    expect(computeCpuPercent({
      current: buildSample({ cpuTimeInSeconds: 42 }),
      intervalInMilliseconds: 5000,
      previous: buildSample({ cpuTimeInSeconds: 37 })
    })).toBe(100);
  });

  it('reports multi-core work above 100% rather than clamping, so busy never reads as blocked', () => {
    expect(computeCpuPercent({
      current: buildSample({ cpuTimeInSeconds: 57 }),
      intervalInMilliseconds: 5000,
      previous: buildSample({ cpuTimeInSeconds: 37 })
    })).toBe(400);
  });

  it('refuses to compare samples of different processes', () => {
    expect(computeCpuPercent({
      current: buildSample({ pid: 20_008 }),
      intervalInMilliseconds: 5000,
      previous: buildSample({ pid: 10_004 })
    })).toBeUndefined();
  });

  it('refuses a non-positive interval rather than dividing by it', () => {
    const sample = buildSample();
    expect(computeCpuPercent({ current: sample, intervalInMilliseconds: 0, previous: sample })).toBeUndefined();
  });

  it('refuses a backwards CPU total, which means the PID was reused', () => {
    expect(computeCpuPercent({
      current: buildSample({ cpuTimeInSeconds: 1 }),
      intervalInMilliseconds: 5000,
      previous: buildSample({ cpuTimeInSeconds: 37 })
    })).toBeUndefined();
  });
});

describe('formatProbeTick', () => {
  it('prints the elapsed second, the verdict and both host readings', () => {
    expect(formatProbeTick(buildTick())).toBe('  80s  alive               cpu=0%  rss=6.00GB  free=12.00GB');
  });

  it('prints `?` for an unsampled backend instead of a made-up zero', () => {
    expect(formatProbeTick(buildTick({ backend: undefined, cpuPercent: undefined }))).toContain('cpu=?  rss=?');
  });
});

describe('buildProbeReport', () => {
  it('calls a run that answered every poll a survival, and says the host does not reproduce the wedge', () => {
    const report = buildProbeReport({
      avdName: 'obsidian_test',
      diagnosis: undefined,
      emulatorArguments: EMULATOR_ARGUMENTS,
      surviveForInMilliseconds: 300_000,
      ticks: [buildTick(), buildTick({ elapsedInMilliseconds: 300_000 })]
    });

    expect(report).toContain('SURVIVED: the guest answered 2 of 2 polls across 300s of uptime.');
    expect(report).toContain('This host does not reproduce the wedge.');
  });

  it('does not claim every poll answered when one inside the settle window did not', () => {
    const report = buildProbeReport({
      avdName: 'obsidian_test',
      diagnosis: undefined,
      emulatorArguments: EMULATOR_ARGUMENTS,
      surviveForInMilliseconds: 300_000,
      ticks: [
        buildTick({ elapsedInMilliseconds: 5000, verdict: 'guest-unresponsive' }),
        buildTick({ elapsedInMilliseconds: 300_000 })
      ]
    });

    expect(report).toContain('SURVIVED: the guest answered 1 of 2 polls across 300s of uptime.');
    expect(report).toContain('inside the post-boot settle window');
  });

  it('quotes the harness diagnosis rather than restating it, and adds the blocked-not-starved reading', () => {
    const report = buildProbeReport({
      avdName: 'obsidian_test',
      diagnosis: 'Device emulator-5554 stopped answering before the Appium session could be established.',
      emulatorArguments: EMULATOR_ARGUMENTS,
      surviveForInMilliseconds: 300_000,
      ticks: [buildTick({ verdict: 'emulator-wedged' })]
    });

    expect(report).toContain('WEDGED: emulator-wedged after 80s of uptime.');
    expect(report).toContain('Device emulator-5554 stopped answering before the Appium session could be established.');
    expect(report).toContain('The backend was at 0% CPU with 12.00GB free on the host.');
  });

  it('names the arguments it booted with, so the report says what was measured', () => {
    const report = buildProbeReport({
      avdName: 'obsidian_test',
      diagnosis: undefined,
      emulatorArguments: EMULATOR_ARGUMENTS,
      surviveForInMilliseconds: 300_000,
      ticks: [buildTick()]
    });

    expect(report).toContain('AVD "obsidian_test", booted with: emulator -avd obsidian_test -no-snapshot-load');
  });

  it('says it measured nothing when the emulator never produced a tick', () => {
    const report = buildProbeReport({
      avdName: 'obsidian_test',
      diagnosis: undefined,
      emulatorArguments: EMULATOR_ARGUMENTS,
      surviveForInMilliseconds: 300_000,
      ticks: []
    });

    expect(report).toContain('The probe recorded no ticks, so it measured nothing.');
  });
});
