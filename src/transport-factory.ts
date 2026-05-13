/**
 * @file
 *
 * Factory for creating transport instances from {@link ObsidianTransportOptions}.
 */

/* v8 ignore start -- Integration-time factory covered by integration tests, not unit tests. */

import type { ChildProcess } from 'node:child_process';

import {
  execFile,
  execFileSync,
  spawn
} from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { remote } from 'webdriverio';

import type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianTransportOptions
} from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';

import { buildEmulatorArgs } from './emulator-args.ts';
import { log } from './log.ts';
import { AppiumTransport } from './transport-appium.ts';
import { DesktopCdpTransport } from './transport-desktop-cdp.ts';
import { DesktopCliTransport } from './transport-desktop-cli.ts';

const APP_PACKAGE = 'md.obsidian';
const APP_ACTIVITY = `${APP_PACKAGE}.MainActivity`;
const ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS = 5000;
const APPIUM_CONNECTION_RETRY_COUNT = 3;
const APPIUM_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS = 180000;
const APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS = 5000;
const APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS = 500;
const APPIUM_START_TIMEOUT_IN_MILLISECONDS = 60000;
const CDP_DEFAULT_PORT = 8315;
const COMMAND_TIMEOUT_IN_MILLISECONDS = 300;
const DEFAULT_TRANSPORT_TYPE = 'obsidian-cli';
const EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS = 120000;
const KEYCODE_MENU = 82;
const KEYCODE_WAKEUP = 224;
const SERVER_INSTALL_TIMEOUT_IN_MILLISECONDS = 120000;
const SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS = 120000;

/**
 * Result of {@link AppiumTransportFactory.ensureDeviceConnected}.
 */
interface EnsureDeviceConnectedResult {
  /** The actual device ID that is connected (may differ from the requested one). */
  actualDeviceId: string;

  /** The emulator process, if one was auto-started. */
  emulatorProcess?: ChildProcess | undefined;
}

/**
 * Parameters for {@link AppiumTransportFactory.startAppiumAndEmulator}.
 */
interface StartAppiumAndEmulatorParams {
  /** The Appium server URL. */
  appiumUrl: URL;

  /** AVD name to start. */
  avdName: string;

  /** The Appium server port. */
  port: number;

  /** Whether Appium auto-start is allowed. */
  shouldAutoStartAppium?: boolean | undefined;
}

/**
 * Result of {@link AppiumTransportFactory.startAppiumAndEmulator}.
 */
interface StartAppiumAndEmulatorResult {
  /** The actual device ID that is connected (may differ from the requested one). */
  actualDeviceId: string;

  /** The Appium server process, if one was auto-started. */
  appiumProcess?: ChildProcess | undefined;

