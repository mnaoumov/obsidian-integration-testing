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
  mkdtempSync
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppiumServerMarker } from './appium-server-marker.ts';
import type { ProcessListEntry } from './emulator-backend.ts';
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
  listOnlineDeviceIds
} from './adb-device-list.ts';
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
  resolveSessionConnectionRetryTimeoutInMilliseconds
} from './appium-session-config.ts';
import {
  checkAvdExists,
  listAvailableAvds
} from './avd-list.ts';
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
import { buildEmulatorArguments } from './emulator-arguments.ts';
import {
  parsePosixProcessList,
  parseWindowsTaskList,
  selectEmulatorBackendPids
} from './emulator-backend.ts';
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
import {
  parsePosixLsofPids,
  parseWindowsNetstatPids
} from './port-owner.ts';
import { buildProcessExitMessage } from './process-exit-message.ts';
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
import { ensureNonNullable } from './type-guards.ts';
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
const ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS = 5000;
/*
 * `dumpsys connectivity` is far larger than the other probes' output, and Node's
 * default 1 MiB `maxBuffer` would fail the call rather than truncate it — which
 * would read as "not ready" forever and burn the whole network budget.
 */
const ADB_DUMPSYS_MAX_BUFFER_IN_BYTES = 8_388_608;
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
const COMMAND_TIMEOUT_IN_MILLISECONDS = 300;
const DEFAULT_TRANSPORT_TYPE = 'obsidian-cdp';
const DEVICE_IDLE_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS = 120_000;
const EMULATOR_ESCALATED_STOP_TIMEOUT_IN_MILLISECONDS = 5000;
const EMULATOR_LIST_TIMEOUT_IN_MILLISECONDS = 10_000;
const EMULATOR_OUTPUT_TAIL_MAX_LENGTH = 8000;
const EMULATOR_STOP_POLL_INTERVAL_IN_MILLISECONDS = 500;
const EMULATOR_STOP_TIMEOUT_IN_MILLISECONDS = 20_000;
/*
 * 30s, not the 10s a `tasklist` costs on an idle host: this query runs in the
 * same post-boot contention window that inflates every `adb` round-trip 25-50x
 * (L45), and the first end-to-end run overran a 10s budget there — silently
 * disarming the teardown escalation. Sized like `ADB_DUMPSYS_TIMEOUT_IN_MILLISECONDS`,
 * for the same reason.
 */
const HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS = 30_000;
const HTTP_MULTIPLE_CHOICES = 300;
const HTTP_OK = 200;
const KEYCODE_MENU = 82;
const KEYCODE_WAKEUP = 224;
const MILLISECONDS_PER_SECOND = 1000;
const NETWORK_READY_POLL_INTERVAL_IN_MILLISECONDS = 2000;
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
interface CheckIsEmulatorGoneParams {
  /**
  The device the emulator serves.
   */
  readonly deviceId: string;

  /**
  The emulator PIDs this run owns.
   */
  readonly ownedEmulatorPids: readonly number[];
}

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
interface HostCommandQuery {
  /**
  The executable to run.
   */
  readonly command: string;

  /**
  The command's arguments.
   */
  readonly commandArguments: string[];
}

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

interface StopAutoStartedEmulatorParams {
  /**
  The AVD name, named in the warning so the leftover is identifiable.
   */
  readonly avdName: string;

  /**
  The device the emulator is serving, polled to decide whether it actually stopped.
   */
  readonly deviceId: string;

  /**
  The emulator launcher process this run spawned.
   */
  readonly emulatorProcess: ChildProcess;

  /**
  The emulator PIDs this run owns, escalated to when the launcher's tree kill leaves one behind.
   */
  readonly ownedEmulatorPids: readonly number[];
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
  The emulator PIDs this run owns.
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
interface WaitForEmulatorStoppedParams {
  /**
  The device the emulator serves.
   */
  readonly deviceId: string;

  /**
  The emulator PIDs this run owns.
   */
  readonly ownedEmulatorPids: readonly number[];

  /**
  How long to wait for the emulator to disappear, in milliseconds.
   */
  readonly timeoutInMilliseconds: number;
}

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
  private readonly type: string;

