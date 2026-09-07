/**
 * @file
 *
 * Pure formatting and arithmetic for `scripts/emulator-wedge-probe.ts`.
 *
 * The probe's whole value is its evidence, so the evidence is built here where
 * it can be unit-tested, and the script keeps only the shelling-out. That split
 * is the same one `src/emulator-liveness.ts` and `src/emulator-backend.ts` make
 * against `transport-factory.ts`, for the same reason.
 *
 * Deliberately under `scripts/helpers/` rather than in `src/`: every `src/`
 * module has to be reachable from something the package ships
 * (`src/public-api-barrel.test.ts` asserts it), and a module only the probe
 * script imports is not. `scripts/helpers/npm-pack.ts` set that precedent, and
 * the `unit-tests:scripts` Vitest project already collects the tests beside it.
 *
 * ## What the numbers are for
 *
 * The verdict alone (`emulator-wedged`) says the emulator stopped answering. It
 * does not say *blocked* rather than *thrashing*, and that distinction is what
 * moved this fault off the harness: a backend at **0% CPU** is stuck in its own
 * main loop, not starved by a busy host, and a host with 12 GB free at that
 * moment is not short of memory. Both readings are printed on every tick so the
 * table is a diagnosis rather than a timestamp.
 */

import type { EmulatorLivenessVerdict } from '../../src/emulator-liveness.ts';

/**
 * One sample of the QEMU backend process.
 *
 * Cumulative CPU time rather than an instantaneous percentage, because no
 * portable API reports another process's current CPU share — the percentage is
 * derived from two samples by {@link computeCpuPercent}.
 */
export interface BackendSample {
  /**
  Total CPU time the process has consumed since it started.
   */
  readonly cpuTimeInSeconds: number;

  /**
  The process ID sampled.
   */
  readonly pid: number;

  /**
  The process's resident set size at the moment of the sample.
   */
  readonly residentSetSizeInBytes: number;
}

/**
 * Parameters for {@link buildProbeReport}.
 */
export interface BuildProbeReportParams {
  /**
  The AVD the probe booted.
   */
  readonly avdName: string;

  /**
   * The harness's own liveness diagnosis, when the run ended wedged.
   *
   * Passed in rather than rebuilt here so the words a probe uses and the words a
   * failing run uses have exactly one author — `buildEmulatorLivenessMessage`.
   */
  readonly diagnosis: string | undefined;

  /**
  The emulator arguments the probe used, so the report states what was actually measured.
   */
  readonly emulatorArguments: readonly string[];

  /**
  How long the probe was willing to watch a healthy emulator before calling it a survival.
   */
  readonly surviveForInMilliseconds: number;

  /**
  Every tick, in order.
   */
  readonly ticks: readonly ProbeTick[];
}

/**
 * Parameters for {@link computeCpuPercent}.
 */
export interface ComputeCpuPercentParams {
  /**
  The later sample.
   */
  readonly current: BackendSample;

  /**
  Wall-clock time between the two samples.
   */
  readonly intervalInMilliseconds: number;

  /**
  The earlier sample.
   */
  readonly previous: BackendSample;
}

/**
 * One poll of the booted emulator.
 */
export interface ProbeTick {
  /**
  The backend process sample, or `undefined` when the backend could not be found or sampled.
   */
  readonly backend: BackendSample | undefined;

  /**
  The backend's CPU share since the previous tick, or `undefined` on the first tick and when unsampled.
   */
  readonly cpuPercent: number | undefined;

  /**
  Milliseconds since the device finished booting.
   */
  readonly elapsedInMilliseconds: number;

  /**
  Host memory free at this tick.
   */
  readonly freeMemoryInBytes: number;

  /**
  What the guest, the console and the adb listing added up to.
   */
  readonly verdict: EmulatorLivenessVerdict;
}

/**
 * `<pid> <cpuSeconds> <rssKiB>` — the single shape both platform commands are
 * asked to print, so one parser serves Windows and POSIX instead of two that can
 * disagree about which column means what.
 */
const BACKEND_SAMPLE_FIELD_COUNT = 3;
const BYTES_PER_GIBIBYTE = 1_073_741_824;
const BYTES_PER_KIBIBYTE = 1024;
const ELAPSED_COLUMN_WIDTH = 4;
const GIBIBYTE_FRACTION_DIGITS = 2;
const MILLISECONDS_PER_SECOND = 1000;
const PERCENT_SCALE = 100;
const RADIX_DECIMAL = 10;
/**
 * Pads the verdict column to the longest verdict, so the table's later columns
 * stay aligned however the run ends.
 */
const VERDICT_COLUMN_WIDTH = 'guest-unresponsive'.length;
const WHITESPACE_RUN_REG_EXP = /\s+/;

/**
 * Builds the report a probe run ends with: the tick table, then the verdict and
 * what it means for the host.
 *
 * @param params - The AVD, the arguments it booted with, the survival budget, the diagnosis and every tick.
 * @returns The report.
 */
export function buildProbeReport(params: BuildProbeReportParams): string {
  const lastTick = params.ticks.at(-1);
  const lines = [
    '',
    `AVD "${params.avdName}", booted with: emulator ${params.emulatorArguments.join(' ')}`,
    '',
    ...params.ticks.map((tick) => formatProbeTick(tick)),
    ''
  ];

  if (!lastTick) {
    lines.push('The probe recorded no ticks, so it measured nothing. Check that the emulator booted at all.');
    return lines.join('\n');
  }

  lines.push(...(lastTick.verdict === 'alive' ? buildSurvivalVerdict(params, lastTick) : buildFailureVerdict(params, lastTick)));
  return lines.join('\n');
}

