/**
 * @file
 *
 * Stops the emulators this harness started, and **verifies** each stop — the
 * marker-driven half of emulator ownership (`emulator-marker.ts`, **L56**).
 *
 * It lives apart from `transport-factory.ts` so that a process with no business
 * loading the whole transport stack can still stop an emulator correctly. That
 * process is the emulator reaper (`emulator-reaper.ts`): it runs detached from
 * any test runner, and in this repo's own suites it runs straight from source
 * under Node's type stripping, where a module reading the build-time
 * `OBSIDIAN_METADATA` global — which the factory's import graph reaches —
 * cannot load at all. So nothing this module imports may reach it either.
 */

/* v8 ignore start -- Integration-time emulator management covered by the Android integration suite, not unit tests. */

import type {
  ChildProcess,
  ExecFileException
} from 'node:child_process';

import { execFile } from 'node:child_process';
import process from 'node:process';

import type {
  EmulatorProcessQuery,
  ProcessListEntry
} from './emulator-backend.ts';
import type { EmulatorMarker } from './emulator-marker.ts';

import { checkIsDeviceListed } from './adb-device-list.ts';
import {
  buildEmulatorProcessQueries,
  checkIsNoMatchReported,
  parseEmulatorProcessQueryOutput,
  selectEmulatorBackendPids
} from './emulator-backend.ts';
import {
  clearEmulatorMarker,
  clearEmulatorMarkerIfStopped,
  listEmulatorMarkers,
  resolveEmulatorMarkerVerdict,
  selectLiveMarkedPids
} from './emulator-marker.ts';
import {
  buildHostProcessQueryMessage,
  resolveHostProcessQueryOutcome
} from './host-process-query-verdict.ts';
import {
  killProcessTree,
  killProcessTreeByPid
} from './kill-process-tree.ts';
import { checkIsProcessAlive } from './process-liveness.ts';
import {
  buildTeardownMessage,
  resolveTeardownOutcome
} from './teardown-verdict.ts';

/**
 * Budget for one quick `adb` call — `adb devices`, a console command.
 */
export const ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS = 5000;

/*
 * `dumpsys connectivity` is far larger than the other probes' output, and Node's
 * default 1 MiB `maxBuffer` would fail the call rather than truncate it — which
 * would read as "not ready" forever and burn the whole network budget. A host
 * process listing shares the same ceiling.
 */
export const ADB_DUMPSYS_MAX_BUFFER_IN_BYTES = 8_388_608;

/*
 * 120s, not the ~1s a whole-host `tasklist` costs on an idle host: this query
 * runs in the same post-boot contention window that inflates every `adb`
 * round-trip 25-50x (L45), and as a whole-host listing it was the most
 * contention-sensitive call the harness made — it walked every process on the
 * host, so it paid the host's slowdown ~540 times over.
 *
 * The two earlier numbers were both guesses, and both were too small. 10s was
 * overrun on the first end-to-end run. 30s then failed **every** Android run
 * from one host (measured 2026-09-20 across three runs and two AVDs), each time
 * killing the child at ~30s with nothing on stderr — the shape that reads as an
 * unexplained spawn failure and silently disarms the escalation.
 *
 * So this one is measured instead. Traced with no budget at all during an
 * emulator boot on that host (2026-09-23, n=40): p50 2.9s, p75 4.4s, p90 17.8s,
 * p95 29.1s, max **92.2s**. Every one of the 40 completed the full ~530-row
 * listing and exited within 55ms of its last row, so none of them was hung —
 * the cost is spread across the rows, in 1.0-2.7s pauses on individual
 * processes. 30s therefore cut off the top 2.5% of a distribution whose tail
 * reaches 92s, and a real run — which boots the emulator, starts Appium,
 * installs the app and runs Vitest at once — is more contended than that trace.
 *
 * 120s is ~1.3x the worst observed call, and costs nothing at the median.
 *
 * **That tail belonged to the whole-host listing, which Windows no longer
 * makes.** The query is now filtered to the emulator image names
 * (`buildEmulatorProcessQueries`), and the filtered call skips the per-process
 * work the tail was made of: with every core saturated it never exceeded 505ms
 * where the whole-host call stalled for 120.9s. The budget stays at 120s as a
 * ceiling rather than a forecast — it costs nothing when the call is fast, and
 * POSIX still lists the whole host. If a filtered call ever overruns it, the
 * next step is not a fifth number but deriving ownership without a process
 * listing at all.
 */
