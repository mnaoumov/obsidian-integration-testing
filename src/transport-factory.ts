/**
 * @file
 *
 * Factory for creating transport instances from {@link ObsidianTransportOptions}.
 */

/* v8 ignore start -- Integration-time factory covered by integration tests, not unit tests. */

import type { ChildProcess } from 'node:child_process';
import type {
  attach,
  remote
} from 'webdriverio';

import {
  execFile,
  execFileSync,
  spawn
} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  statSync
} from 'node:fs';
import http from 'node:http';
import {
  homedir,
  tmpdir
} from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppiumServerMarker } from './appium-server-marker.ts';
import type { AvdProbeResult } from './avd-probe-verdict.ts';
import type { EmulatorLivenessProbeOutcome } from './emulator-liveness.ts';
import type { HostCommandQuery } from './emulator-reclaim.ts';
import type { InstallerCompatibility } from './installer-compatibility.ts';
import type { ProcessExitInfo } from './process-exit-message.ts';
import type {
  DesktopCdpTransportConfig,
  OwnedInstanceConfig
} from './transport-desktop-cdp.ts';
import type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianCdpTransportOptions,
  ObsidianTransportOptions
} from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';
import type { WedgedAppiumServerReportReason } from './wedged-appium-server.ts';

import {
  checkIsDeviceListed,
  listOnlineDeviceIds,
  parseAdbDevices
} from './adb-device-list.ts';
import { resolveEmulatorBinaryPath } from './android-sdk.ts';
import {
  checkIsAppiumDriverInstalled,
  UIAUTOMATOR2_DRIVER_NAME,
  willAutoInstallAppiumDependencies
} from './appium-dependencies.ts';
import {
  checkIsHarnessOwnedAppiumServer,
  clearAppiumServerMarker,
  readAppiumServerMarker,
  recordAppiumServerStopAttempt,
  writeAppiumServerMarker
} from './appium-server-marker.ts';
import {
  resolveAppiumStartTimeoutInMilliseconds,
  resolveScriptTimeoutInMilliseconds,
  resolveSessionConnectionRetryTimeoutInMilliseconds
} from './appium-session-config.ts';
import {
  checkAvdExists,
  listAvailableAvds
} from './avd-list.ts';
import {
  buildAvdProbeSummary,
  buildUnreadableDevicesMessage,
  checkIsEmulatorDeviceId,
  classifyAvdProbe,
  resolveAvdProbeVerdict
} from './avd-probe-verdict.ts';
import {
  resolveInstallerCompatibilityAction,
  willThrowOnIncompatibleInstaller,
  willThrowOnSilentAsarFallback,
  willWarnOnCompatibilityIssues
} from './compatibility-options.ts';
import { assertValidConfigDirectory } from './config-directory.ts';
import { getSetupError } from './context-provider.ts';
import {
  checkDeviceIdle,
  checkNetworkValidated,
  resolveDeviceIdleTimeoutInMilliseconds,
  resolveNetworkReadyTimeoutInMilliseconds
} from './device-readiness.ts';
import {
  buildEmulatorArguments,
  buildEmulatorEnvironment,
  NETSIM_LOG_FILTER
} from './emulator-arguments.ts';
import { selectEmulatorBackendPids } from './emulator-backend.ts';
import {
  buildEmulatorLivenessMessage,
  resolveEmulatorLivenessVerdict
} from './emulator-liveness.ts';
import {
  checkIsMarkedEmulatorRunning,
  clearEmulatorMarker,
  clearEmulatorMarkerIfStopped,
  readEmulatorMarker,
  resolveEmulatorMarkerVerdict,
  selectLiveMarkedPids,
  writeEmulatorMarker
} from './emulator-marker.ts';
import { spawnEmulatorReaper } from './emulator-reaper.ts';
import {
  ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS,
  ADB_DUMPSYS_MAX_BUFFER_IN_BYTES,
  EmulatorReclaimer,
  HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS
} from './emulator-reclaim.ts';
import {
  buildAvdSnapshotDirectoryCandidates,
  buildSnapshotAgeMessage
} from './emulator-snapshot.ts';
import { exec } from './exec.ts';
import { IncompatibleInstallerVersionError } from './incompatible-installer-version-error.ts';
import { resolveInstallerCompatibility } from './installer-compatibility.ts';
import { IntegrationSetupFailedError } from './integration-setup-failed-error.ts';
import {
  killProcessTree,
  killProcessTreeByPid
} from './kill-process-tree.ts';
import {
  HARNESS_TEMP_DIR_NAME,
  OWNED_USER_DATA_DIR_PREFIX,
  sweepDeviceLeftovers,
  willSweepLeftovers
} from './leftover-cleanup.ts';
import { log } from './log.ts';
import { normalizeOptionalProperties } from './normalize-optional-properties.ts';
import { getObsidianConfigDirectory } from './obsidian-config.ts';
import { resolveObsidianExecutable } from './obsidian-executable.ts';
import {
  detectInstalledShellVersion,
  ensureShellCached
} from './obsidian-installer.ts';
import { getVersionMetadata } from './obsidian-metadata.ts';
import {
  ensureAsarCached,
  findNewestAsar,
  resolveConcreteVersion
} from './obsidian-version-switch.ts';
import { compareVersions } from './obsidian-version.ts';
import { readOwnedInstanceExitMarker } from './owned-instance-exit-marker.ts';
import { buildOwnedInstanceExitedErrorFromMarker } from './owned-instance-exited-error.ts';
import {
  parsePosixLsofPids,
  parseWindowsNetstatPids
} from './port-owner.ts';
import {
  appendProcessOutputTail,
  buildProcessExitMessage
} from './process-exit-message.ts';
import { checkIsProcessAlive } from './process-liveness.ts';
import { resolveDeadBootGraceInMilliseconds } from './renderer-boot-detection.ts';
import {
  resolveAppiumSpawnFlags,
  resolveEmulatorSpawnFlags
} from './spawn-options.ts';
import {
  buildTeardownMessage,
  resolveTeardownOutcome
} from './teardown-verdict.ts';
import {
  AppiumTransport,
  DEFAULT_ANDROID_VAULT_BASE_PATH
} from './transport-appium.ts';
import { DesktopCdpTransport } from './transport-desktop-cdp.ts';
import {
  assertNever,
  ensureNonNullable
} from './type-guards.ts';
import {
  shouldHideAppiumConsole,
  shouldHideEmulatorWindow
} from './visibility.ts';
import {
  buildWedgedAppiumServerMessage,
  checkIsAppiumStatusReady,
  resolveWedgedAppiumServerRemedy
} from './wedged-appium-server.ts';

const APP_PACKAGE = 'md.obsidian';
const APP_ACTIVITY = `${APP_PACKAGE}.MainActivity`;
/*
 * How many times the AVD adoption probe asks a device which AVD it is serving.
 * One retry, because the alternative to an answer is refusing to launch: a
 * second 5s look is far cheaper than either a false refusal or the colliding
 * launch a discarded timeout used to authorize (see `avd-probe-verdict.ts`).
 */
const AVD_PROBE_ATTEMPT_COUNT = 2;
/*
 * The connectivity dump gets a budget of its OWN, well above the 5s the other
 * probes share — not because the dump is slow (measured 0.9-2.4s on a responsive
 * guest, alongside `getprop`'s 0.7-2.1s), but because it runs in the window
 * where residual post-boot contention still inflates every `adb` round-trip
 * 25-50x (L19). At 5s it overran on EVERY poll of the first end-to-end run,
 * and an overrun is reported as "no network", so too small a budget does not
 * degrade this gate — it silently disables it while the gate claims the
 * opposite. 30s is ~15x the idle cost, which is that inflation with room.
 */
const ADB_DUMPSYS_TIMEOUT_IN_MILLISECONDS = 30_000;
const APPIUM_CONNECTION_RETRY_COUNT = 3;
const APPIUM_ESCALATED_STOP_TIMEOUT_IN_MILLISECONDS = 5000;
const APPIUM_OUTPUT_TAIL_MAX_LENGTH = 8000;
const APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS = 5000;
const APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS = 500;
const APPIUM_STOP_TIMEOUT_IN_MILLISECONDS = 15_000;
const ADB_VAULT_SWEEP_TIMEOUT_IN_MILLISECONDS = 30_000;
// Appium insecure feature letting the UiAutomator2 driver auto-download a
// Chromedriver matching Obsidian's WebView Chrome version. Enabling it on the
// Appium server (it has no effect as a capability) avoids the failure
// "No Chromedriver found that can automate Chrome ...".
const CHROMEDRIVER_AUTODOWNLOAD_FEATURE = 'uiautomator2:chromedriver_autodownload';
const DEFAULT_TRANSPORT_TYPE = 'obsidian-cdp';
const ANDROID_APPIUM_TRANSPORT_TYPE: ObsidianAndroidAppiumTransportOptions['type'] = 'obsidian-android-appium';
const DEVICE_IDLE_POLL_INTERVAL_IN_MILLISECONDS = 2000;
/*
 * Budget for each of the two liveness probes taken immediately before the
 * session (see `emulator-liveness.ts`). Well above the 5s the preflight probes
 * share, because this one runs in the post-boot contention window that inflates
 * every `adb` round-trip 25-50x (L45) — and here a false "no answer" would
 * abort a run that was about to work, which is a worse error than waiting.
 * 15s is what the six hand-boots that measured the wedge used, and no healthy
 * guest came close to it: the failures hung indefinitely rather than answering
 * slowly.
 */
const DEVICE_LIVENESS_TIMEOUT_IN_MILLISECONDS = 15_000;
/*
 * How many times each liveness probe is asked before its silence is believed.
 * One retry, matching `AVD_PROBE_ATTEMPT_COUNT` and for the same reason: the
 * verdict aborts the run, so a second look is far cheaper than a wrong call.
 */
const DEVICE_LIVENESS_ATTEMPT_COUNT = 2;
/*
 * How many emulators a run may boot before giving up. One retry: the wedge that
 * motivates it is not deterministic — measured 2026-09-05, a first emulator went
 * quiet 129s in and the replacement booted 11s later ran the whole suite — but a
 * cold boot costs ~90-220s, so a second failure is where the run should stop and
 * say so rather than keep paying.
 */
const EMULATOR_BOOT_ATTEMPT_COUNT = 2;
const EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS = 120_000;
const EMULATOR_LIST_TIMEOUT_IN_MILLISECONDS = 10_000;
const EMULATOR_OUTPUT_TAIL_MAX_LENGTH = 8000;
const HTTP_MULTIPLE_CHOICES = 300;
const HTTP_OK = 200;
// The W3C default, restated because `timeouts` is set as a whole bag; no element is ever located implicitly here.
const IMPLICIT_WAIT_TIMEOUT_IN_MILLISECONDS = 0;
const KEYCODE_MENU = 82;
const KEYCODE_WAKEUP = 224;
const MILLISECONDS_PER_SECOND = 1000;
const NETWORK_READY_POLL_INTERVAL_IN_MILLISECONDS = 2000;
/*
 * How long the server waits for a new command before assuming the client quit
 * and ending the session. Appium reads `newCommandTimeout` in SECONDS, which the
 * name this constant used to carry (`COMMAND_TIMEOUT_IN_MILLISECONDS`) got
 * wrong — the value was always the intended five minutes, and only the unit in
 * the name was a lie. It is unrelated to the per-script cap, which is
 * `timeouts.script`.
 */
const NEW_COMMAND_TIMEOUT_IN_SECONDS = 300;
// The W3C default, restated for the same reason as the implicit wait above.
const PAGE_LOAD_TIMEOUT_IN_MILLISECONDS = 300_000;
const SERVER_INSTALL_TIMEOUT_IN_MILLISECONDS = 120_000;
const SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS = 120_000;
/*
 * The sync teardown runs inside `process.on('exit')`, so this query blocks the
 * exit itself. Short on purpose: losing the escalation is better than holding
 * the handler for the async path's 30s, and the sync log never claims a
 * verified stop anyway.
 */
const SYNC_TEARDOWN_QUERY_TIMEOUT_IN_MILLISECONDS = 5000;

/**
 * How the requested app (asar) version will be applied to an owned instance; at
 * most one field is set (see {@link resolveAsarPlan}).
 */
interface AsarPlan {
  /**
  The user's newest installed asar to provision as-is (no download).
   */
  readonly asar?: OwnedInstanceConfig['asar'];

  /**
  The app version to download and asar-swap onto the shell.
   */
  readonly asarVersionToSwap?: string | undefined;

  /**
  The app version whose own installer shell to download (a downgrade).
   */
  readonly downgradeInstallerVersion?: string | undefined;
}

/**
 * Outcome of one `dumpsys connectivity` probe: exactly one field is set.
 *
 * A failed probe carries **why** it failed rather than collapsing into "no
 * output", because the two failures look nothing alike in practice and only one
 * of them is worth waiting out — a 30s timeout is a contended guest, while an
 * instant `error: closed` is a dead one.
 */
interface ConnectivityProbeResult {
  /**
  Why the probe failed, set iff it did not answer.
   */
  readonly failureReason?: string | undefined;

  /**
  The raw dump, set iff the probe answered.
   */
  readonly output?: string | undefined;
}

/**
 * The two post-boot readiness budgets, carried together so the started-device
 * and reused-device branches cannot drift apart on which gates they run.
 */
interface DeviceReadinessTimeouts {
  /**
  Resolved timeout in milliseconds for the post-boot device-idle wait (`0` skips it).
   */
  readonly deviceIdleTimeoutInMilliseconds: number;

  /**
  Resolved timeout in milliseconds for the network-ready wait (`0` skips it).
   */
  readonly networkReadyTimeoutInMilliseconds: number;
}

/**
 * The emulator's captured output, carried past boot so a failure during session
 * creation can still quote it.
 *
 * Boot used to be the end of the emulator's usefulness as a witness: the capture
 * was frozen the moment a device appeared, and nothing read it again. But the
 * lines that explain a wedge — `detected a hanging thread 'QEMU2 main loop'`,
 * netsim's `Unable to reconnect to packet streamer` — are printed *after* that,
 * while the harness is inside `establishSession`. So the window now closes when
 * the session is established rather than when the device appears, and this pair
 * is what the session path needs to hold to do that (see `emulator-liveness.ts`).
 */
interface EmulatorCapture {
  /**
  Returns the captured stdout+stderr tail (bounded to the most recent output).
   */
  readonly read: () => string;

  /**
  Freezes the tail. Called once the session is established and the emulator has nothing left to explain.
   */
  readonly stop: () => void;
}

/**
 * Parameters for {@link AppiumTransportFactory.ensureDeviceConnected}.
 */
interface EnsureDeviceConnectedParams {
  /**
  AVD name to connect to (starting a new emulator if not already running).
   */
  readonly avdName: string;

  /**
  Resolved timeout in milliseconds for the post-boot device-idle wait (`0` skips it).
   */
  readonly deviceIdleTimeoutInMilliseconds: number;

  /**
  Whether the auto-started emulator window is shown (omitted → hidden).
   */
  readonly isEmulatorVisible?: boolean | undefined;

  /**
  Resolved timeout in milliseconds for the network-ready wait (`0` skips it).
   */
  readonly networkReadyTimeoutInMilliseconds: number;

  /**
  Whether the auto-started emulator may resume and refresh the AVD's boot snapshot (omitted → cold boot).
   */
  readonly shouldReuseEmulatorSnapshot?: boolean | undefined;
}

/**
 * Result of {@link AppiumTransportFactory.ensureDeviceConnected}.
 */
interface EnsureDeviceConnectedResult {
  /**
  The actual device ID that is connected (may differ from the requested one).
   */
  readonly actualDeviceId: string;

  /**
   * The emulator's output capture, when this run started it. Absent for an
   * adopted device, whose emulator this run never spawned and whose output it
   * therefore never had.
   */
  readonly emulatorCapture?: EmulatorCapture | undefined;

  /**
  The emulator process, if one was auto-started.
   */
  readonly emulatorProcess?: ChildProcess | undefined;

  /**
   * The emulator processes this run is responsible for killing — the launcher
   * plus the QEMU backend it forked, identified by diffing the host's process
   * list across the launch. Empty when the device was reused rather than
   * started. See `emulator-backend.ts` for why the launcher's PID alone is not
   * enough.
   */
  readonly ownedEmulatorPids: readonly number[];
}

/**
 * Parameters for {@link AppiumTransportFactory.establishSession}.
 */
interface EstablishSessionParams {
  /**
  The Android package the session drives.
   */
  readonly appId: string;

  /**
  The marker of the adopted server, when an earlier run of this harness left one.
   */
  readonly appiumServerMarker: AppiumServerMarker | undefined;

  /**
  Resolved timeout in milliseconds for a replacement Appium server to become ready.
   */
  readonly appiumStartTimeoutInMilliseconds: number;

  /**
  The device the session is established against.
   */
  readonly deviceId: string;

  /**
  Whether the server was adopted rather than started by this run.
   */
  readonly isAdoptedServer: boolean;

