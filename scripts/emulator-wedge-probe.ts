/**
 * @file
 *
 * Boots one AVD exactly as a run would and watches it until it wedges — with no
 * Appium, no vault, no suite, and nothing of this harness above the emulator.
 *
 * ## Why this is a repo asset rather than a scratch file
 *
 * A host where the emulator stops answering ~60-160s after boot fails every
 * Android run, in three different-looking ways that all name the *device* (see
 * **L49**). Distinguishing "this machine is broken" from "these tests are
 * broken" is therefore the first question of any Android investigation, and it
 * is answerable in about 90 seconds — but only with a reproducer that boots the
 * emulator the way the harness boots it. That reproducer has now been rebuilt
 * from scratch twice. This is it, kept.
 *
 * It is also the instrument for the *other* direction: run it on a candidate
 * host — another workstation, a CI runner — and a clean survival is what
 * convicts the machine the wedge was found on.
 *
 * And it is how you A/B a single host. Stop one suspect service, run it again,
 * and the pair of verdicts is the answer: that is how a content blocker's
 * socket filter driver was identified as the cause on the host in **L49**,
 * after the emulator build, the system image and the hypervisor had all been
 * eliminated. `--survive-for 240` is the watch length those runs used.
 *
 * ## Why it cannot drift from the harness
 *
 * A probe that booted with its own hand-written flag list would measure a
 * configuration nothing else uses, and every conclusion drawn from it would be
 * about that configuration. So the arguments come from
 * {@link buildEmulatorArguments}, the binary from
 * {@link resolveEmulatorBinaryPath}, the verdict from
 * {@link resolveEmulatorLivenessVerdict} and its explanation from
 * {@link buildEmulatorLivenessMessage} — the same four the transport uses. The
 * probe adds only what a run has no reason to collect: the backend's CPU share
 * and the host's free memory at each poll, which are what separate a *blocked*
 * emulator from a starved one.
 *
 * Usage:
 *   npm run probe:emulator-wedge
 *   npm run probe:emulator-wedge -- --avd asc_test --survive-for 600
 *   npm run probe:emulator-wedge -- --settle-for 0     # judge the guest from the first poll
 *   npm run probe:emulator-wedge -- --visible          # watch the emulator window
 *   npm run probe:emulator-wedge -- --reuse-snapshot   # probe the snapshot path instead of a cold boot
 *
 * Exits non-zero when the emulator wedges, so CI can gate on it.
 */

import {
  execFile,
  spawn
} from 'node:child_process';
import { freemem } from 'node:os';
import process from 'node:process';
import { parseArgs } from 'node:util';

import type { ProcessListEntry } from '../src/emulator-backend.ts';
import type {
  EmulatorLivenessProbeOutcome,
  EmulatorLivenessVerdict
} from '../src/emulator-liveness.ts';
import type {
  BackendSample,
  ProbeTick
} from './helpers/emulator-wedge-probe-report.ts';

import {
  checkIsDeviceListed,
  listOnlineDeviceIds
} from '../src/adb-device-list.ts';
import { resolveEmulatorBinaryPath } from '../src/android-sdk.ts';
import { checkIsEmulatorDeviceId } from '../src/avd-probe-verdict.ts';
import { buildEmulatorArguments } from '../src/emulator-arguments.ts';
import {
  parsePosixProcessList,
  parseWindowsTaskList,
  selectEmulatorBackendPids
} from '../src/emulator-backend.ts';
import {
  buildEmulatorLivenessMessage,
  resolveEmulatorLivenessVerdict
} from '../src/emulator-liveness.ts';
import { errorToString } from '../src/error-to-string.ts';
import { killProcessTreeByPid } from '../src/kill-process-tree.ts';
import {
  buildProbeReport,
  computeCpuPercent,
  formatProbeTick,
  parseBackendSample
} from './helpers/emulator-wedge-probe-report.ts';
import { exitIfScriptDisabled } from './helpers/env-toggle.ts';

const ADB_QUERY_TIMEOUT_IN_MILLISECONDS = 15_000;
const BOOT_POLL_INTERVAL_IN_MILLISECONDS = 2000;
/**
 * How long to wait for the AVD to reach `sys.boot_completed`.
 *
 * A cold boot measures ~112s and has been seen to take 220s on a contended
 * host. The wedge itself can land *before* boot completes, which is why running
 * out of this budget is reported as the wedge rather than as a setup failure.
 */