export const HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS = 120_000;

const EMULATOR_ESCALATED_STOP_TIMEOUT_IN_MILLISECONDS = 5000;
const EMULATOR_STOP_POLL_INTERVAL_IN_MILLISECONDS = 500;
const EMULATOR_STOP_TIMEOUT_IN_MILLISECONDS = 20_000;
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Parameters for {@link EmulatorReclaimer.reclaimLeftoverEmulators}.
 */
export interface EmulatorReclaimerReclaimLeftoverEmulatorsParams {
  /**
  An AVD whose leftover is left alone — the one a preflight is about to adopt instead.
   */
  readonly exceptAvdName?: string | undefined;

  /**
   * `'preflight'` spares an emulator another live harness process still owns.
   * `'end-of-run'` does not: the caller holds the `android` lock with no run in
   * flight — the run's own global teardown, or the emulator reaper after the
   * run is gone — so that owner can only be one of the finished run's
   * processes, which no longer has a turn to stop it.
   */
  readonly scope: 'end-of-run' | 'preflight';
}

/**
 * Parameters for {@link EmulatorReclaimer.stopEmulator}.
 */
export interface EmulatorReclaimerStopEmulatorParams {
  /**
  The AVD name, named in the warning so the leftover is identifiable, and the key of its marker.
   */
  readonly avdName: string;

  /**
   * The device the emulator is serving, shut down over its console and polled
   * to decide whether it actually stopped. `undefined` when the emulator failed
   * before any device appeared.
   */
  readonly deviceId?: string | undefined;

  /**
   * The emulator launcher process this run spawned. `undefined` for a leftover
   * this run took over, whose launcher belonged to another process.
   */
  readonly emulatorProcess?: ChildProcess | undefined;

  /**
  The emulator PIDs this run owns, escalated to when the console and the launcher's tree kill leave one behind.
   */
  readonly ownedEmulatorPids: readonly number[];
}

/**
 * A host command and its arguments.
 */
export interface HostCommandQuery {
  /**
  The executable to run.
   */
  readonly command: string;

  /**
  The command's arguments.
   */
  readonly commandArguments: string[];
}

interface EmulatorReclaimerCheckIsEmulatorGoneParams {
  /**
  The device the emulator serves, or `undefined` when none ever appeared — the PIDs are then the only proof.
   */
  readonly deviceId?: string | undefined;

  /**
  The emulator PIDs this run owns.
   */
  readonly ownedEmulatorPids: readonly number[];
}

interface EmulatorReclaimerWaitForEmulatorStoppedParams {
  /**
  The device the emulator serves, or `undefined` when none ever appeared.
   */
  readonly deviceId?: string | undefined;

  /**
  The emulator PIDs this run owns.
   */
  readonly ownedEmulatorPids: readonly number[];

  /**
  How long to wait for the emulator to disappear, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * Everything one host process listing left behind, kept together so the
 * classification sees the whole picture.
 *
 * `execFile`'s callback discards nothing here — not stderr, and not a *failed*
 * call's partial stdout. The old code kept only `error.message`, which for
 * `execFile` is `Command failed: <cmd>` plus stderr, so a killed child (empty
 * stderr) produced a line naming the command and nothing else.
 */
interface HostProcessQueryResult {
  /**
  `execFile`'s error, or `null` when the listing succeeded.
   */
  readonly error: ExecFileException | null;

  /**
  Whatever the child wrote to stderr.
   */
  readonly standardError: string;

  /**
  Whatever the child wrote to stdout — a partial listing when the call failed part-way.
   */
  readonly standardOutput: string;
}

/**
 * Finds, stops and verifies the harness's emulators, reporting through the
 * caller's log so each caller keeps its own prefix.
 */
export class EmulatorReclaimer {
  private readonly log: (message: string) => void;

  /**
   * Creates a reclaimer that reports under the caller's own log prefix.
   *
   * @param log - Receives every progress and verdict line.
   */
  public constructor(log: (message: string) => void) {
    this.log = log;
  }