  /**
  Whether a replacement server's console window is shown (omitted → hidden).
   */
  readonly isAppiumConsoleVisible?: boolean | undefined;

  /**
  The Appium server port.
   */
  readonly port: number;

  /**
  Resolved per-script (per-`evalInObsidian`) cap in milliseconds, sent as the W3C `timeouts.script` capability.
   */
  readonly scriptTimeoutInMilliseconds: number;

  /**
  Resolved WebDriverIO connection retry timeout in milliseconds.
   */
  readonly sessionConnectionRetryTimeoutInMilliseconds: number;

  /**
  Whether Appium auto-start is allowed — a `false` here also forbids replacing a wedged server.
   */
  readonly shouldAutoStartAppium?: boolean | undefined;

  /**
  The Appium server URL.
   */
  readonly url: URL;
}

/**
 * Result of {@link AppiumTransportFactory.establishSession}.
 */
interface EstablishSessionResult {
  /**
  The replacement Appium server process, when a wedged one had to be restarted.
   */
  readonly appiumProcess?: ChildProcess | undefined;

  /**
  The established session.
   */
  readonly browser: Awaited<ReturnType<typeof remote>>;
}

/**
 * The locally-installed Obsidian shell resolved by {@link resolveInstalledShellOrNull}.
 */
interface InstalledShell {
  /**
  Absolute path to the installed shell executable.
   */
  readonly exePath: string;

  /**
  The detected shell version, or `undefined` when it cannot be determined.
   */
  readonly shellVersion: string | undefined;
}

/**
 * A spawned child process (the Android emulator or the Appium server) together
 * with helpers to inspect its captured output and exit status.
 */
interface ParsePortOwnerPidsParams {
  /**
  Raw stdout of the platform's port query.
   */
  readonly output: string;

  /**
  The port that was queried.
   */
  readonly port: number;
}

interface ProcessLaunch {
  /**
  The spawned process.
   */
  process: ChildProcess;

  /**
  Returns the exit / spawn-failure details once the process is no longer running, otherwise `undefined`.
   */
  readExitInfo: () => ProcessExitInfo | undefined;

  /**
  Returns the captured stdout+stderr (bounded to the most recent output).
   */
  readOutput: () => string;

  /**
  Stops accumulating output. Call once startup has succeeded.
   */
  stopCapture: () => void;
}

/**
 * Parameters for {@link AppiumTransportFactory.startAppiumAndEmulator}.
 */
interface ReclaimUnstoppedAppiumServerParams {
  /**
  The marker that proves the leftover is this harness's own.
   */
  readonly marker: AppiumServerMarker;

  /**
  The port it is holding.
   */
  readonly port: number;

  /**
  Whether this run is allowed to start a replacement.
   */
  readonly shouldAutoStartAppium?: boolean | undefined;

  /**
  The server's URL.
   */
  readonly url: URL;
}

/**
 * Parameters for {@link AppiumTransportFactory.recordEmulatorLaunchDevice}.
 */
interface RecordEmulatorLaunchDeviceParams {
  /**
  The AVD whose launch was recorded.
   */
  readonly avdName: string;

  /**
  The device that has just appeared in ADB.
   */
  readonly deviceId: string;

  /**
  When the emulator was launched — what identifies the launch this device belongs to.
   */
  readonly launchedAtInMilliseconds: number;
}

/**
 * Parameters for {@link AppiumTransportFactory.recordEmulatorLaunch}.
 */
interface RecordEmulatorLaunchParams {
  /**
  The AVD being started.
   */
  readonly avdName: string;

  /**
  The launcher just spawned for it.
   */
  readonly emulator: ProcessLaunch;

  /**
  When it was launched, which every later write of this marker keeps.
   */
  readonly launchedAtInMilliseconds: number;

  /**
  The emulator processes that predate the launch, so the backend it forks can be identified without a second snapshot.
   */
  readonly preLaunchEmulatorPids: readonly number[];
}

interface StartAppiumAndEmulatorParams {
  /**
  Resolved timeout in milliseconds for the auto-started Appium server to become ready.
   */
  readonly appiumStartTimeoutInMilliseconds: number;

  /**
  The Appium server URL.
   */
  readonly appiumUrl: URL;

  /**
  AVD name to start.
   */
  readonly avdName: string;

  /**
  Resolved timeout in milliseconds for the post-boot device-idle wait (`0` skips it).
   */
  readonly deviceIdleTimeoutInMilliseconds: number;

  /**
  Whether the auto-started Appium server console window is shown (omitted → hidden).
   */
  readonly isAppiumConsoleVisible?: boolean | undefined;

  /**
  Whether the auto-started emulator window is shown (omitted → hidden).
   */
  readonly isEmulatorVisible?: boolean | undefined;

  /**
  Resolved timeout in milliseconds for the network-ready wait (`0` skips it).
   */
  readonly networkReadyTimeoutInMilliseconds: number;

  /**
  The Appium server port.
   */
  readonly port: number;

  /**
  Whether missing Appium dependencies may be auto-installed before the server is auto-started.
   */
  readonly shouldAutoInstallAppiumDependencies: boolean;

  /**
  Whether Appium auto-start is allowed.
   */
  readonly shouldAutoStartAppium?: boolean | undefined;

  /**
  Whether the auto-started emulator may resume and refresh the AVD's boot snapshot (omitted → cold boot).
   */
  readonly shouldReuseEmulatorSnapshot?: boolean | undefined;
}

/**
 * Result of {@link AppiumTransportFactory.startAppiumAndEmulator}.
 */
interface StartAppiumAndEmulatorResult {
  /**
  The actual device ID that is connected (may differ from the requested one).
   */
  readonly actualDeviceId: string;

  /**
  The Appium server process, if one was auto-started.
   */
  readonly appiumProcess?: ChildProcess | undefined;

  /**
  The adopted server's marker, when an earlier run of this harness left one.
   */
  readonly appiumServerMarker?: AppiumServerMarker | undefined;

  /**
  The emulator's output capture, when this run started it.
   */
  readonly emulatorCapture?: EmulatorCapture | undefined;

  /**
  The emulator process, if one was auto-started.
   */
  readonly emulatorProcess?: ChildProcess | undefined;

  /**
   * Whether an already-listening server was adopted rather than started by this
   * run. Only an adopted server can be the stale one `wedged-appium-server.ts`
   * describes.
   */
  readonly isAdoptedAppiumServer: boolean;

  /**
  The emulator processes this run is responsible for killing; empty when the device was reused.
   */
  readonly ownedEmulatorPids: readonly number[];
}

/**
 * Parameters for {@link AppiumTransportFactory.sweepDeviceLeftoverVaults}.
 */
interface StopAutoStartedAppiumServerParams {
  /**
  The server process this run spawned.
   */
  readonly appiumProcess: ChildProcess;

  /**
  The port it was started on, whose marker is cleared or stamped by the outcome.
   */
  readonly port: number;

  /**
  The server's URL, polled to decide whether it actually stopped.
   */
  readonly url: URL;
}

interface StopAutoStartedProcessesParams {
  /**
  The Appium server process, when this run started one.
   */
  readonly appiumProcess?: ChildProcess | undefined;

  /**
  The AVD name, for the emulator's warning.
   */
  readonly avdName: string;

  /**
  The device the emulator is serving, when this run started one.
   */
  readonly deviceId?: string | undefined;

  /**
  The emulator launcher process, when this run started one.
   */
  readonly emulatorProcess?: ChildProcess | undefined;

  /**
  The emulator PIDs this run owns — started, or taken over as a leftover. Non-empty means the emulator is this run's to stop.
   */
  readonly ownedEmulatorPids: readonly number[];

  /**
  The Appium port.
   */
  readonly port: number;

  /**
  The Appium server URL.
   */
  readonly url: URL;
}

interface StopEmulatorAfterFailedStartParams {
  /**
  The AVD the emulator was started for.
   */
  readonly avdName: string;

  /**
  The online devices listed before the launch.
   */
  readonly deviceIdsBefore: readonly string[];

  /**
  The launch that failed.
   */
  readonly emulator: ProcessLaunch;

  /**
  The emulator processes that predate the launch, and are therefore not this run's.
   */
  readonly emulatorPidsBefore: readonly number[];
}

interface SweepDeviceLeftoverVaultsParams {
  /**
  The device UDID to sweep.
   */
  readonly deviceId: string;

  /**
  The device-side directory Obsidian Mobile stores its vaults in.
   */
  readonly vaultBasePath: string;
}

let cachedTransport: ObsidianTransport | undefined;

/**
 * Parameters for {@link resolveAndReportCompatibility}.
 */
interface ResolveAndReportCompatibilityParams {
  /**
   * The app (asar) version that will be swapped onto the shell, or `undefined`
   * when no asar-swap will happen (nothing is checked then).
   */
  readonly appVersion: string | undefined;

  /**
  The resolved installer/shell version, or `undefined`.
   */
  readonly installerVersion: string | undefined;

  /**
   * Whether an `'unrunnable'` verdict throws {@link IncompatibleInstallerVersionError}
   * (`true`) or proceeds to launch with the verdict surfaced as data (`false`).
   */
  readonly shouldThrowOnIncompatibleInstaller: boolean;

  /**
  Whether a `'nagged'` (or proceeding-`'unrunnable'`) verdict is logged.
   */
  readonly shouldWarnOnCompatibilityIssues: boolean;
}

/**
 * The slice of `webdriverio`'s surface the Appium factory calls, named so the
 * lazy load has a return type without a static import of the module itself.
 */
interface WebdriverioModule {
  /**
  Reattaches to an existing WebDriver session.
   */
  readonly attach: typeof attach;

  /**
  Creates a new WebDriver session.
   */
  readonly remote: typeof remote;
}

/**
 * Encapsulates all Appium transport creation logic, including Appium server
 * startup, emulator management, and WebDriverIO session establishment.
 *
 * Using a class avoids threading the transport `type` label through every
 * helper function — `this.log()` automatically prefixes it.
 */
class AppiumTransportFactory {
  private readonly emulators: EmulatorReclaimer;
  private readonly type: string;

  public constructor(type: string) {
    this.type = type;
    this.emulators = new EmulatorReclaimer((message) => {
      this.log(message);
    });
  }

  /**
   * Creates an Appium transport by establishing a WebDriverIO session.
   *
   * If `options.sessionId` is present, reattaches to the existing session
   * instead of creating a new one. This avoids duplicate Appium/ADB connections
   * when test workers reuse the global setup's session.
   *
   * @param options - Android Appium transport options.
   * @returns A configured Appium transport.
   */
  public async create(options: ObsidianAndroidAppiumTransportOptions): Promise<ObsidianTransport> {
    if (options.sessionId !== undefined && options.deviceId !== undefined) {
      return this.attachToExistingSession(options.sessionId, options.deviceId, options);
    }

    return this.createNewSession(options);
  }

  /**
   * Arms the emulator reaper (`emulator-reaper.ts`) for an emulator this run has
   * just recorded as its own.
   *
   * @param avdName - The AVD whose marker was just written.
   * @param startedAtInMilliseconds - The emulator's launch time, as the marker records it.
   */
  private armEmulatorReaper(avdName: string, startedAtInMilliseconds: number): void {
    spawnEmulatorReaper({
      avdName,
      log: (message) => {
        this.log(message);
      },
      startedAtInMilliseconds
    });
  }

  private async attachToExistingSession(
    sessionId: string,
    deviceId: string,
    options: ObsidianAndroidAppiumTransportOptions
  ): Promise<ObsidianTransport> {
    const url = new URL(options.appiumUrl);
    const port = Number(url.port);
    const appId = options.appId ?? APP_PACKAGE;

    this.log(`Reattaching to existing Appium session ${sessionId} (device=${deviceId})`);

    const { attach } = await importWebdriverio();
    const browser = await attach({
      capabilities: {
        platformName: 'Android'
      },
      hostname: url.hostname,
      logLevel: 'warn',
      path: url.pathname,
      port,
      sessionId,
      transformRequest: stripForbiddenFetchHeaders
    });

    this.log('Reattached to Appium session.');

    return new AppiumTransport({
      appId,
      browser,
      deviceId,
      isSessionOwner: false,
      platform: 'android',
      // The session this reattaches to was created with the same resolution, so the number reported on a
      // Script timeout is the one that session is actually enforcing.
      scriptTimeoutInMilliseconds: resolveScriptTimeoutInMilliseconds(options),
      shouldSweepLeftovers: willSweepLeftovers(options),
      ...(options.appStartTimeoutInMilliseconds !== undefined && { appStartTimeoutInMilliseconds: options.appStartTimeoutInMilliseconds }),
      ...(options.layoutReadyTimeoutInMilliseconds !== undefined && { layoutReadyTimeoutInMilliseconds: options.layoutReadyTimeoutInMilliseconds }),
      ...(options.vaultBasePath !== undefined && { vaultBasePath: options.vaultBasePath }),
      ...(options.webviewTimeoutInMilliseconds !== undefined && { webviewTimeoutInMilliseconds: options.webviewTimeoutInMilliseconds })
    });
  }

  private buildWedgedMessage(params: EstablishSessionParams, reason: WedgedAppiumServerReportReason): string {
    const marker = params.appiumServerMarker;
    return buildWedgedAppiumServerMessage({
      appiumOrigin: params.url.origin,
      deviceId: params.deviceId,
      reason,
      ...(marker !== undefined && {
        serverAgeInMilliseconds: Date.now() - marker.startedAtInMilliseconds,
        serverPid: marker.pid
      })
    });
  }