const BOOT_TIMEOUT_IN_MILLISECONDS = 300_000;
const DEFAULT_AVD_NAME = 'obsidian_test';
const DEFAULT_POLL_EVERY_IN_SECONDS = 5;
/**
 * How long after boot a merely **quiet guest** is forgiven.
 *
 * `sys.boot_completed` is not the end of the boot: the post-boot window is the
 * contention **L45** sizes its budgets for, where every `adb` round-trip inflates
 * 25-50x on a busy host — measured here, a probe with no allowance convicted a
 * healthy guest 5s after boot while the host was compiling. The harness waits
 * that window out (`deviceIdleTimeoutInMilliseconds`, 60s) before it starts
 * caring, so the probe does too, or it would report a false wedge on exactly the
 * loaded CI runner it exists to clear.
 *
 * **Only `guest-unresponsive` is forgiven.** A silent *console* is never
 * settling: it is served by the emulator process, so its silence convicts the
 * emulator whenever it happens.
 */
const DEFAULT_SETTLE_FOR_IN_SECONDS = 60;
/**
 * How long a healthy emulator is watched before the run is called a survival.
 *
 * 300s by default: comfortably past the longest wedge measured so far (163s),
 * so a survival is a real one rather than a look too short to catch it.
 */
const DEFAULT_SURVIVE_FOR_IN_SECONDS = 300;
const EXIT_CODE_FAILED = 1;
const HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS = 30_000;
const KIBIBYTES_PER_MEBIBYTE = 1024;
const LARGEST_PROCESS_LIST_IN_MEBIBYTES = 10;
const LIVENESS_ATTEMPT_COUNT = 2;
/**
 * How long each `adb` liveness probe is given.
 *
 * Mirrors `transport-factory.ts` deliberately: a probe that gave up sooner than
 * the harness does would call a device dead while a real run would have carried
 * on, and this probe's whole claim is that it sees what a run sees.
 */
const LIVENESS_TIMEOUT_IN_MILLISECONDS = 15_000;
const MILLISECONDS_PER_SECOND = 1000;
const PROCESS_LIST_MAX_BUFFER_IN_BYTES = LARGEST_PROCESS_LIST_IN_MEBIBYTES * KIBIBYTES_PER_MEBIBYTE * KIBIBYTES_PER_MEBIBYTE;
/**
 * Matches the QEMU backend among the emulator processes.
 *
 * `selectEmulatorBackendPids` deliberately matches the `emulator` launcher too,
 * because teardown has to kill both. Sampling does not: the launcher is a thin
 * shim that idles, so sampling it would report a healthy 0% for a reason that
 * has nothing to do with the wedge.
 */
const QEMU_BACKEND_NAME_PREFIX = 'qemu-system-';

exitIfScriptDisabled();

const { values } = parseArgs({
  options: {
    'avd': { default: DEFAULT_AVD_NAME, type: 'string' },
    'poll-every': { default: String(DEFAULT_POLL_EVERY_IN_SECONDS), type: 'string' },
    'reuse-snapshot': { default: false, type: 'boolean' },
    'settle-for': { default: String(DEFAULT_SETTLE_FOR_IN_SECONDS), type: 'string' },
    'survive-for': { default: String(DEFAULT_SURVIVE_FOR_IN_SECONDS), type: 'string' },
    'visible': { default: false, type: 'boolean' }
  }
});

const avdName = values.avd;
const pollEveryInMilliseconds = toMilliseconds(values['poll-every'], DEFAULT_POLL_EVERY_IN_SECONDS);
const settleForInMilliseconds = toMilliseconds(values['settle-for'], DEFAULT_SETTLE_FOR_IN_SECONDS, 0);
const surviveForInMilliseconds = toMilliseconds(values['survive-for'], DEFAULT_SURVIVE_FOR_IN_SECONDS);
const emulatorArguments = buildEmulatorArguments({
  avdName,
  isHidden: !values.visible,
  shouldReuseSnapshot: values['reuse-snapshot']
});

try {
  await runProbe();
} catch (error) {
  console.error(errorToString(error));
  process.exitCode = EXIT_CODE_FAILED;
}

/**
 * A tick the probe stops on, whose verdict is therefore never `alive`.
 */
interface FatalTick extends ProbeTick {
  readonly verdict: Exclude<EmulatorLivenessVerdict, 'alive'>;
}

/**
 * Decides whether a tick ends the watch.
 *
 * @param tick - The tick.
 * @returns `true` when the verdict is one the probe stops on.
 */