  public constructor(type: string) {
    this.type = type;
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
   * Decides whether the emulator this run started is really gone.
   *
   * Two independent proofs, cheapest first: none of the PIDs this run owns is
   * alive, and the device no longer appears in `adb devices` **in any state** (a
   * dying emulator answers `offline` while it still holds the AVD).
   *
   * @param params - The device and the PIDs this run owns.
   * @returns `true` when nothing of this run's emulator is left.
   */
  private async checkIsEmulatorGone(params: CheckIsEmulatorGoneParams): Promise<boolean> {
    if (params.ownedEmulatorPids.some((pid) => checkIsProcessAlive(pid))) {
      return false;
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

  private async connectSession(params: EstablishSessionParams): Promise<Awaited<ReturnType<typeof remote>>> {
    const { remote } = await importWebdriverio();
    return remote({
      capabilities: {
        'appium:appActivity': APP_ACTIVITY,
        'appium:appPackage': params.appId,
        'appium:autoGrantPermissions': true,
        'appium:automationName': 'UiAutomator2',
        'appium:newCommandTimeout': COMMAND_TIMEOUT_IN_MILLISECONDS,
        'appium:noReset': true,
        'appium:udid': params.deviceId,
        'appium:uiautomator2ServerInstallTimeout': SERVER_INSTALL_TIMEOUT_IN_MILLISECONDS,
        'appium:uiautomator2ServerLaunchTimeout': SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS,
        'platformName': 'Android'
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

    try {
      const result = await this.startAppiumAndEmulator({
        appiumStartTimeoutInMilliseconds: resolveAppiumStartTimeoutInMilliseconds(options),
        appiumUrl: url,
        avdName: options.avdName,
        deviceIdleTimeoutInMilliseconds: resolveDeviceIdleTimeoutInMilliseconds(options),
        isAppiumConsoleVisible: options.isAppiumConsoleVisible,
        isEmulatorVisible: options.isEmulatorVisible,
        networkReadyTimeoutInMilliseconds: resolveNetworkReadyTimeoutInMilliseconds(options),
        port,
        shouldAutoInstallAppiumDependencies: willAutoInstallAppiumDependencies(options),
        shouldAutoStartAppium: options.shouldAutoStartAppium
      });

      appiumProcess = result.appiumProcess;
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

      const sessionResult = await this.establishSession({
        appId,
        appiumServerMarker: result.appiumServerMarker,
        appiumStartTimeoutInMilliseconds: resolveAppiumStartTimeoutInMilliseconds(options),
        deviceId: actualDeviceId,
        isAdoptedServer: result.isAdoptedAppiumServer,
        isAppiumConsoleVisible: options.isAppiumConsoleVisible,
        port,
        sessionConnectionRetryTimeoutInMilliseconds: resolveSessionConnectionRetryTimeoutInMilliseconds(options),
        shouldAutoStartAppium: options.shouldAutoStartAppium,
        url
      });

      const browser = sessionResult.browser;
      // A wedged adopted server is replaced by one this run owns, so it must be torn down like any other auto-started server.
      appiumProcess = sessionResult.appiumProcess ?? appiumProcess;

      this.log('Appium session established.');
      const appiumTransport = new AppiumTransport({
        appId,
        browser,
        deviceId: actualDeviceId,
        platform: 'android',
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
    const emulatorBinary = this.resolveEmulatorBinary();
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
    const deviceIdsBefore = await this.getConnectedDeviceIds();
    this.log(`Checking existing devices for AVD "${avdName}"... (connected: [${deviceIdsBefore.join(', ')}])`);

    const existingDeviceId = await this.findDeviceByAvdName(avdName, deviceIdsBefore);

    if (existingDeviceId) {
      this.log(`AVD "${avdName}" is already running on device ${existingDeviceId}, reusing.`);
      await this.suppressErrorDialogs(existingDeviceId);
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
      await this.waitForBoot(existingDeviceId, Date.now() + EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS, undefined);
      await this.waitForDeviceReady(existingDeviceId, timeouts);
      await this.wakeScreen(existingDeviceId);
      // A device this run did not start is not this run's to stop.
      return { actualDeviceId: existingDeviceId, ownedEmulatorPids: [] };
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
    const emulator = this.startEmulator(avdName, isEmulatorVisible);

    let actualDeviceId: string;
    try {
      actualDeviceId = await this.waitForNewDevice(deviceIdsBefore, emulator, timeouts);
    } finally {
      emulator.stopCapture();
    }

    const ownedEmulatorPids = await this.listEmulatorBackendPids(emulatorPidsBefore);
    this.log(
      `Emulator "${avdName}" started, device ${actualDeviceId} is connected (owned emulator PIDs: [${ownedEmulatorPids.join(', ')}]).`
    );
    await this.suppressErrorDialogs(actualDeviceId);
    return { actualDeviceId, emulatorProcess: emulator.process, ownedEmulatorPids };
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

  private async findDeviceByAvdName(avdName: string, deviceIds: string[]): Promise<string | undefined> {
    for (const deviceId of deviceIds) {
      const runningAvd = await new Promise<string>((resolve) => {
        execFile(
          'adb',
          ['-s', deviceId, 'emu', 'avd', 'name'],
          { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
          (_error, stdout) => {
            resolve(stdout.split('\n', 1)[0]?.trim() ?? '');
          }
        );
      });

      if (runningAvd === avdName) {
        return deviceId;
      }
    }

    return undefined;
  }

  private async getConnectedDeviceIds(): Promise<string[]> {
    return listOnlineDeviceIds(await this.getDevicesOutput());
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
   * Runs `adb devices` and returns its raw stdout.
   *
   * The raw listing is what teardown needs: `getConnectedDeviceIds` keeps only
   * the `device` state, and an emulator on its way out answers `offline` while
   * still holding the AVD — see `adb-device-list.ts`.
   *
   * @returns The raw `adb devices` output.
   * @throws If adb could not be run at all.
   */
  private getDevicesOutput(): Promise<string> {
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
    const query = buildHostProcessQuery();
    const output = await new Promise<string>((resolve) => {
      execFile(
        query.command,
        query.commandArguments,
        { maxBuffer: ADB_DUMPSYS_MAX_BUFFER_IN_BYTES, timeout: HOST_PROCESS_QUERY_TIMEOUT_IN_MILLISECONDS },
        (error, stdout) => {
          if (error) {
            this.log(`Warning: could not list host processes (\`${query.command}\`): ${error.message}`);
          }
          resolve(error ? '' : stdout);
        }
      );
    });

    const processes = parseHostProcessList(output);
    if (processes.length === 0) {
      this.log(
        `Warning: \`${query.command}\` listed no processes, so this run cannot identify the emulator backend it owns. Teardown will fall back to \`adb devices\` alone and will have no PID to escalate to.`
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

  private resolveEmulatorBinary(): string {
    const sdkRoot = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
    if (!sdkRoot) {
      throw new Error(
        'Cannot find Android emulator: neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable is set.'
      );
    }
    return join(sdkRoot, 'emulator', 'emulator');
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
    const { appiumStartTimeoutInMilliseconds, appiumUrl, avdName, deviceIdleTimeoutInMilliseconds, isAppiumConsoleVisible, isEmulatorVisible, networkReadyTimeoutInMilliseconds, port, shouldAutoInstallAppiumDependencies, shouldAutoStartAppium } = params;

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
      this.ensureDeviceConnected({ avdName, deviceIdleTimeoutInMilliseconds, isEmulatorVisible, networkReadyTimeoutInMilliseconds })
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

  private startEmulator(avdName: string, isEmulatorVisible?: boolean): ProcessLaunch {
    const emulatorBinary = this.resolveEmulatorBinary();
    const isWindowHidden = shouldHideEmulatorWindow(isEmulatorVisible);
    const input = buildEmulatorArguments({ avdName, isHidden: isWindowHidden });
    const { detached, windowsHide } = resolveEmulatorSpawnFlags(isWindowHidden);
    this.log(`Running: ${emulatorBinary} ${input.join(' ')}`);
    /*
     * Pipe (rather than ignore) stdout/stderr so an early failure such as
     * "x86_64 emulation currently requires hardware acceleration" can be
     * surfaced immediately instead of waiting out the full boot timeout.
     */
    const child = spawn(emulatorBinary, input, {
      detached,
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
   * Stops the emulator this run started, and **verifies** it stopped.
   *
   * The console shutdown goes first because it is the only path that releases
   * the AVD's `multiinstance.lock`; a `taskkill` leaves the lock behind, and a
   * stale lock is what makes the next run fail with `Running multiple emulators
   * with the same AVD` — a FATAL the emulator writes to its own stdout, where
   * nobody sees it.
   *
   * @param params - The emulator process, the device it serves and the PIDs this run owns.
   */
  private async stopAutoStartedEmulator(params: StopAutoStartedEmulatorParams): Promise<void> {
    await this.killEmulatorConsole(params.deviceId);
    killProcessTree(params.emulatorProcess);

    const waitParams: WaitForEmulatorStoppedParams = {
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
          `Auto-started emulator outlived the launcher's process tree; escalating to the backend PID(s) this run started: [${survivingPids.join(', ')}].`
        );
        for (const pid of survivingPids) {
          killProcessTreeByPid(pid);
        }
        isStopped = await this.waitForEmulatorStopped({ ...waitParams, timeoutInMilliseconds: EMULATOR_ESCALATED_STOP_TIMEOUT_IN_MILLISECONDS });
      }
    }

    this.log(buildTeardownMessage({
      evidence: `AVD "${params.avdName}" on device ${params.deviceId}`,
      outcome: resolveTeardownOutcome({ hasEscalated, isStopped }),
      subject: 'Auto-started emulator',
      timeoutInMilliseconds: EMULATOR_STOP_TIMEOUT_IN_MILLISECONDS
    }));
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

    if (params.emulatorProcess) {
      killProcessTree(params.emulatorProcess);
      const survivingPids = params.ownedEmulatorPids.filter((pid) => checkIsProcessAlive(pid));
      for (const pid of survivingPids) {
        killProcessTreeByPid(pid);
      }

      this.log(
        survivingPids.length > 0
          ? `Auto-started emulator: stop requested and surviving backend PID(s) [${survivingPids.join(', ')}] killed — sync teardown cannot wait to confirm.`
          : 'Auto-started emulator: stop requested, no process of this run left running.'
      );
    }
  }

  /**
   * Stops everything this run auto-started, verifying each stop.
   *
   * @param params - Everything this run started.
   */
  private async stopAutoStartedProcessesVerified(params: StopAutoStartedProcessesParams): Promise<void> {
    if (!params.appiumProcess && !params.emulatorProcess) {
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

    if (params.emulatorProcess && params.deviceId !== undefined) {
      await this.stopAutoStartedEmulator({
        avdName: params.avdName,
        deviceId: params.deviceId,
        emulatorProcess: params.emulatorProcess,
        ownedEmulatorPids: params.ownedEmulatorPids
      });
    }
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
       * readiness timeout with no diagnostics (the original T84 symptom).
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

    throw new Error(
      `Device "${deviceId}" connected but did not finish booting within ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms.`
    );
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
   * that skipped a gate entirely is the hole T794 fell into (**L43**).
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
  /**
   * Polls until this run's emulator is gone, or the budget elapses.
   *
   * @param params - The device, the PIDs this run owns, and the budget.
   * @returns `true` when the emulator disappeared within the budget.
   */
  private async waitForEmulatorStopped(params: WaitForEmulatorStoppedParams): Promise<boolean> {
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

  private async waitForNewDevice(deviceIdsBefore: string[], emulator: ProcessLaunch, timeouts: DeviceReadinessTimeouts): Promise<string> {
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

    throw new Error(
      `No new emulator device appeared within ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms.`
    );
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
 * Builds the platform's "list every process" query.
 *
 * @returns The command and arguments to run.
 */
function buildHostProcessQuery(): HostCommandQuery {
  return process.platform === 'win32'
    ? { command: 'tasklist', commandArguments: ['/FO', 'CSV', '/NH'] }
    : { command: 'ps', commandArguments: ['-eo', 'pid=,comm='] };
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
 * before a single test runs — which is what made `test:jest` red (T755). A
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
 * Parses a host process listing with the platform's parser.
 *
 * @param output - Raw stdout of {@link buildHostProcessQuery}'s command.
 * @returns The listed processes.
 */
function parseHostProcessList(output: string): ProcessListEntry[] {
  return process.platform === 'win32' ? parseWindowsTaskList(output) : parsePosixProcessList(output);
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