  /**
   * Preflight probe for an already-running server.
   *
   * Liveness is not readiness: resolving on *any* response adopts a server that
   * is refusing sessions (a non-2xx `/status`, or one that reports itself
   * shutting down) exactly like a healthy one. Rejecting instead hands those
   * cases to the auto-start path. It cannot catch the wedged server of
   * `wedged-appium-server.ts` — that one answers `ready: true` — which is why
   * the wedge is recognized from the failed session instead.
   *
   * @param url - The Appium server URL.
   */
  private checkAppiumReachable(url: URL): Promise<void> {
    return new Promise((resolve, reject) => {
      const statusUrl = new URL('/status', url);
      /*
       * `agent: false` — never a pooled socket. The global agent keeps sockets
       * alive per host:port, so a probe after a server on that port was replaced
       * can reuse the dead socket and fail with `ECONNRESET` regardless of what
       * is listening now. That would make `waitForAppiumStopped` call a live
       * server dead, and it is exactly the sequence the wedged-server restart
       * performs. A fresh socket per probe costs nothing at this frequency.
       */
      const request = http.get(statusUrl, { agent: false, timeout: APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS }, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < HTTP_OK || statusCode >= HTTP_MULTIPLE_CHOICES) {
          response.resume();
          reject(new Error(`Appium server at ${url.origin} answered /status with HTTP ${String(statusCode)}; it is not accepting sessions.`));
          return;
        }

        response.setEncoding('utf-8');
        let body = '';
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          if (checkIsAppiumStatusReady(body)) {
            resolve();
            return;
          }

          reject(new Error(`Appium server at ${url.origin} reports it is not ready to accept new connections.`));
        });
      });
      request.on('timeout', () => {
        request.destroy();
        reject(
          new Error(
            `Appium server at ${url.origin} did not respond within ${String(APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS)}ms. Is the Appium server running?`
          )
        );
      });
      request.on('error', (error) => {
        reject(
          new Error(
            `Cannot reach Appium server at ${url.origin}: ${error.message}. Is the Appium server running?`
          )
        );
      });
    });
  }

  /**
   * Waits out the Appium port and reports whether it went quiet, rather than
   * throwing as {@link waitForAppiumStopped} does.
   *
   * @param url - The Appium server URL.
   * @param timeoutInMilliseconds - How long to wait.
   * @returns `true` when nothing answers on the port any more.
   */
  private async checkIsAppiumStopped(url: URL, timeoutInMilliseconds: number): Promise<boolean> {
    try {
      await this.waitForAppiumStopped(url, timeoutInMilliseconds);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks whether adb still lists the device **in any state**, without letting
   * an adb that itself fails count as evidence.
   *
   * Any state, not just `device`: a dying emulator answers `offline` while it is
   * still the thing that is wrong (the distinction `adb-device-list.ts` draws
   * for teardown, and the reasoning carries over). Reading `offline` as gone
   * here would report `device-gone` for what is really a wedge, sending the
   * reader to look for a vanished emulator that is in fact still sitting there.
   *
   * @param deviceId - The device to look for.
   * @returns `true` when it is listed; `false` when it is not, or adb could not be run.
   */
  private async checkIsDeviceListedQuietly(deviceId: string): Promise<boolean> {
    try {
      return checkIsDeviceListed({ deviceId, devicesOutput: await this.emulators.getDevicesOutput() });
    } catch (error: unknown) {
      this.log(`Could not re-check the device listing: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async connectSession(params: EstablishSessionParams): Promise<Awaited<ReturnType<typeof remote>>> {
    const { remote } = await importWebdriverio();
    return remote({
      capabilities: {
        'appium:appActivity': APP_ACTIVITY,
        'appium:appPackage': params.appId,
        'appium:autoGrantPermissions': true,
        'appium:automationName': 'UiAutomator2',
        'appium:newCommandTimeout': NEW_COMMAND_TIMEOUT_IN_SECONDS,
        'appium:noReset': true,
        'appium:udid': params.deviceId,
        'appium:uiautomator2ServerInstallTimeout': SERVER_INSTALL_TIMEOUT_IN_MILLISECONDS,
        'appium:uiautomator2ServerLaunchTimeout': SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS,
        'platformName': 'Android',
        /*
         * `script` is declared so the per-closure cap is a number this harness owns and states, but the
         * Declaration is NOT what enforces it: UiAutomator2 was measured accepting this, reporting it
         * Back as 30000 from the WebView context, and never acting on it — over-cap closures ran past a
         * 60s ceiling without one `script timeout`. `AppiumTransport.evaluate` enforces the same number
         * Node-side, and this stays because it is free, it is the honest declaration of the intended
         * Budget, and it would start working on its own if a future driver honoured it. The other two are
         * Restated at their W3C defaults only because the capability is all-or-nothing — WebDriverIO's
         * `Timeouts` type has no partial form — so they change nothing.
         */
        'timeouts': {
          implicit: IMPLICIT_WAIT_TIMEOUT_IN_MILLISECONDS,
          pageLoad: PAGE_LOAD_TIMEOUT_IN_MILLISECONDS,
          script: params.scriptTimeoutInMilliseconds
        }
      },
      connectionRetryCount: APPIUM_CONNECTION_RETRY_COUNT,
      connectionRetryTimeout: params.sessionConnectionRetryTimeoutInMilliseconds,
      hostname: params.url.hostname,
      logLevel: 'warn',
      path: params.url.pathname,
      port: params.port,
      transformRequest: stripForbiddenFetchHeaders
    });
  }

  private async createNewSession(options: ObsidianAndroidAppiumTransportOptions): Promise<ObsidianTransport> {
    this.log(`Creating AppiumTransport (url=${options.appiumUrl}, avd=${options.avdName})`);

    const url = new URL(options.appiumUrl);

    const port = Number(url.port);
    if (Number.isNaN(port)) {
      throw new TypeError(`Invalid port in appiumUrl: ${url.port}`);
    }

    const appId = options.appId ?? APP_PACKAGE;

    let actualDeviceId: string | undefined;
    let appiumProcess: ChildProcess | undefined;
    let emulatorProcess: ChildProcess | undefined;
    let ownedEmulatorPids: readonly number[] = [];

    let result: StartAppiumAndEmulatorResult | undefined;

    try {
      /*
       * Provision, then check the device is still answering — and when it is not
       * and the emulator is ours, boot a fresh one instead of carrying on.
       *
       * A wedge is NOT deterministic, which is what justifies the retry. In the
       * run that proved it (2026-09-05) the first emulator went quiet 129s in and
       * the second, booted 11s later from the same AVD with the same arguments,
       * established a session and drove the WebView to completion. An earlier
       * draft of this work argued the opposite from the hand-boot data — that a
       * re-boot buys the same failure 90s later — and that was simply wrong:
       * every hand-boot was a first boot, so the data said nothing about second
       * ones.
       */
      for (let attempt = 1; attempt <= EMULATOR_BOOT_ATTEMPT_COUNT; attempt++) {
        result = await this.startAppiumAndEmulator({
          appiumStartTimeoutInMilliseconds: resolveAppiumStartTimeoutInMilliseconds(options),
          appiumUrl: url,
          avdName: options.avdName,
          deviceIdleTimeoutInMilliseconds: resolveDeviceIdleTimeoutInMilliseconds(options),
          isAppiumConsoleVisible: options.isAppiumConsoleVisible,
          isEmulatorVisible: options.isEmulatorVisible,
          networkReadyTimeoutInMilliseconds: resolveNetworkReadyTimeoutInMilliseconds(options),
          port,
          shouldAutoInstallAppiumDependencies: willAutoInstallAppiumDependencies(options),
          shouldAutoStartAppium: options.shouldAutoStartAppium,
          shouldReuseEmulatorSnapshot: options.shouldReuseEmulatorSnapshot
        });

        /*
         * Only ever REPLACE this handle, never clear it. The retry leaves this
         * run's Appium server running and swaps only the emulator, so the second
         * pass finds that server reachable, ADOPTS it, and returns no process
         * handle. Writing that `undefined` over the handle from the first pass
         * would orphan the very server this run started — the leak L46 exists to
         * prevent, reintroduced by the retry.
         */
        if (result.appiumProcess !== undefined) {
          appiumProcess = result.appiumProcess;
        }
        emulatorProcess = result.emulatorProcess;
        ownedEmulatorPids = result.ownedEmulatorPids;
        actualDeviceId = result.actualDeviceId;

        /*
         * Before `remote()` launches Obsidian — the last point at which nothing
         * has to enumerate the device's vaults yet.
         */
        if (willSweepLeftovers(options)) {
          await this.sweepDeviceLeftoverVaults({
            deviceId: actualDeviceId,
            vaultBasePath: options.vaultBasePath ?? DEFAULT_ANDROID_VAULT_BASE_PATH
          });
        }

        /*
         * The last point at which a device that has gone quiet can still be
         * reported as itself. Past here the failure belongs to Appium, which can
         * only say the device is "not in the list of connected devices" — an
         * error that names the one thing that is not wrong.
         */
        const diagnosis = await this.diagnoseDevice(actualDeviceId, result.emulatorCapture);
        if (diagnosis === undefined) {
          break;
        }

        /*
         * Only an emulator this run owns may be replaced — one it started, or a
         * leftover of this harness it took over. A device that was merely
         * adopted (`ownedEmulatorPids` empty) is somebody else's to restart —
         * the same ownership line teardown draws in never sweeping `qemu*`.
         */
        const ownedEmulatorProcess = emulatorProcess;
        const canRetry = attempt < EMULATOR_BOOT_ATTEMPT_COUNT && ownedEmulatorPids.length > 0;
        if (!canRetry) {
          throw new Error(diagnosis);
        }

        this.log(`${diagnosis}\n\nBooting a fresh emulator and trying once more (attempt ${String(attempt + 1)} of ${String(EMULATOR_BOOT_ATTEMPT_COUNT)}).`);
        /*
         * Disown BEFORE stopping, not after: this run hands the emulator over to
         * `stopEmulator` and must not still be holding it if that throws, or the
         * outer catch's teardown would go after the same processes a second
         * time.
         */
        const doomedDeviceId = actualDeviceId;
        const doomedPids = ownedEmulatorPids;
        emulatorProcess = undefined;
        ownedEmulatorPids = [];
        actualDeviceId = undefined;
        await this.emulators.stopEmulator({
          avdName: options.avdName,
          deviceId: doomedDeviceId,
          emulatorProcess: ownedEmulatorProcess,
          ownedEmulatorPids: doomedPids
        });
      }

      if (result === undefined || actualDeviceId === undefined) {
        throw new Error(`Could not provision an Android device for AVD "${options.avdName}".`);
      }

      const sessionResult = await this.establishSessionOrDiagnoseDevice(result.emulatorCapture, {
        appId,
        appiumServerMarker: result.appiumServerMarker,
        appiumStartTimeoutInMilliseconds: resolveAppiumStartTimeoutInMilliseconds(options),
        deviceId: actualDeviceId,
        isAdoptedServer: result.isAdoptedAppiumServer,
        isAppiumConsoleVisible: options.isAppiumConsoleVisible,
        port,
        scriptTimeoutInMilliseconds: resolveScriptTimeoutInMilliseconds(options),
        sessionConnectionRetryTimeoutInMilliseconds: resolveSessionConnectionRetryTimeoutInMilliseconds(options),
        shouldAutoStartAppium: options.shouldAutoStartAppium,
        url
      });

      const browser = sessionResult.browser;
      // A wedged adopted server is replaced by one this run owns, so it must be torn down like any other auto-started server.
      if (sessionResult.appiumProcess !== undefined) {
        appiumProcess = sessionResult.appiumProcess;
      }

      this.log('Appium session established.');
      /*
       * The emulator has nothing left to explain, so freeze its tail here rather
       * than at boot. Everything up to this line — including the window in which
       * a wedge surfaces — is now inside the captured output.
       */
      result.emulatorCapture?.stop();
      const appiumTransport = new AppiumTransport({
        appId,
        browser,
        deviceId: actualDeviceId,
        platform: 'android',
        // The same number the session was created with above, so a script timeout reports the cap that killed it.
        scriptTimeoutInMilliseconds: resolveScriptTimeoutInMilliseconds(options),
        shouldSweepLeftovers: willSweepLeftovers(options),
        ...(options.appStartTimeoutInMilliseconds !== undefined && { appStartTimeoutInMilliseconds: options.appStartTimeoutInMilliseconds }),
        ...(options.layoutReadyTimeoutInMilliseconds !== undefined && { layoutReadyTimeoutInMilliseconds: options.layoutReadyTimeoutInMilliseconds }),
        ...(options.vaultBasePath !== undefined && { vaultBasePath: options.vaultBasePath }),
        ...(options.webviewTimeoutInMilliseconds !== undefined && { webviewTimeoutInMilliseconds: options.webviewTimeoutInMilliseconds })
      });

      const originalDispose = appiumTransport.dispose.bind(appiumTransport);
      const transport: ObsidianTransport = appiumTransport;
      transport.dispose = async (): Promise<void> => {
        try {
          await originalDispose();
        } finally {
          await this.stopAutoStartedProcessesVerified(buildStopParams());
        }
      };

      // Chain rather than replace: the transport's own sync teardown drops the trusted-input channel's
      // Adb port forward, which would otherwise be stranded on the device by an abrupt exit.
      const originalDisposeSync = appiumTransport.disposeSync.bind(appiumTransport);
      transport.disposeSync = (): void => {
        try {
          originalDisposeSync();
        } finally {
          this.stopAutoStartedProcessesBestEffort(buildStopParams());
        }
      };

      return transport;
    } catch (error: unknown) {
      await this.stopAutoStartedProcessesVerified(buildStopParams());
      throw error;
    }

    function buildStopParams(): StopAutoStartedProcessesParams {
      return {
        appiumProcess,
        avdName: options.avdName,
        deviceId: actualDeviceId,
        emulatorProcess,
        ownedEmulatorPids,
        port,
        url
      };
    }
  }

  /**
   * Describes an adopted server's provenance for the preflight log, so a stale
   * leftover is visible in the transcript of a run that goes on to succeed — not
   * only in the error of one that fails.
   *
   * @param marker - The marker read for the port, if any.
   * @returns A short provenance description.
   */
  private describeAdoptedServer(marker: AppiumServerMarker | undefined): string {
    if (!marker || !checkIsHarnessOwnedAppiumServer(marker)) {
      return 'not started by this harness';
    }

    const ageInSeconds = Math.round((Date.now() - marker.startedAtInMilliseconds) / MILLISECONDS_PER_SECOND);
    const unstoppedSuffix = marker.stopAttemptedAtInMilliseconds === undefined ? '' : ', and an earlier run failed to stop it';
    return `started by an earlier run of this harness, pid ${String(marker.pid)}, up for ${String(ageInSeconds)}s${unstoppedSuffix}`;
  }

  /**
   * Probes the device and returns the failure message when it is no longer
   * usable, or `undefined` when it is fine.
   *
   * The readiness gates that run before this one are deliberately best-effort —
   * they warn and proceed — so nothing asked whether the device was still there
   * at the moment it mattered. A guest that went quiet in the meantime was
   * handed to Appium, which reported `Device <id> was not in the list of
   * connected devices`; `adb devices` then listed it, and the trail went cold.
   *
   * The second probe is only paid for when the first one fails, and the verdict
   * distinguishes a frozen guest from an unreachable emulator — see
   * `emulator-liveness.ts` for the measurements behind that split.
   *
   * Returning the message rather than throwing it is what lets both callers use
   * the same diagnosis: the provisioning loop decides whether to boot a fresh
   * emulator, and the session path needs its own error to survive as the
   * `cause`.
   *
   * @param deviceId - The device to probe.
   * @param emulatorCapture - The emulator's output, when this run started it.
   * @returns The diagnosis, or `undefined` when the device still answers.
   */
  private async diagnoseDevice(deviceId: string, emulatorCapture?: EmulatorCapture): Promise<string | undefined> {
    const shellProbe = await this.probeDeviceShell(deviceId);
    if (shellProbe === 'answered') {
      return undefined;
    }

    this.log(`Device ${deviceId} did not answer \`adb -s ${deviceId} shell\`; checking whether the emulator itself is still alive...`);
    const [consoleProbe, isListedByAdb] = await Promise.all([
      this.probeEmulatorConsole(deviceId),
      this.checkIsDeviceListedQuietly(deviceId)
    ]);

    const verdict = resolveEmulatorLivenessVerdict({
      consoleProbe,
      deviceId,
      isListedByAdb,
      shellProbe
    });
    this.log(`Device liveness: ${deviceId} shell=${shellProbe}, console=${consoleProbe} -> ${verdict}.`);

    // Unreachable in practice — the verdict is only `'alive'` when the shell answered, which returned above — but it is what narrows the type for the builder.
    if (verdict === 'alive') {
      return undefined;
    }

    return buildEmulatorLivenessMessage({
      deviceId,
      emulatorOutput: emulatorCapture?.read() ?? '',
      probeTimeoutInMilliseconds: DEVICE_LIVENESS_TIMEOUT_IN_MILLISECONDS,
      verdict
    });
  }

  private dumpConnectivity(deviceId: string): Promise<ConnectivityProbeResult> {
    return new Promise((resolve) => {
      execFile(
        'adb',
        ['-s', deviceId, 'shell', 'dumpsys', 'connectivity'],
        { maxBuffer: ADB_DUMPSYS_MAX_BUFFER_IN_BYTES, timeout: ADB_DUMPSYS_TIMEOUT_IN_MILLISECONDS },
        (error, stdout, stderr) => {
          /*
           * A failure carries its reason, NOT an empty string. The other probes
           * collapse a failure into empty output because there "empty" and
           * "failed" both mean not-idle, but here they mean different things and
           * only one of them is about the network: a probe that never answers
           * must not be reported as a guest without a route.
           */
          if (!error) {
            resolve({ output: stdout });
            return;
          }

          const detail = (stderr.trim() || error.message.trim()).split('\n', 1)[0] ?? '';
          resolve({
            failureReason: error.killed
              ? `no answer within ${String(ADB_DUMPSYS_TIMEOUT_IN_MILLISECONDS)}ms`
              : detail || 'adb failed with no message'
          });
        }
      );
    });
  }

  /**
   * Ensures the Appium toolchain is present before the server is auto-started:
   * Appium itself, then the `uiautomator2` driver. Each is checked first and
   * installed only when missing, so a fully-provisioned machine incurs just two
   * fast version/list probes.
   *
   * Only invoked when the harness is about to auto-start the server and
   * {@link ObsidianAndroidAppiumTransportOptions.shouldAutoInstallAppiumDependencies}
   * is enabled. Commands are passed as strings so `exec` runs them through the
   * shell, which resolves the `npm`/`npx` `.cmd` shims on Windows (the array
   * path spawns without a shell and cannot).
   */
  private async ensureAppiumDependencies(): Promise<void> {
    await this.ensureAppiumInstalled();
    await this.ensureUiautomator2DriverInstalled();
  }

  private async ensureAppiumInstalled(): Promise<void> {
    this.log('Checking whether Appium is installed...');
    const result = await exec('npx --no-install appium --version', {
      isQuiet: true,
      shouldIgnoreExitCode: true,
      shouldIncludeDetails: true
    });

    if (result.exitCode === 0) {
      this.log(`Appium is installed (version ${result.stdout.trim() || 'unknown'}).`);
      return;
    }

    this.log('Appium is not installed. Installing globally via `npm install -g appium`...');
    await exec('npm install -g appium');

    /*
     * Re-verify: a global install can land under an npm prefix whose bin dir is
     * not on the spawn PATH (e.g. a scoop/nvm-managed prefix), in which case
     * `npx --no-install appium` still cannot resolve it. Fail fast with an
     * actionable message rather than proceeding to auto-start a server that can
     * never come up (which would otherwise spin out the full readiness timeout).
     */
    const verify = await exec('npx --no-install appium --version', {
      isQuiet: true,
      shouldIgnoreExitCode: true,
      shouldIncludeDetails: true
    });
    if (verify.exitCode !== 0) {
      throw new Error(
        'Appium was installed via `npm install -g appium` but is still not resolvable via `npx --no-install appium`. '
          + 'The npm global bin directory (see `npm config get prefix`) is likely not on PATH. Add it to PATH, or set '
          + '`shouldAutoInstallAppiumDependencies: false` and install/manage Appium yourself.'
      );
    }
    this.log(`Appium installed (version ${verify.stdout.trim() || 'unknown'}).`);
  }

  /**
   * Fails fast when the requested AVD does not exist, before an emulator is
   * spawned.
   *
   * Without this preflight a missing AVD name is only discovered after
   * {@link startEmulator} spawns `emulator -avd <name>` and the boot never
   * completes — a full {@link EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS} spin ending
   * in a generic "no new device appeared". Instead this lists the configured
   * AVDs up front and throws an actionable error naming the available ones. AVD
   * creation is deliberately not automated (it requires a system-image download,
   * license acceptance, and hardware/API-level choices).
   *
   * @param avdName - The requested AVD name.
   */
  private async ensureAvdExists(avdName: string): Promise<void> {
    const emulatorBinary = resolveEmulatorBinaryPath();
    this.log(`Verifying AVD "${avdName}" exists (${emulatorBinary} -list-avds)...`);

    const [error, stdout] = await new Promise<[Error | null, string]>((resolve) => {
      execFile(emulatorBinary, ['-list-avds'], { timeout: EMULATOR_LIST_TIMEOUT_IN_MILLISECONDS }, (execError, execStdout) => {
        resolve([execError, execStdout]);
      });
    });

    if (error) {
      throw new Error(
        `Failed to list AVDs via \`${emulatorBinary} -list-avds\`: ${error.message}. `
          + 'Is the Android SDK emulator installed and ANDROID_HOME/ANDROID_SDK_ROOT correct?'
      );
    }

    if (!checkAvdExists({ avdListOutput: stdout, avdName })) {
      const available = listAvailableAvds(stdout);
      throw new Error(
        `Android AVD "${avdName}" not found. Available AVDs: ${available.length > 0 ? available.join(', ') : '(none)'}. `
          + 'Create it (e.g. in the Android Studio Device Manager, or via `avdmanager create avd`), or set `avdName` to an existing AVD.'
      );
    }

    this.log(`AVD "${avdName}" exists.`);
  }

  private async ensureDeviceConnected(params: EnsureDeviceConnectedParams): Promise<EnsureDeviceConnectedResult> {
    const { avdName, deviceIdleTimeoutInMilliseconds, isEmulatorVisible, networkReadyTimeoutInMilliseconds } = params;
    const timeouts: DeviceReadinessTimeouts = { deviceIdleTimeoutInMilliseconds, networkReadyTimeoutInMilliseconds };
    /*
     * Before the device listing, so a leftover stopped here is not listed. Only
     * OTHER AVDs: a leftover of this one is worth adopting (and owning) below.
     * This is the sequence that filled the drive: a leaked `obsidian_test` sat
     * beside every later run, each of which probed it as `other-avd`, booted
     * its own emulator next to it, and left it running.
     */
    await this.emulators.reclaimLeftoverEmulators({ exceptAvdName: avdName, scope: 'preflight' });
    const deviceIdsBefore = await this.getConnectedDeviceIds();
    this.log(`Checking existing devices for AVD "${avdName}"... (connected: [${deviceIdsBefore.join(', ')}])`);

    const probeResults = await this.probeDevicesForAvd(avdName, deviceIdsBefore);
    this.log(`AVD probe: ${buildAvdProbeSummary(probeResults)}.`);
    const probeVerdict = resolveAvdProbeVerdict(probeResults);

    switch (probeVerdict.verdict) {
      case 'refuse': {
        /*
         * Silence is not a skip. Falling through to a launch here is what
         * produced `FATAL | Running multiple emulators with the same AVD` —
         * see `avd-probe-verdict.ts` for the run this reproduces.
         */
        throw new Error(buildUnreadableDevicesMessage({
          avdName,
          probeTimeoutInMilliseconds: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS,
          unreadableDeviceIds: probeVerdict.unreadableDeviceIds
        }));
      }
      case 'reuse': {
        return await this.reuseConnectedDevice(avdName, probeVerdict.deviceId, timeouts);
      }
      case 'start-new': {
        break;
      }
      default: {
        return assertNever(probeVerdict);
      }
    }

    this.log(`AVD "${avdName}" not found on any existing device, starting a new emulator...`);
    await this.ensureAvdExists(avdName);
    /*
     * Snapshot the emulator processes that predate this launch, so the ones that
     * appear across it can be identified as OURS. The launcher's PID is not
     * enough to kill: under `-no-window` the process that holds the AVD is the
     * `qemu-system-*-headless` backend it forks, which survives a `taskkill /T`
     * of the launcher (see `emulator-backend.ts`). Diffing here — rather than
     * sweeping `qemu*` at teardown — is what keeps the harness from killing
     * somebody else's emulator.
     */
    const emulatorPidsBefore = await this.listEmulatorBackendPids([]);
    const shouldReuseSnapshot = params.shouldReuseEmulatorSnapshot === true;
    if (shouldReuseSnapshot) {
      this.logSnapshotAge(avdName);
    }
    const launchedAtInMilliseconds = Date.now();
    const emulator = this.startEmulator(avdName, shouldReuseSnapshot, isEmulatorVisible);
    const isRecordedFromLaunch = this.recordEmulatorLaunch({ avdName, emulator, launchedAtInMilliseconds, preLaunchEmulatorPids: emulatorPidsBefore });

    /*
     * The capture is NOT stopped here any more. It used to be, in a `finally`
     * the moment a device appeared — which froze the emulator's testimony
     * exactly one step before the failure this harness could not explain. The
     * hanging-thread and packet-streamer lines are printed later, while the run
     * is inside `establishSession`. The window now closes there instead.
     */
    let actualDeviceId: string;
    try {
      actualDeviceId = await this.waitForNewDevice(deviceIdsBefore, emulator, timeouts, (deviceId) => {
        this.recordEmulatorLaunchDevice({ avdName, deviceId, launchedAtInMilliseconds });
      });
    } catch (error: unknown) {
      /*
       * This emulator is ours and this is the last point anything holds it: a
       * rejection here reaches the caller with no device result, so its
       * teardown has no process to stop. A boot that failed a readiness gate —
       * the idle wait, the network wait — used to leave a running emulator
       * behind exactly this way.
       */
      await this.stopEmulatorAfterFailedStart({ avdName, deviceIdsBefore, emulator, emulatorPidsBefore });
      throw error;
    }

    const ownedEmulatorPids = await this.listEmulatorBackendPids(emulatorPidsBefore);
    this.log(
      `Emulator "${avdName}" started, device ${actualDeviceId} is connected (owned emulator PIDs: [${ownedEmulatorPids.join(', ')}]).`
    );
    /*
     * Recorded here — including when this code runs in a test worker, which is
     * the case the in-memory ownership lost: the worker dies without a
     * teardown, and the marker is what lets the run's global teardown, or the
     * next run, find and stop what it started. This write completes the record
     * the launch opened: same launch time, now with the QEMU backend the
     * launcher forked, which is the process that actually holds the AVD.
     */
    writeEmulatorMarker({ avdName, deviceId: actualDeviceId, ownedEmulatorPids, startedAtInMilliseconds: launchedAtInMilliseconds });
    if (!isRecordedFromLaunch) {
      // The marker covers a run that ends or is followed by another; the reaper covers one killed with nothing after it.
      this.armEmulatorReaper(avdName, launchedAtInMilliseconds);
    }
    await this.suppressErrorDialogs(actualDeviceId);
    return {
      actualDeviceId,
      emulatorCapture: { read: emulator.readOutput, stop: emulator.stopCapture },
      emulatorProcess: emulator.process,
      ownedEmulatorPids
    };
  }

  private async ensureUiautomator2DriverInstalled(): Promise<void> {
    this.log(`Checking whether the ${UIAUTOMATOR2_DRIVER_NAME} driver is installed...`);
    const driverListJson = await exec('npx --no-install appium driver list --installed --json', {
      isQuiet: true,
      shouldIgnoreExitCode: true
    });

    if (checkIsAppiumDriverInstalled({ driverListJson, driverName: UIAUTOMATOR2_DRIVER_NAME })) {
      this.log(`The ${UIAUTOMATOR2_DRIVER_NAME} driver is installed.`);
      return;
    }

    this.log(`The ${UIAUTOMATOR2_DRIVER_NAME} driver is not installed. Installing via \`appium driver install ${UIAUTOMATOR2_DRIVER_NAME}\`...`);
    await exec(`npx --no-install appium driver install ${UIAUTOMATOR2_DRIVER_NAME}`);
    this.log(`The ${UIAUTOMATOR2_DRIVER_NAME} driver installed.`);
  }

  /**
   * Establishes the WebDriverIO session, recognizing the one failure that blames
   * the wrong subject: `Could not find a connected Android device` from a server
   * whose adb is wedged while the host's own adb sees the device fine.
   *
   * A server an earlier run of this harness started is restarted and the session
   * retried once — the confirmed remedy. A foreign or user-managed server is
   * never killed; it is reported with a message that names the server.
   *
   * @param params - The session capabilities plus what is known about the server.
   * @returns The session, and the replacement server process when one was started.
   */
  private async establishSession(params: EstablishSessionParams): Promise<EstablishSessionResult> {
    this.log(
      `Connecting to Appium (device=${params.deviceId}, app=${params.appId}, retryTimeout: ${String(params.sessionConnectionRetryTimeoutInMilliseconds)}ms, retries: ${String(APPIUM_CONNECTION_RETRY_COUNT)})...`
    );

    try {
      return { browser: await this.connectSession(params) };
    } catch (error: unknown) {
      const verdict = resolveWedgedAppiumServerRemedy({
        connectedDeviceIds: await this.getConnectedDeviceIdsQuietly(),
        deviceId: params.deviceId,
        error,
        isAdoptedServer: params.isAdoptedServer,
        isAutoStartAllowed: params.shouldAutoStartAppium !== false,
        isHarnessOwnedServer: checkIsHarnessOwnedAppiumServer(params.appiumServerMarker)
      });

      if (verdict.remedy === 'not-wedged') {
        throw error;
      }

      if (verdict.remedy === 'report') {
        throw new Error(this.buildWedgedMessage(params, verdict.reason), { cause: error });
      }

      return await this.restartWedgedServerAndRetry(params, error);
    }
  }

  /**
   * Establishes the session, and when that fails, asks the device whether it is
   * still there before letting the failure stand.
   *
   * `establishSession` owns exactly one diagnosis — the stale Appium server —
   * and rethrows everything else untouched. That is right as far as it goes, but
   * every signature this harness actually fails with on a wedged emulator falls
   * into "everything else": `Device <id> was not in the list of connected
   * devices`, `error: closed`, and a bare `POST /session` timeout. Rather than
   * teaching the server module to recognize error strings that are not about the
   * server, the device is simply re-probed here, where the device is known. A
   * wedged emulator then reports itself, and the original error is kept as the
   * `cause`.
   *
   * @param emulatorCapture - The emulator's output, when this run started it.
   * @param params - The session parameters.
   * @returns The established session.
   */
  private async establishSessionOrDiagnoseDevice(
    emulatorCapture: EmulatorCapture | undefined,
    params: EstablishSessionParams
  ): Promise<EstablishSessionResult> {
    try {
      return await this.establishSession(params);
    } catch (error: unknown) {
      const diagnosis = await this.diagnoseDevice(params.deviceId, emulatorCapture);
      if (diagnosis === undefined) {
        throw error;
      }

      throw new Error(diagnosis, { cause: error });
    }
  }

  private async getConnectedDeviceIds(): Promise<string[]> {
    return listOnlineDeviceIds(await this.emulators.getDevicesOutput());
  }

  /**
   * Lists the host's connected devices for the wedged-server cross-check, where
   * an adb that itself fails must not be read as evidence against the server.
   *
   * @returns The connected device IDs, or an empty list when adb could not be run.
   */
  private async getConnectedDeviceIdsQuietly(): Promise<string[]> {
    try {
      return await this.getConnectedDeviceIds();
    } catch (error: unknown) {
      this.log(`Could not re-check connected devices: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private getDeviceProperty(deviceId: string, property: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        'adb',
        ['-s', deviceId, 'shell', 'getprop', property],
        { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
        (error, stdout) => {
          // Return no output on timeout/error (not partial stdout) so a non-responsive guest reads as "not idle".
          resolve(error ? '' : stdout);
        }
      );
    });
  }

  /**
   * Lists the emulator processes currently running on the host, excluding a set
   * that is already accounted for.
   *
   * Called twice around a launch: with an empty `knownPids` to snapshot what
   * predates it, then with that snapshot to name what the launch added — which
   * is precisely the set this run owns.
   *
   * Best-effort: a listing that cannot be produced yields no PIDs, so an
   * unavailable `tasklist`/`ps` degrades to "nothing to escalate to" rather than
   * failing the run it is cleaning up for. **It says so, loudly** — an empty set
   * that means "no backend to own" and one that means "the query failed" are
   * otherwise the same log line, and the second silently disarms the escalation.
   * That is not hypothetical: the first end-to-end run of this code logged
   * `owned emulator PIDs: []` for a launch whose backend was demonstrably there,
   * because `tasklist` overran a 10s budget on a host the wedged emulator had
   * already slowed to the point where every `adb` call was timing out too — the
   * same contention **L45** sizes `ADB_DUMPSYS_TIMEOUT_IN_MILLISECONDS` for, and
   * the same "wrong budget silently disables the check" shape.
   *
   * A host always has processes, so a listing that parses to **zero** rows is a
   * failed query however it exited, and is reported like one.
   *
   * @param knownPids - Emulator PIDs to exclude.
   * @returns The emulator PIDs not in `knownPids`.
   */
  private async listEmulatorBackendPids(knownPids: readonly number[]): Promise<number[]> {
    const processes = await this.emulators.queryHostProcesses();
    if (processes === undefined) {
      this.log(
        'Warning: the host process listing failed, so this run cannot identify the emulator backend it owns. Teardown will fall back to `adb devices` alone and will have no PID to escalate to.'
      );
      return [];
    }

    return selectEmulatorBackendPids({ knownPids, processes });
  }

  private listInstalledPackages(deviceId: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        'adb',
        ['-s', deviceId, 'shell', 'cmd', 'package', 'list', 'packages'],
        { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
        (error, stdout) => {
          // Return no output on timeout/error so a churning guest's slow/partial package list can't falsely read as idle.
          resolve(error ? '' : stdout);
        }
      );
    });
  }

  /**
   * Finds the processes still listening on a port.
   *
   * This is the only real escalation available for the Appium server: the PID
   * the harness holds is the shell wrapper it spawned, so re-killing it achieves
   * nothing, while a socket still answering on the port is direct evidence of
   * what survived.
   *
   * @param port - The port to query.
   * @returns The listening PIDs, or an empty list when the query could not be run.
   */
  private listPortOwnerPids(port: number): Promise<number[]> {
    const query = buildPortOwnerQuery(port);
    return new Promise<number[]>((resolve) => {
      execFile(
        query.command,
        query.commandArguments,
        { maxBuffer: ADB_DUMPSYS_MAX_BUFFER_IN_BYTES, timeout: HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS },
        (error, stdout) => {
          // `lsof` exits non-zero when nothing holds the port, which is a legitimate empty answer.
          resolve(parsePortOwnerPids({ output: error ? '' : stdout, port }));
        }
      );
    });
  }

  /**
   * Synchronous {@link listPortOwnerPids}, for the `process.on('exit')` teardown
   * that cannot await.
   *
   * Its budget is deliberately **not** the async path's: this call blocks process
   * exit outright, so it takes a short one and gives up rather than holding the
   * exit handler for half a minute on a contended host. Giving up loses the
   * escalation, which the sync path's log already admits it cannot confirm.
   *
   * @param port - The port to query.
   * @returns The listening PIDs, or an empty list when the query could not be run in time.
   */
  private listPortOwnerPidsSync(port: number): number[] {
    const query = buildPortOwnerQuery(port);
    try {
      const output = execFileSync(query.command, query.commandArguments, {
        encoding: 'utf-8',
        maxBuffer: ADB_DUMPSYS_MAX_BUFFER_IN_BYTES,
        timeout: SYNC_TEARDOWN_QUERY_TIMEOUT_IN_MILLISECONDS
      });
      return parsePortOwnerPids({ output, port });
    } catch {
      return [];
    }
  }

  private log(message: string): void {
    log(`[transport-factory:${this.type}] ${message}`);
  }

  /**
   * Logs how old the snapshot a run has opted into resuming is.
   *
   * Best-effort: a missing snapshot is the normal state of a fresh AVD, not a
   * failure, and this is a diagnostic rather than a gate.
   *
   * @param avdName - The AVD whose snapshot is about to be resumed.
   */
  private logSnapshotAge(avdName: string): void {
    let savedAt: Date | undefined;

    for (const candidate of buildAvdSnapshotDirectoryCandidates({ avdName, environment: process.env, homeDirectory: homedir() })) {
      try {
        savedAt = statSync(candidate).mtime;
        break;
      } catch {
        // Not this AVD home — try the next candidate.
      }
    }

    this.log(buildSnapshotAgeMessage({ avdName, savedAt }));
  }

  /**
   * Reads one emulator's AVD name from its console, retrying once.
   *
   * The retry is what makes the refusal proportionate: the probe's whole budget
   * is 5s, and a second look costs less than a colliding launch does. What it
   * must never do is report a non-answer as an answer — the discarded `_error`
   * this replaces resolved `''`, which compared unequal to the wanted AVD and so
   * read as a definite "some other AVD".
   *
   * @param deviceId - The emulator to ask.
   * @returns The AVD name it answered, or `undefined` when it did not answer.
   */
  private async probeAvdName(deviceId: string): Promise<string | undefined> {
    for (let attempt = 1; attempt <= AVD_PROBE_ATTEMPT_COUNT; attempt++) {
      const answer = await new Promise<string | undefined>((resolve) => {
        execFile(
          'adb',
          ['-s', deviceId, 'emu', 'avd', 'name'],
          { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
          (error, stdout) => {
            resolve(error ? undefined : stdout.split('\n', 1)[0]?.trim());
          }
        );
      });

      if (answer !== undefined && answer.length > 0) {
        return answer;
      }

      if (attempt < AVD_PROBE_ATTEMPT_COUNT) {
        this.log(
          `Device ${deviceId} did not answer \`adb -s ${deviceId} emu avd name\` within ${String(ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS)}ms; retrying once.`
        );
      }
    }

    return undefined;
  }

  /**
   * Asks every connected device which AVD it is serving.
   *
   * A device that is not a locally started emulator is never asked: its console
   * cannot answer however healthy it is, and reading that as silence would
   * refuse every run on a host with a handset plugged in — see
   * `avd-probe-verdict.ts`.
   *
   * @param avdName - The AVD the run wants.
   * @param deviceIds - The connected devices.
   * @returns One outcome per device, in listed order.
   */
  private async probeDevicesForAvd(avdName: string, deviceIds: readonly string[]): Promise<AvdProbeResult[]> {
    const results: AvdProbeResult[] = [];

    for (const deviceId of deviceIds) {
      const probedAvdName = checkIsEmulatorDeviceId(deviceId) ? await this.probeAvdName(deviceId) : undefined;
      results.push({ deviceId, outcome: classifyAvdProbe({ avdName, deviceId, probedAvdName }) });
    }

    return results;
  }

  /**
   * Asks the **guest** whether it is still scheduling work, via `adbd`.
   *
   * @param deviceId - The device to probe.
   * @returns What it answered.
   */
  private probeDeviceShell(deviceId: string): Promise<EmulatorLivenessProbeOutcome> {
    return this.runLivenessProbe(['-s', deviceId, 'shell', 'true']);
  }

  /**
   * Asks the **emulator process** whether it is still running, via its console.
   *
   * The console is served by the emulator itself rather than by the guest, which
   * is what makes it able to tell a frozen guest from a wedged emulator.
   *
   * @param deviceId - The device to probe.
   * @returns What it answered.
   */
  private probeEmulatorConsole(deviceId: string): Promise<EmulatorLivenessProbeOutcome> {
    return this.runLivenessProbe(['-s', deviceId, 'emu', 'avd', 'status']);
  }

  /**
   * Replaces a leftover server an earlier run failed to stop, instead of
   * adopting it.
   *
   * This is the other half of {@link stopAutoStartedAppiumServer}'s stamped
   * marker, and it is the case that motivated the whole verified teardown: the
   * leftover answers `/status` perfectly, is adopted, and then dies seconds into the session as
   * it finally finishes shutting down — a failure that reads as a device or
   * network fault. A server we know we already asked to die is not a server to
   * build a suite on.
   *
   * @param params - The marker, the port and whether a replacement may be started.
   * @returns `true` when the port was freed and a fresh server must be started.
   */
  private async reclaimUnstoppedAppiumServer(params: ReclaimUnstoppedAppiumServerParams): Promise<boolean> {
    const stopAttemptedAtInMilliseconds = params.marker.stopAttemptedAtInMilliseconds ?? Date.now();
    const ageInSeconds = Math.round((Date.now() - stopAttemptedAtInMilliseconds) / MILLISECONDS_PER_SECOND);
    const provenance = `the server on port ${String(params.port)} is a leftover an earlier run of this harness tried to stop ${String(ageInSeconds)}s ago and could not`;

    if (params.shouldAutoStartAppium === false) {
      this.log(`WARNING: ${provenance}. Auto-start is disabled, so this run adopts it anyway; if the session dies mid-flight, that is why.`);
      return false;
    }

    this.log(`Refusing to adopt a known-doomed server: ${provenance}. Killing whatever holds the port and starting a fresh server...`);
    for (const pid of await this.listPortOwnerPids(params.port)) {
      killProcessTreeByPid(pid);
    }
    clearAppiumServerMarker(params.port);

    if (await this.checkIsAppiumStopped(params.url, APPIUM_ESCALATED_STOP_TIMEOUT_IN_MILLISECONDS)) {
      return true;
    }

    this.log(`WARNING: ${provenance}, and it survived this run's kill too. Adopting it, which may fail mid-session.`);
    return false;
  }

  /**
   * Records an emulator as this run's the moment it is launched, before it has
   * a device — and arms its reaper there.
   *
   * The marker used to be written once the device connected, about 45s into a
   * cold boot, and the reaper with it. A runner killed inside that window left a
   * running emulator with **no marker at all**, which every later run correctly
   * refuses to touch (**L46**) and no reaper was watching: the leftover was
   * nobody's to stop, for ever. A launch-time marker closes that window with the
   * one thing already known — the launcher's PID, which `emulator-backend.ts`
   * counts as an emulator process, so the marker convicts as a
   * `harness-leftover` exactly like a completed one — plus the pre-launch
   * snapshot, which is what lets a later reclaim identify the backend the
   * launcher forks without having been there to watch it.
   *
   * **It never overwrites a marker whose processes are still running.** A launch
   * can happen while an older emulator of the same AVD is still up and recorded
   * — an `offline` leftover the probe cannot see, which is the launch that dies
   * on `Running multiple emulators with the same AVD`. Clobbering that marker
   * would erase the only record of a running emulator, the very thing
   * `clearEmulatorMarkerIfStopped` exists to prevent. In that case the record
   * waits for the success path, as before.
   *
   * @param params - The AVD, its launcher, and when it was launched.
   * @returns `true` when the launch was recorded and its reaper armed.
   */
  private recordEmulatorLaunch(params: RecordEmulatorLaunchParams): boolean {
    const { avdName } = params;
    const launcherPid = params.emulator.process.pid;
    if (launcherPid === undefined) {
      this.log(`The emulator launcher for AVD "${avdName}" reported no PID, so its launch cannot be recorded; it is recorded once its device connects.`);
      return false;
    }

    const existingMarker = readEmulatorMarker(avdName);
    if (existingMarker && (selectLiveMarkedPids(existingMarker, params.preLaunchEmulatorPids).length > 0 || checkIsMarkedEmulatorRunning(existingMarker))) {
      this.log(`Not recording the launch of AVD "${avdName}" yet: its existing marker still names a running process, and that record is the only one of an emulator that may still be up.`);
      return false;
    }

    writeEmulatorMarker({
      avdName,
      ownedEmulatorPids: [launcherPid],
      preLaunchEmulatorPids: params.preLaunchEmulatorPids,
      startedAtInMilliseconds: params.launchedAtInMilliseconds
    });
    this.log(`Recorded the emulator launch for AVD "${avdName}" (launcher PID ${String(launcherPid)}) before its device exists, so a kill during the boot still leaves it convictable.`);
    this.armEmulatorReaper(avdName, params.launchedAtInMilliseconds);
    return true;
  }

  /**
   * Fills the device into the marker this launch wrote, as soon as one appears.
   *
   * Worth its own write because the console shutdown is the only stop that
   * releases the AVD's `multiinstance.lock` (**L46**), and it needs a device to
   * talk to. Deliberately **no** host process listing here: that query is
   * budgeted at {@link HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS} for exactly
   * this contended window, and spending it inside the boot path would eat the
   * readiness budgets that follow. The backend PIDs arrive with the success
   * write, one listing, as before.
   *
   * Only ever fills in **this** launch's marker: one carrying another launch
   * time, or a device already, belongs to an emulator this run did not start.
   *
   * @param params - The AVD, the device that appeared, and the launch it belongs to.
   */
  private recordEmulatorLaunchDevice(params: RecordEmulatorLaunchDeviceParams): void {
    const { avdName, deviceId } = params;
    const marker = readEmulatorMarker(avdName);
    if (!marker || marker.deviceId !== undefined || marker.startedAtInMilliseconds !== params.launchedAtInMilliseconds) {
      return;
    }

    writeEmulatorMarker({
      avdName,
      deviceId,
      ownedEmulatorPids: marker.ownedEmulatorPids,
      // Still provisional: the backend's PID arrives with the success write, and until then the diff is what convicts it.
      preLaunchEmulatorPids: marker.preLaunchEmulatorPids,
      startedAtInMilliseconds: marker.startedAtInMilliseconds
    });
    this.log(`Recorded device ${deviceId} against the launch marker for AVD "${avdName}", so a stop from here on can shut it down over its console.`);
  }

  /**
   * Replaces a wedged server this harness started earlier and retries the
   * session once.
   *
   * The old server is killed and the port is waited out before a replacement is
   * started: a socket that keeps answering `/status` would let the readiness
   * poll pass on the dying server, and a port that never goes quiet means the
   * kill did not take — in which case starting anything on it is pointless.
   *
   * @param params - The session capabilities plus what is known about the server.
   * @param originalError - The failure that convicted the server, logged so the diagnosis is on the record.
   * @returns The session and the replacement server process.
   */
  private async restartWedgedServerAndRetry(params: EstablishSessionParams, originalError: unknown): Promise<EstablishSessionResult> {
    const marker = ensureNonNullable(params.appiumServerMarker, 'A restart verdict requires the marker that proved ownership.');
    this.log(
      `Appium at ${params.url.origin} cannot see ${params.deviceId} although this host's adb can — the server this harness started earlier (pid ${String(marker.pid)}) is stale. Restarting it... (session failed with: ${originalError instanceof Error ? originalError.message : String(originalError)})`
    );

    killProcessTreeByPid(marker.pid);
    clearAppiumServerMarker(params.port);

    try {
      await this.waitForAppiumStopped(params.url, APPIUM_STOP_TIMEOUT_IN_MILLISECONDS);
    } catch (error: unknown) {
      throw new Error(this.buildWedgedMessage(params, 'restart-did-not-help'), { cause: error });
    }

    const launch = this.startAppiumServer(params.port, params.isAppiumConsoleVisible);

    try {
      await this.waitForAppiumReady(params.url, params.appiumStartTimeoutInMilliseconds, launch);
      this.log('Replacement Appium server is ready, retrying the session...');
      return { appiumProcess: launch.process, browser: await this.connectSession(params) };
    } catch (error: unknown) {
      killProcessTree(launch.process);
      clearAppiumServerMarker(params.port);
      throw new Error(this.buildWedgedMessage(params, 'restart-did-not-help'), { cause: error });
    }
  }

  /**
   * Adopts a device already serving the requested AVD.
   *
   * @param avdName - The AVD it is serving.
   * @param deviceId - The device to adopt.
   * @param timeouts - The two post-boot readiness budgets.
   * @returns The adopted device, owning the emulator's PIDs only when it is a leftover this harness started.
   */
  private async reuseConnectedDevice(avdName: string, deviceId: string, timeouts: DeviceReadinessTimeouts): Promise<EnsureDeviceConnectedResult> {
    /*
     * A device this run did not start is not this run's to stop — unless this
     * harness started it and nothing live is responsible for it any more. Then
     * it is taken over, so this run's teardown stops it and a leaked emulator
     * serves at most one more run instead of living for ever.
     */
    const ownedEmulatorPids = await this.takeOverLeftoverEmulator(avdName, deviceId);
    this.log(
      ownedEmulatorPids.length > 0
        ? `AVD "${avdName}" is already running on device ${deviceId} as a leftover this harness started; reusing it and taking it over (owned emulator PIDs: [${ownedEmulatorPids.join(', ')}]), so this run stops it.`
        : `AVD "${avdName}" is already running on device ${deviceId}, reusing.`
    );

    try {
      await this.suppressErrorDialogs(deviceId);
      /*
       * A reused device gets the SAME settle gate a harness-started one gets.
       * Appearing in `adb devices` says only that adbd is up: the guest can
       * still be running the boot animation or optimizing packages, and a
       * session established against that contends with the churn and inflates
       * every subsequent round-trip 25-50x (L19). Skipping the gate here is
       * what let a release preflight spend its whole layout-ready budget on a
       * handful of contended probes while `adb devices` reported `device`
       * throughout. The same argument applies to the network gate: a device
       * that has been up for seconds is exactly one with no validated network
       * yet.
       */
      await this.waitForBoot(deviceId, Date.now() + EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS, undefined);
      await this.waitForDeviceReady(deviceId, timeouts);
      await this.wakeScreen(deviceId);
    } catch (error: unknown) {
      // As with a launch that fails its gates: a rejection here hands the caller nothing to stop.
      if (ownedEmulatorPids.length > 0) {
        await this.emulators.stopEmulator({ avdName, deviceId, ownedEmulatorPids });
      }
      throw error;
    }

    return { actualDeviceId: deviceId, ownedEmulatorPids };
  }

  /**
   * Runs one liveness probe, retrying once before calling it silence.
   *
   * Only success counts as an answer: a failed `adb ... emu` may be the adb
   * server refusing an `offline` device rather than the console being dead, and
   * the two are indistinguishable from here (see `emulator-liveness.ts`). The
   * single retry is the same restraint `probeAvdName` applies for the same
   * reason — a second look is far cheaper than a wrong verdict, and this one
   * decides whether a run is aborted.
   *
   * @param input - The adb arguments.
   * @returns Whether the probe got an answer.
   */
  private async runLivenessProbe(input: readonly string[]): Promise<EmulatorLivenessProbeOutcome> {
    for (let attempt = 1; attempt <= DEVICE_LIVENESS_ATTEMPT_COUNT; attempt++) {
      const isAnswered = await new Promise<boolean>((resolve) => {
        execFile('adb', [...input], { timeout: DEVICE_LIVENESS_TIMEOUT_IN_MILLISECONDS }, (error) => {
          resolve(!error);
        });
      });

      if (isAnswered) {
        return 'answered';
      }
    }

    return 'no-answer';
  }

  private async sendKeyEvent(deviceId: string, keyCode: number, description: string): Promise<void> {
    await new Promise<void>((resolve) => {
      execFile(
        'adb',
        ['-s', deviceId, 'shell', 'input', 'keyevent', String(keyCode)],
        { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
        (error) => {
          if (error) {
            this.log(
              `Warning: failed to ${description} (keyevent ${String(keyCode)}): ${error instanceof Error ? error.message : 'unknown error'}`
            );
          }

          resolve();
        }
      );
    });
  }

  private async startAppiumAndEmulator(params: StartAppiumAndEmulatorParams): Promise<StartAppiumAndEmulatorResult> {
    const { appiumStartTimeoutInMilliseconds, appiumUrl, avdName, deviceIdleTimeoutInMilliseconds, isAppiumConsoleVisible, isEmulatorVisible, networkReadyTimeoutInMilliseconds, port, shouldAutoInstallAppiumDependencies, shouldAutoStartAppium, shouldReuseEmulatorSnapshot } = params;

    let needsAppiumStart = false;
    let appiumServerMarker: AppiumServerMarker | undefined;

    this.log(`Checking Appium server at ${appiumUrl.href}...`);
    try {
      await this.checkAppiumReachable(appiumUrl);
      appiumServerMarker = readAppiumServerMarker(port);
      this.log(`Appium server is reachable (${this.describeAdoptedServer(appiumServerMarker)}).`);

      if (appiumServerMarker?.stopAttemptedAtInMilliseconds !== undefined) {
        needsAppiumStart = await this.reclaimUnstoppedAppiumServer({
          marker: appiumServerMarker,
          port,
          shouldAutoStartAppium,
          url: appiumUrl
        });
        if (needsAppiumStart) {
          appiumServerMarker = undefined;
        }
      }
    } catch (error: unknown) {
      if (shouldAutoStartAppium === false) {
        throw error;
      }
      needsAppiumStart = true;
    }

    let appiumLaunch: ProcessLaunch | undefined;

    if (needsAppiumStart) {
      if (shouldAutoInstallAppiumDependencies) {
        await this.ensureAppiumDependencies();
      }
      this.log(`Appium not reachable, auto-starting on port ${String(port)}...`);
      appiumLaunch = this.startAppiumServer(port, isAppiumConsoleVisible);
    }

    const appiumProcess = appiumLaunch?.process;

    /*
     * `allSettled`, not `all`: the two halves start together, so a rejected
     * Appium wait used to abandon an emulator that went on to boot perfectly —
     * the leak survived the very teardown that was supposed to prevent it,
     * because the emulator's handle only exists inside the result `Promise.all`
     * discarded. Both outcomes are collected so both can be stopped.
     */
    const [appiumOutcome, deviceOutcome] = await Promise.allSettled([
      appiumLaunch
        ? this.waitForAppiumReady(appiumUrl, appiumStartTimeoutInMilliseconds, appiumLaunch).then(() => {
          this.log('Auto-started Appium server is ready.');
        })
        : Promise.resolve(),
      this.ensureDeviceConnected({ avdName, deviceIdleTimeoutInMilliseconds, isEmulatorVisible, networkReadyTimeoutInMilliseconds, shouldReuseEmulatorSnapshot })
    ]);

    const deviceResult = deviceOutcome.status === 'fulfilled' ? deviceOutcome.value : undefined;

    if (appiumOutcome.status === 'rejected' || deviceResult === undefined) {
      await this.stopAutoStartedProcessesVerified({
        appiumProcess,
        avdName,
        deviceId: deviceResult?.actualDeviceId,
        emulatorProcess: deviceResult?.emulatorProcess,
        ownedEmulatorPids: deviceResult?.ownedEmulatorPids ?? [],
        port,
        url: appiumUrl
      });

      throw getSettledFailure([appiumOutcome, deviceOutcome]);
    }

    return {
      actualDeviceId: deviceResult.actualDeviceId,
      appiumProcess,
      appiumServerMarker,
      emulatorCapture: deviceResult.emulatorCapture,
      emulatorProcess: deviceResult.emulatorProcess,
      isAdoptedAppiumServer: !needsAppiumStart,
      ownedEmulatorPids: deviceResult.ownedEmulatorPids
    };
  }

  private startAppiumServer(port: number, isAppiumConsoleVisible?: boolean): ProcessLaunch {
    const isConsoleHidden = shouldHideAppiumConsole(isAppiumConsoleVisible);
    const { detached, windowsHide } = resolveAppiumSpawnFlags(isConsoleHidden);
    /*
     * `--no-install`: Appium is guaranteed present by `ensureAppiumInstalled`
     * before we reach here, so pin npx to the installed copy. Without it, npx
     * would silently try to download Appium fresh from the registry — a
     * slow/hung failure in a hidden console — whenever it could not resolve the
     * global install (e.g. a global prefix not on PATH). See `ensureAppiumInstalled`.
     *
     * Pipe stdout/stderr even when hidden (rather than discarding) so an early
     * failure such as a crash or a missing driver is captured and surfaced
     * immediately by `waitForAppiumReady`, mirroring `startEmulator`;
     * `windowsHide` still suppresses the console window.
     */
    const child = spawn(`npx --no-install appium --log-timestamp --port ${String(port)} --allow-insecure=${CHROMEDRIVER_AUTODOWNLOAD_FEATURE}`, {
      detached,
      shell: true,
      stdio: isConsoleHidden ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      windowsHide
    });

    let capturedOutput = '';
    let exitInfo: ProcessExitInfo | undefined;
    let isCapturing = true;

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
    });
    child.once('error', (error) => {
      exitInfo = { code: null, signal: null, spawnError: error.message };
    });

    child.unref();

    /*
     * Record the server as ours before anything can adopt it. The marker is what
     * lets a later run tell its own leftover server from a foreign one, and so
     * whether restarting a wedged server is this harness's call to make — see
     * `appium-server-marker.ts`.
     */
    if (child.pid !== undefined) {
      writeAppiumServerMarker({ pid: child.pid, port });
    }

    return {
      process: child,
      readExitInfo: () => exitInfo,
      readOutput: () => capturedOutput,
      stopCapture: (): void => {
        isCapturing = false;
      }
    };

    function appendOutput(chunk: Buffer): void {
      if (!isCapturing) {
        return;
      }
      capturedOutput = (capturedOutput + chunk.toString()).slice(-APPIUM_OUTPUT_TAIL_MAX_LENGTH);
    }
  }

  private startEmulator(avdName: string, shouldReuseSnapshot: boolean, isEmulatorVisible?: boolean): ProcessLaunch {
    const emulatorBinary = resolveEmulatorBinaryPath();
    const isWindowHidden = shouldHideEmulatorWindow(isEmulatorVisible);
    const input = buildEmulatorArguments({ avdName, isHidden: isWindowHidden, shouldReuseSnapshot });
    const { detached, windowsHide } = resolveEmulatorSpawnFlags(isWindowHidden);
    const { environment, isNetsimLogGuarded } = buildEmulatorEnvironment(process.env);
    this.log(`Running: ${emulatorBinary} ${input.join(' ')}`);
    this.log(
      isNetsimLogGuarded
        ? `netsimd log level: RUST_LOG=${NETSIM_LOG_FILTER} (keeps its wifi-stats warning from growing its log without bound).`
        : `netsimd log level: RUST_LOG=${String(environment['RUST_LOG'])}, set by the caller — the harness's bounded default is off, and netsimd's log can grow without bound.`
    );
    /*
     * Pipe (rather than ignore) stdout/stderr so an early failure such as
     * "x86_64 emulation currently requires hardware acceleration" can be
     * surfaced immediately instead of waiting out the full boot timeout.
     */
    const child = spawn(emulatorBinary, input, {
      detached,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide
    });

    let capturedOutput = '';
    let exitInfo: ProcessExitInfo | undefined;
    let isCapturing = true;

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
    });
    /*
     * A spawn failure (e.g. ENOENT for a missing/broken emulator binary) emits
     * 'error', not 'exit'. Record it as a synthetic exit so the boot/new-device
     * polls fail fast instead of spinning out the full boot timeout.
     */
    child.once('error', (error) => {
      exitInfo = { code: null, signal: null, spawnError: error.message };
    });

    child.unref();

    return {
      process: child,
      readExitInfo: () => exitInfo,
      readOutput: () => capturedOutput,
      stopCapture: (): void => {
        /*
         * Leave the `data` listeners attached so the pipes keep draining (a
         * full OS pipe buffer would block the long-running emulator); the flag
         * just freezes the captured tail once startup has succeeded.
         */
        isCapturing = false;
      }
    };

    function appendOutput(chunk: Buffer): void {
      if (!isCapturing) {
        return;
      }
      capturedOutput = (capturedOutput + chunk.toString()).slice(-EMULATOR_OUTPUT_TAIL_MAX_LENGTH);
    }
  }

  /**
   * Disables the guest's crash/ANR dialogs on the given device.
   *
   * A resource-starved emulator can raise a "Process system isn't responding"
   * ANR (an `ActivityManagerService` timeout) whose dialog overlays the UI. If
   * it appears before Appium attaches, nothing can dismiss it and the run hangs
   * or fails intermittently. Setting the `hide_error_dialogs` global — the same
   * flag Android's own test infra uses — tells `ActivityManagerService` to
   * never draw crash/ANR dialogs, so the ANR can no longer block automation.
   *
   * This is the earliest point at which the flag can be set: the framework
   * (`system_server`) must be up before `settings put` works, so callers invoke
   * it only after `sys.boot_completed`. It narrows — but cannot fully close —
   * the race with an ANR that fires between boot completing and this call; a
   * pre-baked snapshot with the flag already set is the only way to eliminate
   * it entirely. Best-effort: a failure is logged, not thrown, since it only
   * suppresses a symptom.
   *
   * @param deviceId - The device UDID to configure.
   */
  /**
   * Stops the Appium server this run started, and **verifies** it stopped.
   *
   * The port is the verdict: a socket still answering `/status` after the kill
   * is the server, whatever the PID table says. When it is still there the
   * listener is killed by port ownership — the only escalation that means
   * anything, since re-killing the shell wrapper's PID would just repeat the
   * kill that already failed.
   *
   * @param params - The server process, its port and its URL.
   */
  private async stopAutoStartedAppiumServer(params: StopAutoStartedAppiumServerParams): Promise<void> {
    killProcessTree(params.appiumProcess);

    let hasEscalated = false;
    let isStopped = await this.checkIsAppiumStopped(params.url, APPIUM_STOP_TIMEOUT_IN_MILLISECONDS);

    if (!isStopped) {
      const ownerPids = await this.listPortOwnerPids(params.port);
      if (ownerPids.length > 0) {
        hasEscalated = true;
        this.log(
          `Auto-started Appium server still answers on ${params.url.origin} after its process tree was killed; escalating to the PID(s) holding the port: [${ownerPids.join(', ')}].`
        );
        for (const pid of ownerPids) {
          killProcessTreeByPid(pid);
        }
        isStopped = await this.checkIsAppiumStopped(params.url, APPIUM_ESCALATED_STOP_TIMEOUT_IN_MILLISECONDS);
      }
    }

    this.log(buildTeardownMessage({
      evidence: `port ${String(params.port)}`,
      outcome: resolveTeardownOutcome({ hasEscalated, isStopped }),
      subject: 'Auto-started Appium server',
      timeoutInMilliseconds: APPIUM_STOP_TIMEOUT_IN_MILLISECONDS
    }));

    if (isStopped) {
      // Drop the marker with the server it describes, so the next run cannot mistake a recycled PID for ours.
      clearAppiumServerMarker(params.port);
      return;
    }

    // Keep the marker, stamped: a leftover we could not kill must stay convictable by the next run.
    recordAppiumServerStopAttempt(params.port);
  }

  /**
   * Best-effort teardown for `process.on('exit')`, which cannot await.
   *
   * It kills, looks once for a survivor still holding the Appium port or a
   * still-live emulator PID, kills those too — and then says exactly that. It
   * never claims a verified stop, because it cannot wait to earn one.
   *
   * @param params - Everything this run started.
   */
  private stopAutoStartedProcessesBestEffort(params: StopAutoStartedProcessesParams): void {
    if (params.appiumProcess) {
      killProcessTree(params.appiumProcess);
      const ownerPids = this.listPortOwnerPidsSync(params.port);
      for (const pid of ownerPids) {
        killProcessTreeByPid(pid);
      }

      if (ownerPids.length > 0) {
        this.log(
          `Auto-started Appium server: stop requested and PID(s) [${ownerPids.join(', ')}] holding port ${String(params.port)} killed — sync teardown cannot wait to confirm.`
        );
        recordAppiumServerStopAttempt(params.port);
      } else {
        this.log(`Auto-started Appium server: stop requested, nothing left listening on port ${String(params.port)}.`);
        clearAppiumServerMarker(params.port);
      }
    }

    if (params.emulatorProcess || params.ownedEmulatorPids.length > 0) {
      if (params.emulatorProcess) {
        killProcessTree(params.emulatorProcess);
      }
      const survivingPids = params.ownedEmulatorPids.filter((pid) => checkIsProcessAlive(pid));
      for (const pid of survivingPids) {
        killProcessTreeByPid(pid);
      }

      if (survivingPids.length > 0) {
        // Keep the marker: nothing here waited to see these die, so the next run must still be able to convict them.
        this.log(
          `Auto-started emulator: stop requested and surviving emulator PID(s) [${survivingPids.join(', ')}] killed — sync teardown cannot wait to confirm.`
        );
      } else {
        this.log('Auto-started emulator: stop requested, no process of this run left running.');
        clearEmulatorMarkerIfStopped(params.avdName);
      }
    }
  }

  /**
   * Stops everything this run auto-started, verifying each stop.
   *
   * @param params - Everything this run started.
   */
  private async stopAutoStartedProcessesVerified(params: StopAutoStartedProcessesParams): Promise<void> {
    const isEmulatorOwned = params.emulatorProcess !== undefined || params.ownedEmulatorPids.length > 0;
    if (!params.appiumProcess && !isEmulatorOwned) {
      return;
    }

    this.log('Stopping everything this run auto-started...');

    if (params.appiumProcess) {
      await this.stopAutoStartedAppiumServer({
        appiumProcess: params.appiumProcess,
        port: params.port,
        url: params.url
      });
    }

    if (isEmulatorOwned) {
      await this.emulators.stopEmulator({
        avdName: params.avdName,
        deviceId: params.deviceId,
        emulatorProcess: params.emulatorProcess,
        ownedEmulatorPids: params.ownedEmulatorPids
      });
    }
  }

  /**
   * Stops an emulator this run launched whose start failed before it could be
   * handed back — the boot, idle or network wait gave up on it, or it never
   * produced a device at all.
   *
   * The PIDs come from the same pre-launch snapshot a successful start uses. The
   * device is whichever emulator appeared across the launch, in any state; when
   * that is not exactly one, the stop goes by PIDs alone rather than guess.
   *
   * @param params - The launch, and what predated it.
   */
  private async stopEmulatorAfterFailedStart(params: StopEmulatorAfterFailedStartParams): Promise<void> {
    const ownedEmulatorPids = await this.listEmulatorBackendPids(params.emulatorPidsBefore);
    let newDeviceIds: string[] = [];
    try {
      newDeviceIds = parseAdbDevices(await this.emulators.getDevicesOutput())
        .map((entry) => entry.deviceId)
        .filter((deviceId) => checkIsEmulatorDeviceId(deviceId) && !params.deviceIdsBefore.includes(deviceId));
    } catch (error: unknown) {
      this.log(`Could not list devices while stopping the failed emulator: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.log(`Emulator "${params.avdName}" failed to start; stopping it (owned emulator PIDs: [${ownedEmulatorPids.join(', ')}]).`);
    await this.emulators.stopEmulator({
      avdName: params.avdName,
      deviceId: newDeviceIds.length === 1 ? newDeviceIds[0] : undefined,
      emulatorProcess: params.emulator.process,
      ownedEmulatorPids
    });
  }

  private async suppressErrorDialogs(deviceId: string): Promise<void> {
    this.log(`Disabling crash/ANR dialogs on device ${deviceId} (settings put global hide_error_dialogs 1)...`);

    await new Promise<void>((resolve) => {
      execFile(
        'adb',
        ['-s', deviceId, 'shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1'],
        { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
        (error) => {
          if (error) {
            this.log(
              `Warning: failed to disable crash/ANR dialogs: ${error instanceof Error ? error.message : 'unknown error'}`
            );
          }

          resolve();
        }
      );
    });
  }

  /**
   * Removes the `temp-vault-*` directories earlier runs left on the device.
   *
   * Runs **before** `remote()` launches Obsidian — the last moment at which
   * nothing has to enumerate the device's vaults yet, and the only sweep that
   * does not depend on a healthy WebView. That independence is the whole point:
   * a run whose WebView died cannot unregister or delete its own vault, so
   * without this each failure leaves residue that slows the next run's startup
   * enumeration and makes the next failure likelier.
   *
   * Unconditional (no age gate) — Android runs hold the exclusive `android`
   * setup lock, so no concurrent run can own a device vault, and an age gate
   * would let a vault leaked minutes ago survive into this run. Best-effort: a
   * failure is logged, not thrown.
   *
   * The removals go one directory at a time and the outcome is re-listed rather
   * than inferred; {@link sweepDeviceLeftovers} explains why.
   *
   * @param params - The device and vault base path to sweep.
   */
  private async sweepDeviceLeftoverVaults(params: SweepDeviceLeftoverVaultsParams): Promise<void> {
    const { deviceId, vaultBasePath } = params;

    try {
      const result = await sweepDeviceLeftovers({
        listNames: async (): Promise<string[]> => {
          const listing = await exec(
            ['adb', '-s', deviceId, 'shell', 'ls', '-1', vaultBasePath],
            { isQuiet: true, shouldIgnoreExitCode: true, timeoutInMilliseconds: ADB_VAULT_SWEEP_TIMEOUT_IN_MILLISECONDS }
          );
          return listing.split('\n');
        },
        removeDirectory: async (path: string): Promise<void> => {
          await exec(
            ['adb', '-s', deviceId, 'shell', 'rm', '-rf', path],
            { isQuiet: true, shouldIgnoreExitCode: true, timeoutInMilliseconds: ADB_VAULT_SWEEP_TIMEOUT_IN_MILLISECONDS }
          );
        },
        vaultBasePath
      });

      if (result.removedCount === 0 && result.failedNames.length === 0) {
        this.log(`No leftover temp vaults on device ${deviceId}.`);
        return;
      }

      this.log(`Removed ${String(result.removedCount)} leftover temp vault(s) from ${vaultBasePath} on device ${deviceId}.`);

      if (result.failedNames.length > 0) {
        this.log(
          `Warning: ${String(result.failedNames.length)} leftover temp vault(s) could not be removed and will be retried next run: ${result.failedNames.join(', ')}`
        );
      }
    } catch (error: unknown) {
      this.log(`Warning: failed to sweep leftover temp vaults: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * Takes over the running emulator of an AVD when it is a leftover this harness
   * started, so this run becomes the one responsible for stopping it.
   *
   * @param avdName - The AVD the device is serving.
   * @param deviceId - The device serving it.
   * @returns The emulator PIDs this run now owns; empty when the emulator is not a harness leftover.
   */
  private async takeOverLeftoverEmulator(avdName: string, deviceId: string): Promise<number[]> {
    const marker = readEmulatorMarker(avdName);
    if (!marker) {
      return [];
    }

    const processes = await this.emulators.queryHostProcesses();
    if (processes === undefined) {
      this.log(`Cannot tell whether AVD "${avdName}" is a leftover this harness started without a host process listing; reusing it without taking it over.`);
      return [];
    }

    const liveEmulatorPids = selectEmulatorBackendPids({ knownPids: [], processes });
    const verdict = resolveEmulatorMarkerVerdict({
      currentPid: process.pid,
      isOwnerAlive: checkIsProcessAlive(marker.ownerPid),
      liveEmulatorPids,
      marker
    });

    switch (verdict) {
      case 'harness-leftover': {
        const ownedEmulatorPids = selectLiveMarkedPids(marker, liveEmulatorPids);
        writeEmulatorMarker({ avdName, deviceId, ownedEmulatorPids, startedAtInMilliseconds: marker.startedAtInMilliseconds });
        /*
         * The reaper the earlier run armed may still be watching this emulator
         * — the launch time it keys on survives a takeover — but an emulator
         * started by an older version of the harness has none. A second reaper
         * costs nothing: whichever takes the lock first stops the emulator, and
         * the other then finds the marker gone and exits.
         */
        this.armEmulatorReaper(avdName, marker.startedAtInMilliseconds);
        return ownedEmulatorPids;
      }
      case 'in-use-by-live-run': {
        this.log(`AVD "${avdName}" was started by a harness process that is still running (PID ${String(marker.ownerPid)}); that process stays responsible for stopping it.`);
        return [];
      }
      case 'stale-marker': {
        clearEmulatorMarker(avdName);
        return [];
      }
      default: {
        return assertNever(verdict);
      }
    }
  }

  private async waitForAppiumReady(url: URL, timeoutInMilliseconds: number, launch: ProcessLaunch): Promise<void> {
    const start = Date.now();
    this.log(
      `Waiting for Appium at ${url.href} (timeout: ${String(timeoutInMilliseconds)}ms, poll: ${String(APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS)}ms)...`
    );
    const deadline = start + timeoutInMilliseconds;

    while (Date.now() < deadline) {
      /*
       * If the server process already died (crashed, or never started), stop
       * polling and surface why — otherwise a doomed server spins out the whole
       * readiness timeout with no diagnostics, the original symptom this exists
       * to prevent.
       */
      const exitInfo = launch.readExitInfo();
      if (exitInfo) {
        throw buildDeathError(exitInfo);
      }

      try {
        await this.checkAppiumReachable(url);
        launch.stopCapture();
        this.log(`Appium server ready after ${String(Date.now() - start)}ms.`);
        return;
      } catch {
        this.log(`Appium server not ready yet (elapsed: ${String(Date.now() - start)}ms). Retrying...`);
        await new Promise((resolve) => {
          setTimeout(resolve, APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS);
        });
      }
    }

    const finalExitInfo = launch.readExitInfo();
    if (finalExitInfo) {
      throw buildDeathError(finalExitInfo);
    }

    const outputTail = launch.readOutput().trim();
    const outputSection = outputTail.length > 0 ? `\n\nAppium server output (tail):\n${outputTail}` : '';
    throw new Error(`Auto-started Appium server did not become ready within ${String(timeoutInMilliseconds)}ms.${outputSection}`);

    function buildDeathError(exitInfo: ProcessExitInfo): Error {
      return new Error(buildProcessExitMessage({
        exitInfo,
        output: launch.readOutput(),
        outputLabel: 'Appium server output',
        subject: 'Auto-started Appium server'
      }));
    }
  }

  /**
   * Waits until nothing answers `/status` on the port any more.
   *
   * @param url - The Appium server URL.
   * @param timeoutInMilliseconds - How long to wait before giving up.
   * @throws If the port is still served when the timeout elapses.
   */
  private async waitForAppiumStopped(url: URL, timeoutInMilliseconds: number): Promise<void> {
    const deadline = Date.now() + timeoutInMilliseconds;

    while (Date.now() < deadline) {
      try {
        await this.checkAppiumReachable(url);
      } catch {
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }

    throw new Error(
      `Something is still serving ${url.origin} ${String(timeoutInMilliseconds)}ms after the Appium server was killed.`
    );
  }

  /**
   * Polls `sys.boot_completed` until the device reports a finished boot.
   *
   * @param deviceId - The device UDID to poll.
   * @param deadline - The absolute time at which to give up.
   * @param emulator - The emulator this run started, so its early death fails fast instead of polling out the deadline. Omitted for a reused device, which this run did not launch and cannot inspect.
   */
  private async waitForBoot(deviceId: string, deadline: number, emulator: ProcessLaunch | undefined): Promise<void> {
    const remainingMs = Math.max(0, deadline - Date.now());
    this.log(
      `Waiting for device ${deviceId} to finish booting (remaining: ${String(remainingMs)}ms, poll: ${String(EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS)}ms)...`
    );

    while (Date.now() < deadline) {
      const isBooted = await new Promise<boolean>((resolve) => {
        execFile(
          'adb',
          ['-s', deviceId, 'shell', 'getprop', 'sys.boot_completed'],
          { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
          (_error, stdout) => {
            resolve(stdout.trim() === '1');
          }
        );
      });

      if (isBooted) {
        this.log(`Device ${deviceId} boot completed.`);
        return;
      }

      const exitInfo = emulator?.readExitInfo();
      if (exitInfo) {
        throw new Error(buildProcessExitMessage({
          exitInfo,
          output: emulator?.readOutput() ?? '',
          outputLabel: 'Emulator output',
          subject: 'Android emulator'
        }));
      }

      await new Promise((resolve) => {
        setTimeout(resolve, EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }

    /*
     * The tail goes on the TIMEOUT too, not only on the exit. An emulator that
     * prints `FATAL | Running multiple emulators with the same AVD` and then
     * lingers never sets `exitInfo`, so this used to be the whole of what the
     * reader got — a budget, with the explanation captured and discarded.
     */
    throw new Error(appendProcessOutputTail(
      `Device "${deviceId}" connected but did not finish booting within ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms.`,
      { output: emulator?.readOutput() ?? '', outputLabel: 'Emulator output' }
    ));
  }

  /**
   * Waits for a booted emulator to become idle before the session is
   * established — whether this run started it or found it already running.
   *
   * `sys.boot_completed` fires before the guest is actually idle — package
   * optimization and services keep churning — so establishing the Appium
   * session immediately makes every serialized UiAutomator2 `adb` round-trip
   * contend with that work and inflates session establishment ~3x. This polls
   * a later, quieter signal (boot animation stopped + package manager serving,
   * via {@link checkDeviceIdle}) and returns as soon as it is satisfied.
   *
   * A **reused** device needs this every bit as much as a started one: being
   * listed in `adb devices` says only that adbd answers, and the churn it does
   * not gate is paid later by whatever polls the WebView.
   *
   * Best-effort: if the guest does not report idle within the budget it logs a
   * warning and proceeds (a slow session is better than a failed run), and a
   * budget of `0` skips the wait entirely.
   *
   * @param deviceId - The device UDID to poll.
   * @param timeoutInMilliseconds - Maximum time to wait; `0` skips the wait.
   */
  private async waitForDeviceIdle(deviceId: string, timeoutInMilliseconds: number): Promise<void> {
    if (timeoutInMilliseconds <= 0) {
      this.log(`Skipping post-boot idle wait for device ${deviceId} (timeout is 0).`);
      return;
    }

    const start = Date.now();
    const deadline = start + timeoutInMilliseconds;
    this.log(
      `Waiting for device ${deviceId} to become idle (timeout: ${String(timeoutInMilliseconds)}ms, poll: ${String(DEVICE_IDLE_POLL_INTERVAL_IN_MILLISECONDS)}ms)...`
    );

    while (Date.now() < deadline) {
      const [bootAnimationProperty, packageListOutput] = await Promise.all([
        this.getDeviceProperty(deviceId, 'init.svc.bootanim'),
        this.listInstalledPackages(deviceId)
      ]);

      if (checkDeviceIdle({ bootAnimationProperty, packageListOutput })) {
        this.log(`Device ${deviceId} is idle after ${String(Date.now() - start)}ms.`);
        return;
      }

      this.log(`Device ${deviceId} not idle yet (elapsed: ${String(Date.now() - start)}ms). Retrying...`);
      await new Promise((resolve) => {
        setTimeout(resolve, DEVICE_IDLE_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }

    this.log(
      `Warning: device ${deviceId} did not report idle within ${String(timeoutInMilliseconds)}ms; proceeding with session establishment anyway.`
    );
  }

  /**
   * Runs both post-boot readiness gates, in order, on a device that has just
   * reported `sys.boot_completed`.
   *
   * The single owner of "which gates a device passes before a session", so the
   * started-device and reused-device branches cannot diverge on it — the branch
   * that skipped a gate entirely is the hole a reused device once fell into (**L43**).
   *
   * @param deviceId - The device UDID to gate on.
   * @param timeouts - The two resolved budgets.
   */
  private async waitForDeviceReady(deviceId: string, timeouts: DeviceReadinessTimeouts): Promise<void> {
    await this.waitForDeviceIdle(deviceId, timeouts.deviceIdleTimeoutInMilliseconds);
    await this.waitForNetworkValidated(deviceId, timeouts.networkReadyTimeoutInMilliseconds);
  }

  /**
   * Waits for a booted emulator to have a **validated default network** before
   * the session is established.
   *
   * The idle gate above says nothing about connectivity, and its two signals are
   * satisfied well before the default network is created and validated — that
   * lands ~80s into guest uptime, tens of seconds after the boot flag on a fast
   * host. A suite started in that gap does not merely run slowly: a test
   * that reaches the network runs to completion against a silently **empty
   * result**, which no assertion inside the suite can distinguish from a
   * genuinely empty response. Only a readiness gate can catch that, which is why
   * this exists (see {@link checkNetworkValidated}, which also records why the
   * three obvious connectivity probes are all wrong).
   *
   * Best-effort, on the same contract as the idle gate: if no validated network
   * appears within the budget it logs a warning **naming the missing network**
   * and proceeds (an offline AVD is still a usable one for suites that never
   * touch the network), and a budget of `0` skips the wait entirely. The warning
   * is the point — the failure it precedes otherwise surfaces as a bare
   * `WebDriverError: script timeout` naming the transport, which reads as a
   * harness defect rather than a missing route.
   *
   * @param deviceId - The device UDID to poll.
   * @param timeoutInMilliseconds - Maximum time to wait; `0` skips the wait.
   */
  private async waitForNetworkValidated(deviceId: string, timeoutInMilliseconds: number): Promise<void> {
    if (timeoutInMilliseconds <= 0) {
      this.log(`Skipping network-ready wait for device ${deviceId} (timeout is 0).`);
      return;
    }

    const start = Date.now();
    const deadline = start + timeoutInMilliseconds;
    this.log(
      `Waiting for device ${deviceId} to report a validated network (timeout: ${String(timeoutInMilliseconds)}ms, poll: ${String(NETWORK_READY_POLL_INTERVAL_IN_MILLISECONDS)}ms)...`
    );

    let probeFailureCount = 0;
    let lastFailureReason = '';

    while (Date.now() < deadline) {
      const probe = await this.dumpConnectivity(deviceId);
      const elapsed = String(Date.now() - start);
      const connectivityOutput = probe.output;

      if (connectivityOutput === undefined) {
        probeFailureCount++;
        lastFailureReason = probe.failureReason ?? 'unknown adb failure';
        this.log(
          `Device ${deviceId} connectivity probe failed (elapsed: ${elapsed}ms): ${lastFailureReason}. Retrying...`
        );
      } else if (checkNetworkValidated({ connectivityOutput })) {
        this.log(`Device ${deviceId} has a validated network after ${elapsed}ms.`);
        return;
      } else {
        this.log(`Device ${deviceId} has no validated network yet (elapsed: ${elapsed}ms). Retrying...`);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, NETWORK_READY_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }

    /*
     * Two different diagnoses, never merged into one sentence: a guest that
     * answered and reported no network is offline, while a guest that never
     * answered says nothing about its network and everything about itself.
     */
    const diagnosis = probeFailureCount > 0
      ? `${String(probeFailureCount)} of its connectivity probes failed, last "${lastFailureReason}", so the guest may be wedged rather than offline`
      : 'it answered every probe and reported no validated default network';
    this.log(
      `Warning: device ${deviceId} reported no validated network within ${String(timeoutInMilliseconds)}ms (${diagnosis}); `
        + 'proceeding with session establishment anyway. Tests that reach the network will run against a device with no route, '
        + 'and may return EMPTY RESULTS rather than fail — read any empty-looking assertion failure below as a missing network first.'
    );
  }

  /**
   * Waits for the emulator this run launched to produce a device, and for that
   * device to become usable.
   *
   * @param deviceIdsBefore - The devices connected before the launch.
   * @param emulator - The launcher, polled for an early exit.
   * @param timeouts - The two post-boot readiness budgets.
   * @param onDeviceAppeared - Called with the new device the moment it is listed, before the readiness gates.
   * @returns The new device's id.
   */
  private async waitForNewDevice(
    deviceIdsBefore: string[],
    emulator: ProcessLaunch,
    timeouts: DeviceReadinessTimeouts,
    onDeviceAppeared: (deviceId: string) => void
  ): Promise<string> {
    this.log(
      `Waiting for a new device to appear in ADB (timeout: ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms, poll: ${String(EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS)}ms)...`
    );
    const deadline = Date.now() + EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS;

    while (Date.now() < deadline) {
      const currentIds = await this.getConnectedDeviceIds();
      const newIds = currentIds.filter((id) => !deviceIdsBefore.includes(id));

      if (newIds.length > 0) {
        const actualDeviceId = newIds[0] ?? '';
        this.log(`Device ${actualDeviceId} appeared in ADB, waiting for boot to complete...`);
        onDeviceAppeared(actualDeviceId);
        await this.waitForBoot(actualDeviceId, deadline, emulator);
        await this.waitForDeviceReady(actualDeviceId, timeouts);
        await this.wakeScreen(actualDeviceId);
        return actualDeviceId;
      }

      const exitInfo = emulator.readExitInfo();
      if (exitInfo) {
        throw new Error(buildProcessExitMessage({
          exitInfo,
          output: emulator.readOutput(),
          outputLabel: 'Emulator output',
          subject: 'Android emulator'
        }));
      }

      await new Promise((resolve) => {
        setTimeout(resolve, EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }

    // As in `waitForBoot`: an emulator that hangs has as much to say as one that dies.
    throw new Error(appendProcessOutputTail(
      `No new emulator device appeared within ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms.`,
      { output: emulator.readOutput(), outputLabel: 'Emulator output' }
    ));
  }

  private async wakeScreen(deviceId: string): Promise<void> {
    this.log(`Waking screen on device ${deviceId}...`);

    await this.sendKeyEvent(deviceId, KEYCODE_WAKEUP, 'wake screen');
    await this.sendKeyEvent(deviceId, KEYCODE_MENU, 'dismiss lock screen');

    this.log(`Screen wake complete on device ${deviceId}.`);
  }
}

/**
 * Creates a new transport instance from the given options.
 *
 * @param options - Transport configuration. Defaults to an owned desktop CDP transport.
 * @returns A new transport instance.
 */
export async function createTransportFromOptions(options?: ObsidianTransportOptions): Promise<ObsidianTransport> {
  const type = options?.type ?? DEFAULT_TRANSPORT_TYPE;

  if (!options || options.type === 'obsidian-cdp') {
    return createCdpTransport(options);
  }

  const factory = new AppiumTransportFactory(type);
  return factory.create(options);
}

/**
 * Returns a cached transport instance, creating one from the given options
 * if not already cached.
 *
 * The transport is cached per worker process so WebSocket/Appium sessions
 * are reused across calls within the same test worker.
 *
 * This is the single entry point every worker-side caller uses for the **ambient**
 * transport, so it is also where a failed global setup is turned into a failing test.
 * A failed setup publishes no transport options, and `undefined` options mean the owned
 * **desktop** CDP default — so without this guard an Android project's suite would run
 * on desktop and then die on an unrelated CDP error, hiding the real cause (**L9**).
 * The setup path itself is unaffected: `coreSetup` builds its transport through
 * {@link createTransportFromOptions} with explicit options.
 *
 * @param options - Transport configuration. Defaults to an owned desktop CDP transport.
 * @returns The cached or newly created transport.
 * @throws {IntegrationSetupFailedError} When this project's global setup failed.
 */
export async function getOrCreateTransport(options?: ObsidianTransportOptions): Promise<ObsidianTransport> {
  const setupError = getSetupError();
  if (setupError) {
    throw new IntegrationSetupFailedError(setupError);
  }

  if (cachedTransport) {
    return cachedTransport;
  }

  const result = await createTransportFromOptions(options);
  // eslint-disable-next-line require-atomic-updates -- Single-threaded worker; no concurrent writes.
  cachedTransport = result;
  return result;
}

/**
 * Stops every emulator this harness started whose run can no longer stop it
 * itself, verifying each stop.
 *
 * For the global teardown of a Vitest project whose transport lives in its test
 * workers rather than in a transport global setup: the worker auto-starts the
 * emulator, Vitest ends the worker without a teardown, and only the main
 * process's teardown gets a turn — holding no handle to the emulator, but able
 * to find it by its marker (`emulator-marker.ts`).
 *
 * Call it while holding the `android` setup lock (L7): that is what guarantees
 * no other Android run is using a marked emulator. Emulators without a marker are
 * never touched.
 */
export async function stopHarnessStartedEmulators(): Promise<void> {
  const reclaimer = new EmulatorReclaimer((message) => {
    log(`[transport-factory:${ANDROID_APPIUM_TRANSPORT_TYPE}] ${message}`);
  });
  await reclaimer.reclaimLeftoverEmulators({ scope: 'end-of-run' });
}

/**
 * Verifies the harness-owned instance a worker was told to attach to is still
 * serving CDP, before handing back a transport that can only fail against it.
 *
 * This is the once-per-file check: transport creation is cached per worker, so
 * a live instance pays one loopback request per test file and a dead one turns
 * the whole file into a single named error, raised before the first test. It
 * replaces the `ECONNREFUSED`-per-file cascade a mid-run death used to produce —
 * and the per-file probe consumers were writing into their own `setupFiles` to
 * get the same effect.
 *
 * Only for the harness's own instances: a plain attach targets a foreign
 * Obsidian whose absence is the user's to resolve, and `preflightCheck` already
 * has a story for it.
 *
 * @param host - The CDP host to probe.
 * @param port - The CDP port to probe.
 * @throws {OwnedInstanceExitedError} When nothing is serving CDP on the port.
 */
async function assertHarnessOwnedInstanceIsServing(host: string, port: number): Promise<void> {
  const cdpUrl = `http://${host}:${String(port)}`;
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    await response.body?.cancel();
    return;
  } catch {
    // Nothing is listening — the instance the global setup launched is gone.
  }

  throw buildOwnedInstanceExitedErrorFromMarker(cdpUrl, readOwnedInstanceExitMarker(port));
}

/**
 * Builds the platform's "who holds this port" query.
 *
 * `netstat` cannot filter by port, so the whole table comes back and the parser
 * does the matching; `lsof` filters server-side and answers with bare PIDs.
 *
 * @param port - The port to query.
 * @returns The command and arguments to run.
 */
function buildPortOwnerQuery(port: number): HostCommandQuery {
  return process.platform === 'win32'
    ? { command: 'netstat', commandArguments: ['-ano'] }
    : { command: 'lsof', commandArguments: ['-ti', `tcp:${String(port)}`] };
}

/**
 * Creates a desktop CDP transport. When an explicit `port` is given the
 * transport attaches to an already-running Obsidian on that port; otherwise it
 * launches and owns an isolated instance (the default, hermetic mode).
 *
 * @param options - CDP transport options.
 * @returns A configured CDP transport.
 */
async function createCdpTransport(options?: ObsidianCdpTransportOptions): Promise<ObsidianTransport> {
  if (options?.port !== undefined) {
    const ownedSuffix = options.isHarnessOwnedInstance ? ' (harness-owned)' : '';
    log(`[transport-factory:obsidian-cdp] Attaching to running Obsidian${ownedSuffix} (host=${options.host ?? 'localhost'}, port=${String(options.port)})`);
    if (options.isHarnessOwnedInstance) {
      await assertHarnessOwnedInstanceIsServing(options.host ?? 'localhost', options.port);
    }
    return new DesktopCdpTransport(normalizeOptionalProperties<DesktopCdpTransportConfig>({
      cdpHost: options.host,
      cdpPort: options.port,
      commandTimeoutInMilliseconds: options.commandTimeoutInMilliseconds,
      isHarnessOwnedInstance: options.isHarnessOwnedInstance
    }));
  }

  log('[transport-factory:obsidian-cdp] Creating owned isolated Obsidian instance');
  // Before `resolveOwnedInstanceConfig`, which may download and cache an installer shell:
  // A structurally invalid config folder name cannot become valid later, so paying for a
  // Provisioning round-trip first would only delay the same failure.
  if (options?.configDirectory !== undefined) {
    assertValidConfigDirectory(options.configDirectory);
  }
  const ownedInstance = await resolveOwnedInstanceConfig(options);
  return new DesktopCdpTransport(normalizeOptionalProperties<DesktopCdpTransportConfig>({
    cdpHost: options?.host,
    commandTimeoutInMilliseconds: options?.commandTimeoutInMilliseconds,
    configDirectory: options?.configDirectory,
    deadBootGraceInMilliseconds: resolveDeadBootGraceInMilliseconds(options),
    isObsidianAppVisible: options?.isObsidianAppVisible,
    ownedInstance,
    shouldDisableSandbox: options?.shouldDisableSandbox,
    shouldThrowOnSilentAsarFallback: willThrowOnSilentAsarFallback(options?.shouldThrowOnSilentAsarFallback),
    shouldWarnOnCompatibilityIssues: willWarnOnCompatibilityIssues(options?.shouldWarnOnCompatibilityIssues)
  }));
}

/**
 * Creates a fresh, isolated user-data directory for an owned instance.
 *
 * @returns The absolute path to the new directory.
 */
function createOwnedUserDataDirectory(): string {
  const root = join(tmpdir(), HARNESS_TEMP_DIR_NAME);
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, OWNED_USER_DATA_DIR_PREFIX));
}

/**
 * Returns the first rejection reason among settled outcomes.
 *
 * @param outcomes - The settled outcomes, at least one of which is expected to have rejected.
 * @returns The first rejection reason, or a stand-in error when none rejected.
 */
function getSettledFailure(outcomes: readonly PromiseSettledResult<unknown>[]): unknown {
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      return outcome.reason;
    }
  }

  return new Error('Android provisioning failed without naming a reason.');
}

/**
 * Loads `webdriverio` on demand.
 *
 * The load is deferred because a static import would drag the whole WebDriver
 * stack (`webdriverio` + `@wdio/*` + `archiver`/`cheerio`/`jszip`) into every
 * consumer of this package's index — `evalInObsidian` reaches this module — when
 * only the Appium transport needs it. Nothing on the desktop CDP path touches
 * `webdriverio` at all.
 *
 * It also keeps `chalk` out of that graph. `@wdio/logger` imports `chalk@5`,
 * whose internal `#supports-color` subpath import Jest's VM-modules linker fails
 * to link, so an eagerly-imported `webdriverio` kills a Jest ESM suite at import
 * with `ReferenceError: Cannot access 'supportsColor' before initialization`
 * before a single test runs — which is what once made `test:jest` red. A
 * `moduleNameMapper` cannot patch it: the mapper is bypassed for `#` specifiers.
 *
 * @returns A {@link Promise} that resolves to the `webdriverio` entry points the
 * Appium factory calls.
 */
async function importWebdriverio(): Promise<WebdriverioModule> {
  // eslint-disable-next-line no-restricted-syntax -- `webdriverio` is Appium-only, so it must be loaded lazily: a static import would drag the whole WebDriver stack into every consumer of this package's index, and `chalk` with it (see the doc comment).
  return await import('webdriverio');
}

/**
 * Parses a port-owner listing with the platform's parser.
 *
 * @param params - The raw output and the port that was queried.
 * @returns The PIDs holding the port.
 */
function parsePortOwnerPids(params: ParsePortOwnerPidsParams): number[] {
  return process.platform === 'win32'
    ? parseWindowsNetstatPids({ netstatOutput: params.output, port: params.port })
    : parsePosixLsofPids(params.output);
}

/**
 * Runs the proactive installer↔app compatibility check for an asar-swap and acts
 * on the verdict: for an installer below the app's run floor either throws
 * {@link IncompatibleInstallerVersionError} (when
 * {@link ResolveAndReportCompatibilityParams.shouldThrowOnIncompatibleInstaller})
 * or proceeds to launch with a warning; for a runnable-but-below-recommended
 * installer logs a warning. Both warnings are suppressed when
 * {@link ResolveAndReportCompatibilityParams.shouldWarnOnCompatibilityIssues} is
 * `false`.
 *
 * @param params - The resolved versions and the warn/throw knobs.
 * @returns The verdict, or `undefined` when there is no asar-swap to check.
 */
function resolveAndReportCompatibility(params: ResolveAndReportCompatibilityParams): InstallerCompatibility | undefined {
  const { appVersion, installerVersion, shouldThrowOnIncompatibleInstaller, shouldWarnOnCompatibilityIssues } = params;
  if (appVersion === undefined) {
    return undefined;
  }

  const compatibility = resolveInstallerCompatibility({
    appVersion,
    installerVersion,
    metadata: getVersionMetadata(appVersion)
  });

  const action = resolveInstallerCompatibilityAction({
    shouldThrowOnIncompatibleInstaller,
    shouldWarnOnCompatibilityIssues,
    tier: compatibility.tier
  });

  if (action === 'throw') {
    throw new IncompatibleInstallerVersionError({
      appVersion: compatibility.appVersion,
      installerVersion: ensureNonNullable(compatibility.installerVersion),
      minRunnableInstallerVersion: ensureNonNullable(compatibility.minRunnableInstallerVersion)
    });
  }

  if (action === 'warn-unrunnable') {
    log(
      `[transport-factory:obsidian-cdp] Obsidian installer ${ensureNonNullable(compatibility.installerVersion)} is below the `
        + `run floor ${ensureNonNullable(compatibility.minRunnableInstallerVersion)} for Obsidian ${compatibility.appVersion}; `
        + 'proceeding to launch (shouldThrowOnIncompatibleInstaller is false) — the boot will likely dead-boot.'
    );
  } else if (action === 'warn-nagged') {
    log(`[transport-factory:obsidian-cdp] ${ensureNonNullable(compatibility.message)}`);
  }

  return compatibility;
}

/**
 * Decides how the requested app (asar) version will be applied to an owned
 * instance, without downloading anything yet: an upgrade-only asar-swap onto the
 * shell, a downgrade to the app's own installer shell, or the user's newest
 * installed asar when neither version is pinned.
 *
 * @param options - CDP transport options.
 * @param shellVersion - The resolved installer/shell version, or `undefined`.
 * @returns The asar plan (at most one of its fields is set).
 */
async function resolveAsarPlan(
  options: ObsidianCdpTransportOptions | undefined,
  shellVersion: string | undefined
): Promise<AsarPlan> {
  if (options?.obsidianVersion !== undefined) {
    const asarVersion = await resolveConcreteVersion(options.obsidianVersion);
    if (shellVersion !== undefined && compareVersions(asarVersion, shellVersion) >= 0) {
      return { asarVersionToSwap: asarVersion };
    }

    // Asar-swap is upgrade-only, so it cannot apply a version older than the
    // Shell's bundled one — and when the shell version is unknown (a Linux
    // Path-parse miss) we cannot prove the swap would apply at all. In both
    // Cases use the requested version's own installer shell, whose bundled asar
    // Is exactly this version, so the pin is always honored.
    log(`[transport-factory:obsidian-cdp] Using the ${asarVersion} installer shell (shell version ${shellVersion ?? 'unknown'}; asar-swap is upgrade-only).`);
    return { downgradeInstallerVersion: asarVersion };
  }

  if (options?.obsidianInstallerVersion === undefined) {
    const newest = findNewestAsar(getObsidianConfigDirectory());
    if (newest && (shellVersion === undefined || compareVersions(newest.version, shellVersion) >= 0)) {
      return { asar: { path: newest.path, version: newest.version } };
    }
  }

  return {};
}

/**
 * Resolves the locally-installed Obsidian shell, tolerating its absence.
 *
 * Unlike {@link resolveObsidianExecutable} (which throws when Obsidian is not
 * installed), this returns `undefined` in that case, so a caller pinning an
 * installer version can fall back to downloading the pinned shell instead of
 * failing on a host with no Obsidian installed (e.g. CI).
 *
 * @returns The installed shell's path and detected version, or `undefined` when
 *   no Obsidian is installed.
 */
async function resolveInstalledShellOrNull(): Promise<InstalledShell | undefined> {
  try {
    const exePath = await resolveObsidianExecutable();
    return { exePath, shellVersion: detectInstalledShellVersion(exePath) };
  } catch {
    return undefined;
  }
}

/**
 * Resolves the shell executable, asar provisioning, and isolated user-data dir
 * for a harness-owned instance from the requested version knobs.
 *
 * - `obsidianInstallerVersion` pins the Electron shell (downloads + extracts a
 *   portable build when it differs from the installed shell).
 * - `obsidianVersion` pins the app: an asar-swap when it is >= the shell version
 *   (cheap), otherwise the matching installer shell is used (downgrade).
 * - When neither is set, the user's newest installed asar is copied in (so the
 *   owned instance matches the version the user currently runs) with zero network.
 *
 * The concrete (app, installer) version pair is resolved *before* any shell/asar
 * download, so a proactive installer↔app compatibility check
 * ({@link resolveInstallerCompatibility}) can fail fast: an installer below the
 * app's run floor throws {@link IncompatibleInstallerVersionError} before
 * anything is downloaded or launched (superseding the reactive dead-boot
 * fast-fail for table-known combos), and a runnable-but-below-recommended
 * installer logs a warning. The verdict is threaded onto the returned config so
 * the transport can surface it as data.
 *
 * @param options - CDP transport options.
 * @returns The resolved owned-instance config.
 */
async function resolveOwnedInstanceConfig(options?: ObsidianCdpTransportOptions): Promise<OwnedInstanceConfig> {
  // Resolve the concrete shell (installer) version first, but for a pinned
  // Installer DEFER resolving/downloading the actual shell until after the
  // Proactive compatibility check, so an unrunnable pin fails fast — before the
  // (possibly slow) installed-shell detection and any download.
  let exePath: string | undefined;
  let shellVersion: string | undefined;
  let pinnedInstallerVersion: string | undefined;

  if (options?.obsidianInstallerVersion === undefined) {
    exePath = await resolveObsidianExecutable();
    shellVersion = detectInstalledShellVersion(exePath);
  } else {
    // A pinned installer version fully determines the shell version up front,
    // Without requiring a locally-installed Obsidian (a CI runner has none).
    pinnedInstallerVersion = await resolveConcreteVersion(options.obsidianInstallerVersion);
    shellVersion = pinnedInstallerVersion;
  }

  // Decide how the app (asar) version will be applied, still WITHOUT downloading.
  const plan = await resolveAsarPlan(options, shellVersion);

  // The app version that will run as an asar-swap onto `shellVersion` — the only
  // Combination that can dead-boot. The downgrade / own-installer paths run the
  // App's own installer shell, so they always boot and are not checked.
  const swapAppVersion = plan.asarVersionToSwap ?? plan.asar?.version;
  const compatibility = resolveAndReportCompatibility({
    appVersion: swapAppVersion,
    installerVersion: shellVersion,
    shouldThrowOnIncompatibleInstaller: willThrowOnIncompatibleInstaller(options?.shouldThrowOnIncompatibleInstaller),
    shouldWarnOnCompatibilityIssues: willWarnOnCompatibilityIssues(options?.shouldWarnOnCompatibilityIssues)
  });

  // The pin is known runnable — resolve/download the deferred shell + asar now.
  // Reuse the installed shell only when it already matches the pin (saves the
  // Download); otherwise download and extract the pinned installer.
  if (pinnedInstallerVersion !== undefined) {
    const installed = await resolveInstalledShellOrNull();
    exePath = installed?.shellVersion === pinnedInstallerVersion ? installed.exePath : await ensureShellCached(pinnedInstallerVersion);
  }
  if (plan.downgradeInstallerVersion !== undefined) {
    exePath = await ensureShellCached(plan.downgradeInstallerVersion);
  }

  const asar = plan.asarVersionToSwap === undefined
    ? plan.asar
    : { path: await ensureAsarCached(plan.asarVersionToSwap), version: plan.asarVersionToSwap };

  return {
    ...(asar && { asar }),
    ...(compatibility && { compatibility }),
    exePath: ensureNonNullable(exePath),

    userDataDirectory: createOwnedUserDataDirectory()
  };
}

/**
 * Removes `Connection` and `Content-Length` from a WebDriver request's headers.
 *
 * The bundled `webdriver` package sets both headers explicitly. They are
 * forbidden request headers per the Fetch spec: Node up to 25 accepted them
 * silently, but Node 26 rejects them with `UND_ERR_INVALID_ARG`, breaking the
 * Appium `/session` request. The transport layer manages connection reuse and
 * the Fetch API computes `Content-Length` from the body, so dropping both is
 * safe on every Node version. See {@link https://github.com/webdriverio/webdriverio/issues/15265}.
 *
 * @param requestOptions - The request options about to be sent by WebDriverIO.
 * @returns The same request options with the forbidden headers removed.
 */
function stripForbiddenFetchHeaders(requestOptions: RequestInit): RequestInit {
  if (requestOptions.headers instanceof Headers) {
    requestOptions.headers.delete('Connection');
    requestOptions.headers.delete('Content-Length');
  }

  return requestOptions;
}

/* v8 ignore stop */