function checkIsFatal(tick: ProbeTick): tick is FatalTick {
  if (tick.verdict === 'alive') {
    return false;
  }

  return tick.verdict !== 'guest-unresponsive' || tick.elapsedInMilliseconds >= settleForInMilliseconds;
}

function delay(durationInMilliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationInMilliseconds);
  });
}

/**
 * Finds the QEMU backend's PID once, for {@link sampleBackend} to reuse.
 *
 * @returns The PID, or `undefined` when no backend is listed.
 */
async function findBackendPid(): Promise<number | undefined> {
  const hostProcesses = await listHostProcesses();
  return hostProcesses.find((entry) => toBaseName(entry.name).startsWith(QEMU_BACKEND_NAME_PREFIX))?.pid;
}

/**
 * Lists the emulator backend PIDs currently running, minus the ones that
 * predate this run.
 *
 * Under `-no-window` the backend is `qemu-system-x86_64-headless`, not the
 * `emulator` launcher this script spawned and holds a PID for — which is why
 * the launcher's PID is neither what gets sampled nor the only thing killed.
 *
 * @param knownPids - PIDs to exclude as not this run's.
 * @returns The remaining emulator backend PIDs.
 */
async function listEmulatorBackendPids(knownPids: readonly number[]): Promise<number[]> {
  return selectEmulatorBackendPids({ knownPids, processes: await listHostProcesses() });
}

/**
 * Lists every process on the host, with the platform's own query and parser.
 *
 * @returns The listed processes, or none when the query failed.
 */
async function listHostProcesses(): Promise<ProcessListEntry[]> {
  const isWindows = process.platform === 'win32';
  const query = isWindows
    ? { command: 'tasklist', commandArguments: ['/FO', 'CSV', '/NH'] }
    : { command: 'ps', commandArguments: ['-eo', 'pid=,comm='] };
  const output = await runHostQuery(query.command, query.commandArguments);

  return isWindows ? parseWindowsTaskList(output) : parsePosixProcessList(output);
}

/**
 * Lists the online devices that are emulators.
 *
 * A physical handset plugged into this host is neither something to refuse over
 * nor something to time a boot against, and `adb devices` lists it alongside the
 * emulator — so the same `emulator-<port>` test the transport uses decides what
 * counts here. Found the honest way: the first run of this probe refused to
 * start because a phone was attached.
 *
 * @returns The online emulator device IDs, in listed order.
 */
async function listOnlineEmulatorIds(): Promise<string[]> {
  return listOnlineDeviceIds(await queryAdb(['devices'])).filter((deviceId) => checkIsEmulatorDeviceId(deviceId));
}

/**
 * Runs one `adb` query, returning empty output rather than throwing.
 *
 * @param adbArguments - The adb arguments.
 * @returns The stdout, or an empty string when the query failed.
 */
function queryAdb(adbArguments: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('adb', [...adbArguments], { timeout: ADB_QUERY_TIMEOUT_IN_MILLISECONDS }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

/**
 * Asks the guest, and — only when the guest has gone quiet — the emulator's own
 * console and the adb listing.
 *
 * @param deviceId - The device to probe.
 * @returns The verdict.
 */
async function resolveVerdict(deviceId: string): Promise<EmulatorLivenessVerdict> {
  const shellProbe = await runLivenessProbe(['-s', deviceId, 'shell', 'true']);
  if (shellProbe === 'answered') {
    return 'alive';
  }

  const [consoleProbe, devicesOutput] = await Promise.all([
    runLivenessProbe(['-s', deviceId, 'emu', 'avd', 'status']),
    queryAdb(['devices'])
  ]);

  return resolveEmulatorLivenessVerdict({
    consoleProbe,
    deviceId,
    isListedByAdb: checkIsDeviceListed({ deviceId, devicesOutput }),
    shellProbe
  });
}

/**
 * Runs one host query, returning empty output rather than throwing.
 *
 * @param command - The command.
 * @param commandArguments - Its arguments.
 * @returns The stdout, or an empty string when the query failed.
 */
function runHostQuery(command: string, commandArguments: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...commandArguments],
      { maxBuffer: PROCESS_LIST_MAX_BUFFER_IN_BYTES, timeout: HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS },
      (error, stdout) => {
        resolve(error ? '' : stdout);
      }
    );
  });
}

/**
 * Runs one liveness probe, re-asking once before believing its silence.
 *
 * Only success counts as an answer — a failed `adb ... emu` may be the adb
 * server refusing an `offline` device rather than the console being dead. The
 * same restraint `transport-factory.ts` applies, for the same reason.
 *
 * @param adbArguments - The adb arguments.
 * @returns Whether the probe got an answer.
 */
