/**
 * @file
 *
 * Factory for creating transport instances from {@link ObsidianTransportOptions}.
 */

/* v8 ignore start -- Integration-time factory covered by integration tests, not unit tests. */

import type { ChildProcess } from 'node:child_process';

import {
  execFile,
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
import {
  attach,
  remote
} from 'webdriverio';

import type { InstallerCompatibility } from './installer-compatibility.ts';
import type { OwnedInstanceConfig } from './transport-desktop-cdp.ts';
import type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianCdpTransportOptions,
  ObsidianTransportOptions
} from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';

import {
  checkIsAppiumDriverInstalled,
  resolveShouldAutoInstallAppiumDependencies,
  UIAUTOMATOR2_DRIVER_NAME
} from './appium-dependencies.ts';
import {
  resolveAppiumStartTimeoutInMilliseconds,
  resolveSessionConnectionRetryTimeoutInMilliseconds
} from './appium-session-config.ts';
import {
  checkDeviceIdle,
  resolveDeviceIdleTimeoutInMilliseconds
} from './device-readiness.ts';
import { buildEmulatorArgs } from './emulator-args.ts';
import { exec } from './exec.ts';
import { IncompatibleInstallerVersionError } from './incompatible-installer-version-error.ts';
import { checkInstallerCompatibility } from './installer-compatibility.ts';
import { killProcessTree } from './kill-process-tree.ts';
import { log } from './log.ts';
import { getObsidianConfigDir } from './obsidian-config.ts';
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
import { resolveDeadBootGraceInMilliseconds } from './renderer-boot-detection.ts';
import { AppiumTransport } from './transport-appium.ts';
import { DesktopCdpTransport } from './transport-desktop-cdp.ts';
import { ensureNonNullable } from './type-guards.ts';
import {
  shouldHideAppiumConsole,
  shouldHideEmulatorWindow
} from './visibility.ts';

const APP_PACKAGE = 'md.obsidian';
const APP_ACTIVITY = `${APP_PACKAGE}.MainActivity`;
const ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS = 5000;
const APPIUM_CONNECTION_RETRY_COUNT = 3;
const APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS = 5000;
const APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS = 500;
const OWNED_USER_DATA_PREFIX = 'userdata-';
// Appium insecure feature letting the UiAutomator2 driver auto-download a
// Chromedriver matching Obsidian's WebView Chrome version. Enabling it on the
// Appium server (it has no effect as a capability) avoids the failure
// "No Chromedriver found that can automate Chrome ...".
const CHROMEDRIVER_AUTODOWNLOAD_FEATURE = 'uiautomator2:chromedriver_autodownload';
const COMMAND_TIMEOUT_IN_MILLISECONDS = 300;
const DEFAULT_TRANSPORT_TYPE = 'obsidian-cdp';
const DEVICE_IDLE_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS = 120000;
const EMULATOR_OUTPUT_TAIL_MAX_LENGTH = 8000;
const KEYCODE_MENU = 82;
const KEYCODE_WAKEUP = 224;
const SERVER_INSTALL_TIMEOUT_IN_MILLISECONDS = 120000;
const SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS = 120000;

/**
 * How the requested app (asar) version will be applied to an owned instance; at
 * most one field is set (see {@link resolveAsarPlan}).
 */
interface AsarPlan {
  /** The user's newest installed asar to provision as-is (no download). */
  readonly asar?: OwnedInstanceConfig['asar'];

  /** The app version to download and asar-swap onto the shell. */
  readonly asarVersionToSwap?: string | undefined;

  /** The app version whose own installer shell to download (a downgrade). */
  readonly downgradeInstallerVersion?: string | undefined;
}

/**
 * Details of an emulator process that has exited.
 */
interface EmulatorExitInfo {
  /** Exit code, or `null` if the process was terminated by a signal. */
  code: null | number;

  /** Terminating signal, or `null` if the process exited normally. */
  signal: NodeJS.Signals | null;
}

/**
 * A spawned emulator process together with helpers to inspect its captured
 * output and exit status.
 */
interface EmulatorLaunch {
  /** The spawned emulator process. */
  process: ChildProcess;