/**
 * Derives the backend's CPU share over the interval between two samples.
 *
 * Reported against a single core, so a busy multi-threaded backend can exceed
 * 100%. That is deliberate: the reading this probe exists to capture is **0%**,
 * and a ceiling that folded multi-core work back under 100% would make a
 * thrashing backend indistinguishable from a blocked one.
 *
 * @param params - The two samples and the wall-clock gap between them.
 * @returns The percentage, or `undefined` when the samples cannot be compared.
 */
export function computeCpuPercent(params: ComputeCpuPercentParams): number | undefined {
  if (params.current.pid !== params.previous.pid || params.intervalInMilliseconds <= 0) {
    return undefined;
  }

  const cpuTimeDeltaInSeconds = params.current.cpuTimeInSeconds - params.previous.cpuTimeInSeconds;
  if (cpuTimeDeltaInSeconds < 0) {
    return undefined;
  }

  return (cpuTimeDeltaInSeconds * MILLISECONDS_PER_SECOND * PERCENT_SCALE) / params.intervalInMilliseconds;
}

/**
 * Formats one tick as a table row, in the shape the wedge was originally
 * reported in.
 *
 * @param tick - The tick.
 * @returns The row.
 */
export function formatProbeTick(tick: ProbeTick): string {
  const seconds = Math.round(tick.elapsedInMilliseconds / MILLISECONDS_PER_SECOND);
  return [
    `${String(seconds).padStart(ELAPSED_COLUMN_WIDTH)}s`,
    tick.verdict.padEnd(VERDICT_COLUMN_WIDTH),
    `cpu=${formatPercent(tick.cpuPercent)}`,
    `rss=${formatGibibytes(tick.backend?.residentSetSizeInBytes)}`,
    `free=${formatGibibytes(tick.freeMemoryInBytes)}`
  ].join('  ');
}

/**
 * Parses one `<pid> <cpuSeconds> <rssKiB>` sample line.
 *
 * Whitespace-separated so the same parser reads `ps` output and the line the
 * Windows branch formats; anything that is not three numbers is read as "could
 * not sample", which is a normal outcome once the process has exited.
 *
 * @param sampleOutput - Raw stdout of the platform's sampling command.
 * @returns The sample, or `undefined` when the output is not one.
 */
export function parseBackendSample(sampleOutput: string): BackendSample | undefined {
  const fields = sampleOutput.trim().split(WHITESPACE_RUN_REG_EXP);
  if (fields.length !== BACKEND_SAMPLE_FIELD_COUNT) {
    return undefined;
  }

  const [pid = NaN, cpuTimeInSeconds = NaN, residentSetSizeInKibibytes = NaN] = fields.map((field) => Number.parseInt(field, RADIX_DECIMAL));

  if (Number.isNaN(pid) || Number.isNaN(cpuTimeInSeconds) || Number.isNaN(residentSetSizeInKibibytes)) {
    return undefined;
  }

  return { cpuTimeInSeconds, pid, residentSetSizeInBytes: residentSetSizeInKibibytes * BYTES_PER_KIBIBYTE };
}

function buildFailureVerdict(params: BuildProbeReportParams, lastTick: ProbeTick): string[] {
  const seconds = Math.round(lastTick.elapsedInMilliseconds / MILLISECONDS_PER_SECOND);
  const lines = [`WEDGED: ${lastTick.verdict} after ${String(seconds)}s of uptime.`];

  if (params.diagnosis !== undefined) {
    lines.push('', params.diagnosis, '');
  }

  if (lastTick.cpuPercent !== undefined) {
    lines.push(
      `The backend was at ${formatPercent(lastTick.cpuPercent)} CPU with ${formatGibibytes(lastTick.freeMemoryInBytes)} free on the host.`,
      'A backend near 0% is blocked rather than spinning, and a host with memory to spare is not starving it. Both readings point below this harness: at the emulator build, the system image, or the host hypervisor.'
    );
  }

  lines.push(
    'No emulator flag, AVD setting, newer system image or newer emulator build has fixed this shape where it has been measured. Run this probe on other hardware before spending time anywhere else.'
  );

  return lines;
}

function buildSurvivalVerdict(params: BuildProbeReportParams, lastTick: ProbeTick): string[] {
  const seconds = Math.round(params.surviveForInMilliseconds / MILLISECONDS_PER_SECOND);
  const answeredCount = params.ticks.filter((tick) => tick.verdict === 'alive').length;
  const lines = [
    `SURVIVED: the guest answered ${String(answeredCount)} of ${String(params.ticks.length)} polls across ${String(seconds)}s of uptime.`,
    `The backend finished at ${formatPercent(lastTick.cpuPercent)} CPU. This host does not reproduce the wedge.`
  ];

  if (answeredCount < params.ticks.length) {
    lines.push(
      'The polls it missed were inside the post-boot settle window, where a busy host inflates every adb round-trip; the console served by the emulator process answered throughout, so none of them was the emulator.'
    );
  }

  return lines;
}

function formatGibibytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return '?';
  }

  return `${(bytes / BYTES_PER_GIBIBYTE).toFixed(GIBIBYTE_FRACTION_DIGITS)}GB`;
}

function formatPercent(percent: number | undefined): string {
  if (percent === undefined) {
    return '?';
  }

  return `${String(Math.round(percent))}%`;
}