  /**
   * Runs `adb devices` and returns its raw stdout.
   *
   * The raw listing is what teardown needs: `getConnectedDeviceIds` keeps only
   * the `device` state, and an emulator on its way out answers `offline` while
   * still holding the AVD — see `adb-device-list.ts`.
   *
   * @returns The raw `adb devices` output.
   * @throws If adb could not be run at all.
   */
  public getDevicesOutput(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile('adb', ['devices'], { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to run 'adb devices': ${error.message}. Is ADB installed and in PATH?`));
          return;
        }
        if (stderr) {
          this.log(`ADB stderr: ${stderr.trim()}`);
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Lists the host's emulator processes — every process whose image name could
   * be the launcher or a QEMU backend, and on POSIX every process on the host.
   *
   * On Windows this is two **filtered** `tasklist` calls rather than one
   * whole-host listing (`buildEmulatorProcessQueries` carries the measurement
   * that made the switch), run in parallel. A filtered call may legitimately
   * find nothing, but only when it says so: a clean exit with neither a row nor
   * `tasklist`'s own no-match notice is still a failed query, and comes back as
   * `undefined` exactly like one that did not run — never as an empty list a
   * caller could read as "no emulator is running".
   *
   * Each failed call logs **one** line, from `host-process-query-verdict.ts`,
   * naming which way it failed. The predecessor logged two contradictory ones
   * for a single failure — `could not list host processes` immediately followed
   * by `listed no processes` — because a failed call resolved `''`, which then
   * parsed to zero rows and tripped the zero-row check as well.
   *
   * **If any call fails, the whole answer is `undefined`**, and a failed call's
   * partial stdout is parsed but never returned: the owned PID set is the
   * difference between two answers, so a half answer — one image name's
   * processes without the other's, or a truncated listing — would both miss a
   * process this run owns and claim one it does not, and killing a process the
   * run does not own is the one thing **L46** forbids. The row count goes into
   * the log instead, as the evidence that the command was working.
   *
   * @returns The host's emulator processes, or `undefined` when a query failed.
   */
  public async queryEmulatorProcesses(): Promise<ProcessListEntry[] | undefined> {
    const answers = await Promise.all(buildEmulatorProcessQueries(process.platform).map((query) => this.runEmulatorProcessQuery(query)));
    const processes: ProcessListEntry[] = [];
    for (const answer of answers) {
      if (answer === undefined) {
        return undefined;
      }
      processes.push(...answer);
    }

    return processes;
  }

  /**
   * Stops the emulators this harness started that no live run is responsible
   * for, and drops the markers that no longer describe a running emulator.
   *
   * Only ever acts on a **marker-verified** emulator: one whose marker names a
   * PID that is still a live emulator process. An emulator without a marker —
   * booted by hand, by CI, or by another tool — is never touched, which keeps
   * the L46 line: never a `qemu*` sweep.
   *
   * Callers must hold the `android` setup lock (L7), which is what makes a
   * leftover safe to stop: no other Android run can be mid-flight on it.
   *
   * @param params - Which AVD to leave alone, and whether this run is ending.
   */
  public async reclaimLeftoverEmulators(params: EmulatorReclaimerReclaimLeftoverEmulatorsParams): Promise<void> {
    const markers = listEmulatorMarkers().filter((marker) => marker.avdName !== params.exceptAvdName);
    if (markers.length === 0) {
      return;
    }

    const processes = await this.queryEmulatorProcesses();
    if (processes === undefined) {
      // Without a listing every marker would read as stale, and deleting them would leave the leftovers impossible to convict.
      this.log(`Cannot judge ${String(markers.length)} emulator marker(s) without a host process listing; leaving them for a later run.`);
      return;
    }

    const liveEmulatorPids = selectEmulatorBackendPids({ knownPids: [], processes });
    for (const marker of markers) {
      await this.reclaimLeftoverEmulator(marker, liveEmulatorPids, params.scope);
    }
  }

  /**
   * Stops an emulator this harness owns, and **verifies** it stopped.
   *
   * The console shutdown goes first because it is the only path that releases
   * the AVD's `multiinstance.lock`; a `taskkill` leaves the lock behind, and a
   * stale lock is what makes the next run fail with `Running multiple emulators
   * with the same AVD` — a FATAL the emulator writes to its own stdout, where
   * nobody sees it.
   *
   * Works without a launcher handle too: a leftover this run took over has only
   * its PIDs, which is all the escalation below ever needed. The marker goes
   * only with a **verified** stop, so an emulator that outlived this attempt
   * stays convictable by the next one.
   *
   * @param params - The emulator process, the device it serves and the PIDs this run owns.
   */
  public async stopEmulator(params: EmulatorReclaimerStopEmulatorParams): Promise<void> {
    if (params.deviceId !== undefined) {
      await this.killEmulatorConsole(params.deviceId);
    }
    if (params.emulatorProcess) {
      killProcessTree(params.emulatorProcess);
    }

    const waitParams: EmulatorReclaimerWaitForEmulatorStoppedParams = {
      deviceId: params.deviceId,
      ownedEmulatorPids: params.ownedEmulatorPids,
      timeoutInMilliseconds: EMULATOR_STOP_TIMEOUT_IN_MILLISECONDS
    };

    let hasEscalated = false;
    let isStopped = await this.waitForEmulatorStopped(waitParams);

    if (!isStopped) {
      const survivingPids = params.ownedEmulatorPids.filter((pid) => checkIsProcessAlive(pid));
      if (survivingPids.length > 0) {
        hasEscalated = true;
        this.log(
          `Auto-started emulator outlived its console shutdown and the launcher's process tree; escalating to the emulator PID(s) this run owns: [${survivingPids.join(', ')}].`
        );
        for (const pid of survivingPids) {
          killProcessTreeByPid(pid);
        }
        isStopped = await this.waitForEmulatorStopped({ ...waitParams, timeoutInMilliseconds: EMULATOR_ESCALATED_STOP_TIMEOUT_IN_MILLISECONDS });
      }
    }