  /** Returns the exit details once the process has exited, otherwise `undefined`. */
  readExitInfo: () => EmulatorExitInfo | undefined;

  /** Returns the captured stdout+stderr (bounded to the most recent output). */
  readOutput: () => string;

  /** Stops accumulating output. Call once startup has succeeded. */
  stopCapture: () => void;
}

/**
 * Parameters for {@link AppiumTransportFactory.ensureDeviceConnected}.
 */
interface EnsureDeviceConnectedParams {
  /** AVD name to connect to (starting a new emulator if not already running). */
  readonly avdName: string;

  /** Resolved timeout in milliseconds for the post-boot device-idle wait (`0` skips it). */
  readonly deviceIdleTimeoutInMilliseconds: number;

  /** Whether the auto-started emulator window is shown (omitted → hidden). */
  readonly isEmulatorVisible?: boolean | undefined;
}

/**
 * Result of {@link AppiumTransportFactory.ensureDeviceConnected}.
 */
interface EnsureDeviceConnectedResult {
  /** The actual device ID that is connected (may differ from the requested one). */
  readonly actualDeviceId: string;

  /** The emulator process, if one was auto-started. */
  readonly emulatorProcess?: ChildProcess | undefined;
}

/**
 * The locally-installed Obsidian shell resolved by {@link resolveInstalledShellOrNull}.
 */
interface InstalledShell {
  /** Absolute path to the installed shell executable. */
  readonly exePath: string;

  /** The detected shell version, or `undefined` when it cannot be determined. */
  readonly shellVersion: string | undefined;
}

/**
 * Parameters for {@link AppiumTransportFactory.startAppiumAndEmulator}.
 */
interface StartAppiumAndEmulatorParams {
  /** Resolved timeout in milliseconds for the auto-started Appium server to become ready. */
  readonly appiumStartTimeoutInMilliseconds: number;

  /** The Appium server URL. */
  readonly appiumUrl: URL;

  /** AVD name to start. */
  readonly avdName: string;

  /** Resolved timeout in milliseconds for the post-boot device-idle wait (`0` skips it). */
  readonly deviceIdleTimeoutInMilliseconds: number;

  /** Whether the auto-started Appium server console window is shown (omitted → hidden). */
  readonly isAppiumConsoleVisible?: boolean | undefined;

  /** Whether the auto-started emulator window is shown (omitted → hidden). */
  readonly isEmulatorVisible?: boolean | undefined;

  /** The Appium server port. */
  readonly port: number;

  /** Whether missing Appium dependencies may be auto-installed before the server is auto-started. */
  readonly shouldAutoInstallAppiumDependencies: boolean;

  /** Whether Appium auto-start is allowed. */
  readonly shouldAutoStartAppium?: boolean | undefined;
}

/**
 * Result of {@link AppiumTransportFactory.startAppiumAndEmulator}.
 */
interface StartAppiumAndEmulatorResult {
  /** The actual device ID that is connected (may differ from the requested one). */
  readonly actualDeviceId: string;

  /** The Appium server process, if one was auto-started. */
  readonly appiumProcess?: ChildProcess | undefined;

  /** The emulator process, if one was auto-started. */
  readonly emulatorProcess?: ChildProcess | undefined;
}