  /** The emulator process, if one was auto-started. */
  emulatorProcess?: ChildProcess | undefined;
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
   * @param options - Android Appium transport options.
   * @returns A configured Appium transport.
   */
  public async create(options: ObsidianAndroidAppiumTransportOptions): Promise<ObsidianTransport> {
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
        appiumUrl: url,
        avdName: options.avdName,
        port,
        shouldAutoStartAppium: options.shouldAutoStartAppium
      });

      appiumProcess = result.appiumProcess;
      emulatorProcess = result.emulatorProcess;
      const actualDeviceId = result.actualDeviceId;

      this.log(
        `Connecting to Appium (device=${actualDeviceId}, app=${appId}, retryTimeout: ${String(APPIUM_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS)}ms, retries: ${
          String(APPIUM_CONNECTION_RETRY_COUNT)
        })...`
      );
      const browser = await remote({
        capabilities: {
          'appium:appActivity': APP_ACTIVITY,
          'appium:appPackage': appId,
          'appium:autoGrantPermissions': true,
          'appium:automationName': 'UiAutomator2',
          'appium:newCommandTimeout': COMMAND_TIMEOUT_IN_MILLISECONDS,
          'appium:noReset': true,
          'appium:settings': {
            'appium:chromedriverAutodownload': true
          },
          'appium:udid': actualDeviceId,
          'appium:uiautomator2ServerInstallTimeout': SERVER_INSTALL_TIMEOUT_IN_MILLISECONDS,
          'appium:uiautomator2ServerLaunchTimeout': SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS,
          'platformName': 'Android'
        },
        connectionRetryCount: APPIUM_CONNECTION_RETRY_COUNT,
        connectionRetryTimeout: APPIUM_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS,
        hostname: url.hostname,
        logLevel: 'warn',
        path: url.pathname,
        port
      });

      this.log('Appium session established.');
      const appiumTransport = new AppiumTransport({
        appId,
        browser,
        deviceId: actualDeviceId,
        platform: 'android',
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

  private async ensureDeviceConnected(avdName: string): Promise<EnsureDeviceConnectedResult> {
    const deviceIdsBefore = await this.getConnectedDeviceIds();
    this.log(`Checking existing devices for AVD "${avdName}"... (connected: [${deviceIdsBefore.join(', ')}])`);

    const existingDeviceId = await this.findDeviceByAvdName(avdName, deviceIdsBefore);

    if (existingDeviceId) {
      this.log(`AVD "${avdName}" is already running on device ${existingDeviceId}, reusing.`);
      return { actualDeviceId: existingDeviceId };
    }

    this.log(`AVD "${avdName}" not found on any existing device, starting a new emulator...`);
    const emulatorProcess = this.startEmulator(avdName);
    const actualDeviceId = await this.waitForNewDevice(deviceIdsBefore);
    this.log(`Emulator "${avdName}" started, device ${actualDeviceId} is connected.`);
    return { actualDeviceId, emulatorProcess };
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
    const { appiumUrl, avdName, port, shouldAutoStartAppium } = params;

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
      this.log(`Appium not reachable, auto-starting on port ${String(port)}...`);
      appiumProcess = this.startAppiumServer(port);
    }

    try {
      const [, deviceResult] = await Promise.all([
        needsAppiumStart
          ? this.waitForAppiumReady(appiumUrl).then(() => {
            this.log('Auto-started Appium server is ready.');
          })
          : Promise.resolve(),
        this.ensureDeviceConnected(avdName)
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

  private startAppiumServer(port: number): ChildProcess {
    const child = spawn(`npx appium --log-timestamp --port ${String(port)}`, {
      detached: true,
      shell: true,
      stdio: ['ignore', 'inherit', 'inherit']
    });

    child.unref();
    return child;
  }

  private startEmulator(avdName: string): ChildProcess {
    const emulatorBinary = this.resolveEmulatorBinary();
    const args = buildEmulatorArgs(avdName);
    this.log(`Running: ${emulatorBinary} ${args.join(' ')}`);
    const child = spawn(emulatorBinary, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    child.unref();
    return child;
  }

  private async waitForAppiumReady(url: URL): Promise<void> {
    this.log(
      `Waiting for Appium at ${url.href} (timeout: ${String(APPIUM_START_TIMEOUT_IN_MILLISECONDS)}ms, poll: ${
        String(APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS)
      }ms)...`
    );
    const deadline = Date.now() + APPIUM_START_TIMEOUT_IN_MILLISECONDS;

    while (Date.now() < deadline) {
      try {
        await this.checkAppiumReachable(url);
        return;
      } catch {
        await new Promise((resolve) => {
          setTimeout(resolve, APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS);
        });
      }
    }

    throw new Error(
      `Auto-started Appium server did not become ready within ${String(APPIUM_START_TIMEOUT_IN_MILLISECONDS)}ms`
    );
  }

  private async waitForBoot(deviceId: string, deadline: number): Promise<void> {
    const remainingMs = Math.max(0, deadline - Date.now());
    this.log(
      `Waiting for device ${deviceId} to finish booting (remaining: ${String(remainingMs)}ms, poll: ${
        String(EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS)
      }ms)...`
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

      await new Promise((resolve) => {
        setTimeout(resolve, EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }

    throw new Error(
      `Device "${deviceId}" connected but did not finish booting within ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms.`
    );
  }

  private async waitForNewDevice(deviceIdsBefore: string[]): Promise<string> {
    this.log(
      `Waiting for a new device to appear in ADB (timeout: ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms, poll: ${
        String(EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS)
      }ms)...`
    );
    const deadline = Date.now() + EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS;

    while (Date.now() < deadline) {
      const currentIds = await this.getConnectedDeviceIds();
      const newIds = currentIds.filter((id) => !deviceIdsBefore.includes(id));

      if (newIds.length > 0) {
        const actualDeviceId = newIds[0] ?? '';
        this.log(`Device ${actualDeviceId} appeared in ADB, waiting for boot to complete...`);
        await this.waitForBoot(actualDeviceId, deadline);
        await this.wakeScreen(actualDeviceId);
        return actualDeviceId;
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
 * @param options - Transport configuration. Defaults to CLI transport.
 * @returns A new transport instance.
 */
export async function createTransportFromOptions(options?: ObsidianTransportOptions): Promise<ObsidianTransport> {
  const type = options?.type ?? DEFAULT_TRANSPORT_TYPE;

  if (!options || options.type === 'obsidian-cli') {
    log(`[transport-factory:${type}] Creating DesktopCliTransport`);
    return new DesktopCliTransport();
  }

  if (options.type === 'obsidian-cdp') {
    log(`[transport-factory:${type}] Creating DesktopCdpTransport (host=${options.host ?? 'localhost'}, port=${String(options.port ?? CDP_DEFAULT_PORT)})`);
    return new DesktopCdpTransport({
      ...(options.host !== undefined && { cdpHost: options.host }),
      ...(options.port !== undefined && { cdpPort: options.port }),
      ...(options.commandTimeoutInMilliseconds !== undefined && { commandTimeoutInMilliseconds: options.commandTimeoutInMilliseconds })
    });
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
 * Kills a child process and its entire process tree.
 *
 * On Windows, `child.kill()` only sends SIGTERM to the direct process,
 * leaving spawned grandchildren (e.g. QEMU, UiAutomator) alive.
 * `taskkill /F /T /PID` forcefully terminates the entire tree.
 *
 * @param child - The child process to kill.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } catch (error: unknown) {
      log(
        `[transport-factory] taskkill for PID ${String(child.pid)} failed (may have already exited): ${
          error instanceof Error ? error.message : 'unknown error'
        }`
      );
    }
  } else {
    child.kill('SIGKILL');
  }
}

/* v8 ignore stop */