    this.log(buildTeardownMessage({
      evidence: params.deviceId === undefined ? `AVD "${params.avdName}"` : `AVD "${params.avdName}" on device ${params.deviceId}`,
      outcome: resolveTeardownOutcome({ hasEscalated, isStopped }),
      subject: 'Auto-started emulator',
      timeoutInMilliseconds: EMULATOR_STOP_TIMEOUT_IN_MILLISECONDS
    }));

    if (isStopped) {
      clearEmulatorMarkerIfStopped(params.avdName);
    }
  }

  /**
   * Decides whether the emulator this run started is really gone.
   *
   * Two independent proofs, cheapest first: none of the PIDs this run owns is
   * alive, and the device no longer appears in `adb devices` **in any state** (a
   * dying emulator answers `offline` while it still holds the AVD).
   *
   * @param params - The device and the PIDs this run owns.
   * @returns `true` when nothing of this run's emulator is left.
   */
  private async checkIsEmulatorGone(params: EmulatorReclaimerCheckIsEmulatorGoneParams): Promise<boolean> {
    if (params.ownedEmulatorPids.some((pid) => checkIsProcessAlive(pid))) {
      return false;
    }

    if (params.deviceId === undefined) {
      return true;
    }

    try {
      return !checkIsDeviceListed({ deviceId: params.deviceId, devicesOutput: await this.getDevicesOutput() });
    } catch (error: unknown) {
      /*
       * An adb that cannot run is not evidence about the emulator — and the PID
       * probe above has already said this run's processes are gone, which is the
       * stronger of the two proofs.
       */
      this.log(`Could not re-check connected devices while stopping the emulator: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }

  /**
   * Asks the emulator to shut itself down over its console.
   *
   * Preferred over killing the process outright because it is the path that
   * releases the AVD's `multiinstance.lock`. Best-effort: a console that does
   * not answer is reported and the caller falls through to the kill.
   *
   * @param deviceId - The emulator's device ID.
   */
  private killEmulatorConsole(deviceId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      execFile('adb', ['-s', deviceId, 'emu', 'kill'], { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS }, (error, stdout) => {
        this.log(
          error
            ? `Emulator console shutdown for ${deviceId} did not answer: ${error.message}`
            : `Emulator console shutdown for ${deviceId}: ${stdout.trim()}`
        );
        resolve();
      });
    });
  }

  /**
   * Acts on one emulator marker for {@link reclaimLeftoverEmulators}.
   *
   * @param marker - The marker to judge.
   * @param liveEmulatorPids - The emulator processes currently running on the host.
   * @param scope - Whether an emulator another live harness process owns is spared.
   */
  private async reclaimLeftoverEmulator(marker: EmulatorMarker, liveEmulatorPids: readonly number[], scope: EmulatorReclaimerReclaimLeftoverEmulatorsParams['scope']): Promise<void> {
    const verdict = resolveEmulatorMarkerVerdict({
      currentPid: process.pid,
      isOwnerAlive: checkIsProcessAlive(marker.ownerPid),
      liveEmulatorPids,
      marker
    });

    if (verdict === 'stale-marker') {
      this.log(`Dropping the emulator marker for AVD "${marker.avdName}": none of its PIDs [${marker.ownedEmulatorPids.join(', ')}] is a running emulator any more.`);
      clearEmulatorMarker(marker.avdName);
      return;
    }

    /*
     * A marker written at launch has no device yet: the emulator was still
     * booting when whatever recorded it stopped looking. The stop below reads
     * that absence correctly — no console to shut down, the owned PIDs are the
     * whole of the evidence — so it is described rather than papered over.
     */
    const evidence = describeMarkedEmulator(marker);

    if (verdict === 'in-use-by-live-run' && scope === 'preflight') {
      this.log(`Leaving the emulator for ${evidence} alone: the harness process that owns it (PID ${String(marker.ownerPid)}) is still running.`);
      return;
    }

    const ageInSeconds = Math.round((Date.now() - marker.startedAtInMilliseconds) / MILLISECONDS_PER_SECOND);
    this.log(
      `Stopping the emulator for ${evidence}: this harness started it ${String(ageInSeconds)}s ago, and no live run is left to stop it.`
    );
    await this.stopEmulator({
      avdName: marker.avdName,
      deviceId: marker.deviceId,
      ownedEmulatorPids: selectLiveMarkedPids(marker, liveEmulatorPids)
    });
  }

  /**
   * Runs one of the emulator process queries and classifies how it ended.
   *
   * @param query - The query.
   * @returns Its parsed rows, or `undefined` when it failed.
   */
  private async runEmulatorProcessQuery(query: EmulatorProcessQuery): Promise<ProcessListEntry[] | undefined> {
    const startedAtInMilliseconds = Date.now();
    const result = await new Promise<HostProcessQueryResult>((resolve) => {
      execFile(
        query.command,
        [...query.commandArguments],
        { maxBuffer: ADB_DUMPSYS_MAX_BUFFER_IN_BYTES, timeout: HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS },
        (error, stdout, stderr) => {
          resolve({ error, standardError: stderr, standardOutput: stdout });
        }
      );
    });

    const processes = parseEmulatorProcessQueryOutput({ output: result.standardOutput, query });
    const outcome = resolveHostProcessQueryOutcome({
      errorCode: result.error?.code ?? null,
      hasFailed: result.error !== null,
      hasReportedNoMatch: checkIsNoMatchReported({ output: result.standardOutput, query }),
      isKilled: result.error?.killed ?? false,
      rowCount: processes.length,
      standardError: result.standardError
    });

    const message = buildHostProcessQueryMessage({
      command: [query.command, ...query.commandArguments].join(' '),
      elapsedInMilliseconds: Date.now() - startedAtInMilliseconds,
      exitCode: typeof result.error?.code === 'number' ? result.error.code : null,
      outcome,
      partialRowCount: processes.length,
      signal: result.error?.signal ?? null,
      standardError: result.standardError,
      timeoutInMilliseconds: HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS
    });
    if (message !== undefined) {
      this.log(message);
    }

    return outcome === 'listed' ? processes : undefined;
  }

  /**
   * Polls until this run's emulator is gone, or the budget elapses.
   *
   * @param params - The device, the PIDs this run owns, and the budget.
   * @returns `true` when the emulator disappeared within the budget.
   */
  private async waitForEmulatorStopped(params: EmulatorReclaimerWaitForEmulatorStoppedParams): Promise<boolean> {
    const deadline = Date.now() + params.timeoutInMilliseconds;

    while (Date.now() < deadline) {
      if (await this.checkIsEmulatorGone(params)) {
        return true;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, EMULATOR_STOP_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }

    return false;
  }
}

/**
 * Names the emulator a marker describes, for the log.
 *
 * @param marker - The marker.
 * @returns The AVD and its device, or the AVD alone for a launch that had not produced a device yet.
 */
function describeMarkedEmulator(marker: EmulatorMarker): string {
  return marker.deviceId === undefined
    ? `AVD "${marker.avdName}" (no device: it was still booting when it was recorded)`
    : `AVD "${marker.avdName}" on device ${marker.deviceId}`;
}

/* v8 ignore stop */