let cachedTransport: ObsidianTransport | undefined;

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
      ...(options.layoutReadyTimeoutInMilliseconds !== undefined && { layoutReadyTimeoutInMilliseconds: options.layoutReadyTimeoutInMilliseconds }),
      ...(options.vaultBasePath !== undefined && { vaultBasePath: options.vaultBasePath }),
      ...(options.webviewTimeoutInMilliseconds !== undefined && { webviewTimeoutInMilliseconds: options.webviewTimeoutInMilliseconds })
    });
  }

  private checkAppiumReachable(url: URL): Promise<void> {
    return new Promise((resolve, reject) => {
      const statusUrl = new URL('/status', url);
      const req = http.get(statusUrl, { timeout: APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS }, (res) => {
        res.resume();
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        reject(
          new Error(
            `Appium server at ${url.origin} did not respond within ${String(APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS)}ms. Is the Appium server running?`
          )
        );
      });
      req.on('error', (err) => {
        reject(
          new Error(
            `Cannot reach Appium server at ${url.origin}: ${err.message}. Is the Appium server running?`
          )
        );
      });
    });
  }

  private async createNewSession(options: ObsidianAndroidAppiumTransportOptions): Promise<ObsidianTransport> {
    this.log(`Creating AppiumTransport (url=${options.appiumUrl}, avd=${options.avdName})`);

    const url = new URL(options.appiumUrl);

    const port = Number(url.port);
    if (isNaN(port)) {
      throw new Error(`Invalid port in appiumUrl: ${url.port}`);
    }

    const appId = options.appId ?? APP_PACKAGE;

    let appiumProcess: ChildProcess | undefined;
    let emulatorProcess: ChildProcess | undefined;

    try {
      const result = await this.startAppiumAndEmulator({
        appiumStartTimeoutInMilliseconds: resolveAppiumStartTimeoutInMilliseconds(options),
        appiumUrl: url,
        avdName: options.avdName,
        deviceIdleTimeoutInMilliseconds: resolveDeviceIdleTimeoutInMilliseconds(options),
        isAppiumConsoleVisible: options.isAppiumConsoleVisible,
        isEmulatorVisible: options.isEmulatorVisible,
        port,
        shouldAutoInstallAppiumDependencies: resolveShouldAutoInstallAppiumDependencies(options),
        shouldAutoStartAppium: options.shouldAutoStartAppium
      });

      appiumProcess = result.appiumProcess;
      emulatorProcess = result.emulatorProcess;
      const actualDeviceId = result.actualDeviceId;

      const sessionConnectionRetryTimeout = resolveSessionConnectionRetryTimeoutInMilliseconds(options);
      this.log(
        `Connecting to Appium (device=${actualDeviceId}, app=${appId}, retryTimeout: ${String(sessionConnectionRetryTimeout)}ms, retries: ${String(APPIUM_CONNECTION_RETRY_COUNT)})...`
      );
      const browser = await remote({
        capabilities: {
          'appium:appActivity': APP_ACTIVITY,
          'appium:appPackage': appId,
          'appium:autoGrantPermissions': true,
          'appium:automationName': 'UiAutomator2',
          'appium:newCommandTimeout': COMMAND_TIMEOUT_IN_MILLISECONDS,
          'appium:noReset': true,
          'appium:udid': actualDeviceId,
          'appium:uiautomator2ServerInstallTimeout': SERVER_INSTALL_TIMEOUT_IN_MILLISECONDS,
          'appium:uiautomator2ServerLaunchTimeout': SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS,
          'platformName': 'Android'
        },
        connectionRetryCount: APPIUM_CONNECTION_RETRY_COUNT,
        connectionRetryTimeout: sessionConnectionRetryTimeout,
        hostname: url.hostname,
        logLevel: 'warn',
        path: url.pathname,
        port,
        transformRequest: stripForbiddenFetchHeaders
      });

      this.log('Appium session established.');
      const appiumTransport = new AppiumTransport({
        appId,
        browser,
        deviceId: actualDeviceId,
        platform: 'android',
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
          killAutoStartedProcesses();
        }
      };

      transport.disposeSync = (): void => {
        killAutoStartedProcesses();
      };

      return transport;

      function killAutoStartedProcesses(): void {
        if (appiumProcess) {
          killProcessTree(appiumProcess);
          // Cannot use this.log inside nested function — `this` is not captured.
          log(`[transport-factory:${options.type}] Auto-started Appium server stopped.`);
        }
        if (emulatorProcess) {
          killProcessTree(emulatorProcess);
          log(`[transport-factory:${options.type}] Auto-started emulator stopped.`);
        }
      }
    } catch (error: unknown) {
      if (appiumProcess) {
        killProcessTree(appiumProcess);
        this.log('Killed auto-started Appium server after connection failure.');
      }
      if (emulatorProcess) {
        killProcessTree(emulatorProcess);
        this.log('Killed auto-started emulator after connection failure.');
      }
      throw error;
    }
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
    this.log('Appium installed.');
  }

  private async ensureDeviceConnected(params: EnsureDeviceConnectedParams): Promise<EnsureDeviceConnectedResult> {
    const { avdName, deviceIdleTimeoutInMilliseconds, isEmulatorVisible } = params;
    const deviceIdsBefore = await this.getConnectedDeviceIds();
    this.log(`Checking existing devices for AVD "${avdName}"... (connected: [${deviceIdsBefore.join(', ')}])`);

    const existingDeviceId = await this.findDeviceByAvdName(avdName, deviceIdsBefore);

    if (existingDeviceId) {
      this.log(`AVD "${avdName}" is already running on device ${existingDeviceId}, reusing.`);
      await this.suppressErrorDialogs(existingDeviceId);
      return { actualDeviceId: existingDeviceId };
    }

    this.log(`AVD "${avdName}" not found on any existing device, starting a new emulator...`);
    const emulator = this.startEmulator(avdName, isEmulatorVisible);

    let actualDeviceId: string;
    try {
      actualDeviceId = await this.waitForNewDevice(deviceIdsBefore, emulator, deviceIdleTimeoutInMilliseconds);
    } finally {
      emulator.stopCapture();
    }

    this.log(`Emulator "${avdName}" started, device ${actualDeviceId} is connected.`);
    await this.suppressErrorDialogs(actualDeviceId);
    return { actualDeviceId, emulatorProcess: emulator.process };
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

  private async findDeviceByAvdName(avdName: string, deviceIds: string[]): Promise<string | undefined> {
    for (const deviceId of deviceIds) {
      const runningAvd = await new Promise<string>((resolve) => {
        execFile(
          'adb',
          ['-s', deviceId, 'emu', 'avd', 'name'],
          { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
          (_error, stdout) => {
            resolve(stdout.split('\n')[0]?.trim() ?? '');
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
    const output = await new Promise<string>((resolve, reject) => {
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

    const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    return lines
      .filter((line) => line.includes('\tdevice'))
      .map((line) => line.split('\t')[0] ?? '');
  }

  private getDeviceProp(deviceId: string, prop: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        'adb',
        ['-s', deviceId, 'shell', 'getprop', prop],
        { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
        (error, stdout) => {
          // Return no output on timeout/error (not partial stdout) so a non-responsive guest reads as "not idle".
          resolve(error ? '' : stdout);
        }
      );
    });
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

  private log(message: string): void {
    log(`[transport-factory:${this.type}] ${message}`);
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
    const { appiumStartTimeoutInMilliseconds, appiumUrl, avdName, deviceIdleTimeoutInMilliseconds, isAppiumConsoleVisible, isEmulatorVisible, port, shouldAutoInstallAppiumDependencies, shouldAutoStartAppium } = params;

    let needsAppiumStart = false;

    this.log(`Checking Appium server at ${appiumUrl.href}...`);
    try {
      await this.checkAppiumReachable(appiumUrl);
      this.log('Appium server is reachable.');
    } catch (error: unknown) {
      if (shouldAutoStartAppium === false) {
        throw error;
      }
      needsAppiumStart = true;
    }

    let appiumProcess: ChildProcess | undefined;

    if (needsAppiumStart) {
      if (shouldAutoInstallAppiumDependencies) {
        await this.ensureAppiumDependencies();
      }
      this.log(`Appium not reachable, auto-starting on port ${String(port)}...`);
      appiumProcess = this.startAppiumServer(port, isAppiumConsoleVisible);
    }

    try {
      const [, deviceResult] = await Promise.all([
        needsAppiumStart
          ? this.waitForAppiumReady(appiumUrl, appiumStartTimeoutInMilliseconds).then(() => {
            this.log('Auto-started Appium server is ready.');
          })
          : Promise.resolve(),
        this.ensureDeviceConnected({ avdName, deviceIdleTimeoutInMilliseconds, isEmulatorVisible })
      ]);

      return {
        actualDeviceId: deviceResult.actualDeviceId,
        appiumProcess,
        emulatorProcess: deviceResult.emulatorProcess
      };
    } catch (error: unknown) {
      if (appiumProcess) {
        killProcessTree(appiumProcess);
        this.log('Killed auto-started Appium server after startup failure.');
      }
      throw error;
    }
  }

  private startAppiumServer(port: number, isAppiumConsoleVisible?: boolean): ChildProcess {
    const isConsoleHidden = shouldHideAppiumConsole(isAppiumConsoleVisible);
    const child = spawn(`npx appium --log-timestamp --port ${String(port)} --allow-insecure=${CHROMEDRIVER_AUTODOWNLOAD_FEATURE}`, {
      detached: true,
      shell: true,
      stdio: isConsoleHidden ? 'ignore' : ['ignore', 'inherit', 'inherit'],
      windowsHide: isConsoleHidden
    });

    child.unref();
    return child;
  }

  private startEmulator(avdName: string, isEmulatorVisible?: boolean): EmulatorLaunch {
    const emulatorBinary = this.resolveEmulatorBinary();
    const args = buildEmulatorArgs({ avdName, isHidden: shouldHideEmulatorWindow(isEmulatorVisible) });
    this.log(`Running: ${emulatorBinary} ${args.join(' ')}`);
    /*
     * Pipe (rather than ignore) stdout/stderr so an early failure such as
     * "x86_64 emulation currently requires hardware acceleration" can be
     * surfaced immediately instead of waiting out the full boot timeout.
     */
    const child = spawn(emulatorBinary, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let capturedOutput = '';
    let exitInfo: EmulatorExitInfo | undefined;
    let isCapturing = true;

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
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

  private async waitForAppiumReady(url: URL, timeoutInMilliseconds: number): Promise<void> {
    const start = Date.now();
    this.log(
      `Waiting for Appium at ${url.href} (timeout: ${String(timeoutInMilliseconds)}ms, poll: ${String(APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS)}ms)...`
    );
    const deadline = start + timeoutInMilliseconds;

    while (Date.now() < deadline) {
      try {
        await this.checkAppiumReachable(url);
        this.log(`Appium server ready after ${String(Date.now() - start)}ms.`);
        return;
      } catch {
        this.log(`Appium server not ready yet (elapsed: ${String(Date.now() - start)}ms). Retrying...`);
        await new Promise((resolve) => {
          setTimeout(resolve, APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS);
        });
      }
    }

    throw new Error(
      `Auto-started Appium server did not become ready within ${String(timeoutInMilliseconds)}ms`
    );
  }

  private async waitForBoot(deviceId: string, deadline: number, emulator: EmulatorLaunch): Promise<void> {
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

      const exitInfo = emulator.readExitInfo();
      if (exitInfo) {
        throw new Error(buildEmulatorExitMessage(exitInfo, emulator.readOutput()));
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
   * Waits for a freshly-booted emulator to become idle before the session is
   * established.
   *
   * `sys.boot_completed` fires before the guest is actually idle — package
   * optimization and services keep churning — so establishing the Appium
   * session immediately makes every serialized UiAutomator2 `adb` round-trip
   * contend with that work and inflates session establishment ~3x. This polls
   * a later, quieter signal (boot animation stopped + package manager serving,
   * via {@link checkDeviceIdle}) and returns as soon as it is satisfied.
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
      const [bootAnimationProp, packageListOutput] = await Promise.all([
        this.getDeviceProp(deviceId, 'init.svc.bootanim'),
        this.listInstalledPackages(deviceId)
      ]);

      if (checkDeviceIdle({ bootAnimationProp, packageListOutput })) {
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

  private async waitForNewDevice(deviceIdsBefore: string[], emulator: EmulatorLaunch, deviceIdleTimeoutInMilliseconds: number): Promise<string> {
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
        await this.waitForDeviceIdle(actualDeviceId, deviceIdleTimeoutInMilliseconds);
        await this.wakeScreen(actualDeviceId);
        return actualDeviceId;
      }

      const exitInfo = emulator.readExitInfo();
      if (exitInfo) {
        throw new Error(buildEmulatorExitMessage(exitInfo, emulator.readOutput()));
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
 * @param options - Transport configuration. Defaults to CLI transport.
 * @returns The cached or newly created transport.
 */
export async function getOrCreateTransport(options?: ObsidianTransportOptions): Promise<ObsidianTransport> {
  if (cachedTransport) {
    return cachedTransport;
  }

  const result = await createTransportFromOptions(options);
  // eslint-disable-next-line require-atomic-updates -- Single-threaded worker; no concurrent writes.
  cachedTransport = result;
  return result;
}

/**
 * Builds a descriptive error message for an emulator process that exited during
 * startup, appending the captured output tail when available.
 *
 * @param exitInfo - The emulator's exit details.
 * @param output - The captured stdout+stderr tail.
 * @returns A human-readable error message.
 */
function buildEmulatorExitMessage(exitInfo: EmulatorExitInfo, output: string): string {
  const reason = exitInfo.signal === null
    ? `exited prematurely with code ${String(exitInfo.code)}`
    : `was terminated by signal ${exitInfo.signal}`;
  const trimmedOutput = output.trim();
  const details = trimmedOutput.length > 0
    ? `\n\nEmulator output (tail):\n${trimmedOutput}`
    : '';
  return `Android emulator ${reason} during startup.${details}`;
}

/**
 * Runs the proactive installer↔app compatibility check for an asar-swap and acts
 * on the verdict: throws {@link IncompatibleInstallerVersionError} for an
 * installer below the app's run floor, and logs a warning for a
 * runnable-but-below-recommended installer.
 *
 * @param appVersion - The app (asar) version that will be swapped onto the shell,
 *   or `undefined` when no asar-swap will happen (nothing is checked then).
 * @param installerVersion - The resolved installer/shell version, or `undefined`.
 * @returns The verdict, or `undefined` when there is no asar-swap to check.
 */
function checkAndReportCompatibility(
  appVersion: string | undefined,
  installerVersion: string | undefined
): InstallerCompatibility | undefined {
  if (appVersion === undefined) {
    return undefined;
  }

  const compatibility = checkInstallerCompatibility({
    appVersion,
    installerVersion,
    metadata: getVersionMetadata(appVersion)
  });

  if (compatibility.tier === 'unrunnable') {
    throw new IncompatibleInstallerVersionError({
      appVersion: compatibility.appVersion,
      installerVersion: ensureNonNullable(compatibility.installerVersion),
      minRunnableInstallerVersion: ensureNonNullable(compatibility.minRunnableInstallerVersion)
    });
  }

  if (compatibility.tier === 'nagged') {
    log(`[transport-factory:obsidian-cdp] ${ensureNonNullable(compatibility.message)}`);
  }

  return compatibility;
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
    return new DesktopCdpTransport({
      ...(options.host !== undefined && { cdpHost: options.host }),
      cdpPort: options.port,
      ...(options.commandTimeoutInMilliseconds !== undefined && { commandTimeoutInMilliseconds: options.commandTimeoutInMilliseconds }),
      ...(options.isHarnessOwnedInstance !== undefined && { isHarnessOwnedInstance: options.isHarnessOwnedInstance })
    });
  }

  log('[transport-factory:obsidian-cdp] Creating owned isolated Obsidian instance');
  const ownedInstance = await resolveOwnedInstanceConfig(options);
  return new DesktopCdpTransport({
    ...(options?.host !== undefined && { cdpHost: options.host }),
    ...(options?.commandTimeoutInMilliseconds !== undefined && { commandTimeoutInMilliseconds: options.commandTimeoutInMilliseconds }),
    deadBootGraceInMilliseconds: resolveDeadBootGraceInMilliseconds(options),
    ...(options?.isObsidianAppVisible !== undefined && { isObsidianAppVisible: options.isObsidianAppVisible }),
    ownedInstance,
    ...(options?.shouldDisableSandbox !== undefined && { shouldDisableSandbox: options.shouldDisableSandbox })
  });
}

/**
 * Creates a fresh, isolated user-data directory for an owned instance.
 *
 * @returns The absolute path to the new directory.
 */
function createOwnedUserDataDir(): string {
  const root = join(tmpdir(), 'obsidian-integration-testing');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, OWNED_USER_DATA_PREFIX));
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
    const newest = findNewestAsar(getObsidianConfigDir());
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
 * ({@link checkInstallerCompatibility}) can fail fast: an installer below the
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
  const compatibility = checkAndReportCompatibility(swapAppVersion, shellVersion);

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
    userDataDir: createOwnedUserDataDir()
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