async function runLivenessProbe(adbArguments: readonly string[]): Promise<EmulatorLivenessProbeOutcome> {
  for (let attempt = 1; attempt <= LIVENESS_ATTEMPT_COUNT; attempt++) {
    const isAnswered = await new Promise<boolean>((resolve) => {
      execFile('adb', [...adbArguments], { timeout: LIVENESS_TIMEOUT_IN_MILLISECONDS }, (error) => {
        resolve(!error);
      });
    });

    if (isAnswered) {
      return 'answered';
    }
  }

  return 'no-answer';
}

/**
 * Boots the AVD, watches it, reports, and tears down whatever it started.
 */
async function runProbe(): Promise<void> {
  const runningEmulatorIds = await listOnlineEmulatorIds();
  if (runningEmulatorIds.length > 0) {
    throw new Error(
      `This probe must own the emulator it measures, but adb already lists ${runningEmulatorIds.join(', ')}. `
        + 'Stop those emulators (or run `adb kill-server`) and re-run, so the boot being timed is this one.'
    );
  }

  const knownPids = await listEmulatorBackendPids([]);
  const emulatorBinary = resolveEmulatorBinaryPath();
  console.log(`Booting: ${emulatorBinary} ${emulatorArguments.join(' ')}`);

  const emulator = spawn(emulatorBinary, emulatorArguments, { stdio: ['ignore', 'pipe', 'pipe'] });
  let emulatorOutput = '';
  function captureOutput(chunk: Buffer): void {
    emulatorOutput += chunk.toString();
  }

  emulator.stdout.on('data', captureOutput);
  emulator.stderr.on('data', captureOutput);

  try {
    const deviceId = await waitForBootedDevice();
    console.log(`Booted ${deviceId}. Polling every ${String(pollEveryInMilliseconds / MILLISECONDS_PER_SECOND)}s.`);

    const ticks = await watchDevice(deviceId, await findBackendPid());
    const lastTick = ticks.at(-1);
    const diagnosis = lastTick && checkIsFatal(lastTick)
      ? buildEmulatorLivenessMessage({
        deviceId,
        emulatorOutput,
        probeTimeoutInMilliseconds: LIVENESS_TIMEOUT_IN_MILLISECONDS,
        verdict: lastTick.verdict
      })
      : undefined;

    console.log(buildProbeReport({ avdName, diagnosis, emulatorArguments, surviveForInMilliseconds, ticks }));
    if (diagnosis !== undefined) {
      process.exitCode = EXIT_CODE_FAILED;
    }
  } finally {
    await stopEmulator(emulator.pid, knownPids);
  }
}

/**
 * Samples the QEMU backend.
 *
 * **The PID is resolved once by the caller, and that is a measurement decision
 * rather than a performance tweak.** A full process listing is expensive on
 * Windows — the same slowness `transport-factory.ts` records overrunning a 10s
 * budget — and a first draft of this probe that re-listed on every tick spaced
 * its own samples 27s apart, on a 5s poll interval. That reports the moment of a
 * wedge to a resolution far coarser than the wedge itself, which is the one
 * number the table exists to carry. Given the PID, a tick costs one small
 * per-process query.
 *
 * Best-effort throughout: a wedged emulator slows the very host queries that
 * would describe it, and a probe that failed because `tasklist` was slow would
 * report nothing at all rather than a verdict. An unsampled tick prints `?` and
 * the verdict stands on the adb probes alone.
 *
 * @param pid - The backend's PID, found once after boot.
 * @returns The sample, or `undefined` when the backend could not be sampled.
 */
async function sampleBackend(pid: number | undefined): Promise<BackendSample | undefined> {
  if (pid === undefined) {
    return undefined;
  }

  const backend = { pid };

  const query = process.platform === 'win32'
    ? {
      command: 'powershell',
      commandArguments: [
        '-NoProfile',
        '-Command',
        `$p = Get-Process -Id ${String(backend.pid)} -ErrorAction SilentlyContinue; if ($p) { '{0} {1} {2}' -f $p.Id, [int]$p.TotalProcessorTime.TotalSeconds, [int]($p.WorkingSet64 / 1024) }`
      ]
    }
    : { command: 'ps', commandArguments: ['-p', String(backend.pid), '-o', 'pid=,cputimes=,rss='] };

  return parseBackendSample(await runHostQuery(query.command, query.commandArguments));
}

/**
 * Kills the emulator this run started, backend included.
 *
 * `adb emu kill` is deliberately not used: on a wedged emulator it asks the hung
 * console to shut itself down and hangs for its full budget, which is one of the
 * symptoms this probe exists to record.
 *
 * @param launcherPid - The PID of the spawned `emulator` launcher.
 * @param knownPids - The backend PIDs that predate this run.
 */
async function stopEmulator(launcherPid: number | undefined, knownPids: readonly number[]): Promise<void> {
  for (const pid of await listEmulatorBackendPids(knownPids)) {
    killProcessTreeByPid(pid);
  }

  if (launcherPid !== undefined) {
    killProcessTreeByPid(launcherPid);
  }
}

function toBaseName(name: string): string {
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).toLowerCase();
}

/**
 * Reads a seconds-valued option.
 *
 * @param rawSeconds - The raw option value.
 * @param fallbackInSeconds - The value to use when the raw one is not a usable number.
 * @param lowerBoundInSeconds - The smallest accepted value. `0` for the settle window, which can legitimately be switched off; `1` for the intervals, where zero would spin.
 * @returns The value in milliseconds.
 */
function toMilliseconds(rawSeconds: string, fallbackInSeconds: number, lowerBoundInSeconds = 1): number {
  const seconds = Number(rawSeconds);
  return (Number.isFinite(seconds) && seconds >= lowerBoundInSeconds ? seconds : fallbackInSeconds) * MILLISECONDS_PER_SECOND;
}

/**
 * Waits for an emulator to appear on adb and report `sys.boot_completed`.
 *
 * A boot that never completes is the wedge landing early rather than a broken
 * setup, so the timeout says so.
 *
 * @returns The booted device's ID.
 */
async function waitForBootedDevice(): Promise<string> {
  const deadline = Date.now() + BOOT_TIMEOUT_IN_MILLISECONDS;

  while (Date.now() < deadline) {
    const [deviceId] = await listOnlineEmulatorIds();
    if (deviceId !== undefined) {
      const bootCompleted = await queryAdb(['-s', deviceId, 'shell', 'getprop', 'sys.boot_completed']);
      if (bootCompleted.trim() === '1') {
        return deviceId;
      }
    }

    await delay(BOOT_POLL_INTERVAL_IN_MILLISECONDS);
  }

  throw new Error(
    `AVD "${avdName}" did not reach sys.boot_completed within ${String(BOOT_TIMEOUT_IN_MILLISECONDS / MILLISECONDS_PER_SECOND)}s. `
      + 'On a host that wedges, that is the wedge landing before the boot finished rather than a setup problem — '
      + 'check whether the emulator backend is sitting at 0% CPU.'
  );
}

/**
 * Polls the device until it stops answering or outlives the survival budget.
 *
 * @param deviceId - The booted device.
 * @param backendPid - The QEMU backend's PID, or `undefined` when it could not be found.
 * @returns Every tick, in order. The last one carries the verdict.
 */
async function watchDevice(deviceId: string, backendPid: number | undefined): Promise<ProbeTick[]> {
  const ticks: ProbeTick[] = [];
  /*
   * A baseline sample before the first poll, so the first tick already has
   * something to diff against. Without it a wedge that lands inside the first
   * interval — measured here at 5s, and the wedge is not deterministic — prints
   * `cpu=?` on the only row there is, losing the reading the table exists for.
   */
  let previousSample = await sampleBackend(backendPid);
  let previousSampledAt = Date.now();
  const startedAt = previousSampledAt;

  while (Date.now() - startedAt < surviveForInMilliseconds) {
    await delay(pollEveryInMilliseconds);

    const sampledAt = Date.now();
    const [verdict, backend] = await Promise.all([resolveVerdict(deviceId), sampleBackend(backendPid)]);
    const tick: ProbeTick = {
      backend,
      cpuPercent: previousSample && backend
        ? computeCpuPercent({
          current: backend,
          intervalInMilliseconds: sampledAt - previousSampledAt,
          previous: previousSample
        })
        : undefined,
      elapsedInMilliseconds: sampledAt - startedAt,
      freeMemoryInBytes: freemem(),
      verdict
    };

    ticks.push(tick);
    console.log(formatProbeTick(tick));
    previousSample = backend;
    previousSampledAt = sampledAt;

    if (checkIsFatal(tick)) {
      return ticks;
    }
  }

  return ticks;
}
