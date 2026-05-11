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
const APPIUM_CONNECTION_RETRY_COUNT = 1;
const APPIUM_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS = 60000;
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
const SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS = 30000;

/**
 * Parameters for {@link AppiumTransportFactory.startAppiumAndEmulator}.
 */
interface StartAppiumAndEmulatorParams {
  /** The Appium server URL. */
  appiumUrl: URL;

  /** AVD name to auto-start if the device is not connected. */
  avdName?: string | undefined;

  /** Device UDID. */
  deviceId: string;

  /** The Appium server port. */
  port: number;

  /** Whether Appium auto-start is allowed. */
  shouldAutoStartAppium?: boolean | undefined;
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
    this.log(`Creating AppiumTransport (url=${options.appiumUrl}, device=${options.deviceId})`);

    const url = new URL(options.appiumUrl);

    const port = Number(url.port);
    if (isNaN(port)) {
      throw new Error(`Invalid port in appiumUrl: ${url.port}`);
    }

    const appId = options.appId ?? APP_PACKAGE;

    let appiumProcess: ChildProcess | undefined;
    let emulatorProcess: ChildProcess | undefined;

    try {
      [appiumProcess, emulatorProcess] = await this.startAppiumAndEmulator({
        appiumUrl: url,
        avdName: options.avdName,
        deviceId: options.deviceId,
        port,
        shouldAutoStartAppium: options.shouldAutoStartAppium
      });

      this.log(
        `Connecting to Appium (device=${options.deviceId}, app=${appId}, retryTimeout: ${String(APPIUM_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS)}ms, retries: ${
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
          'appium:skipServerInstallation': true,
          'appium:udid': options.deviceId,
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
        deviceId: options.deviceId,
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

  private async checkDeviceConnected(deviceId: string): Promise<boolean> {
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
    const deviceLine = lines.find((line) => line.startsWith(deviceId));
    return deviceLine?.includes('\tdevice') ?? false;
  }

  private async ensureDeviceConnected(avdName: string | undefined, deviceId: string): Promise<ChildProcess | undefined> {
    this.log(`Checking device ${deviceId} is connected via ADB...`);

    if (await this.checkDeviceConnected(deviceId)) {
      this.log(`Device ${deviceId} is connected.`);
      return undefined;
    }

    if (!avdName) {
      throw new Error(
        `Device "${deviceId}" is not connected. Start the emulator before running integration tests,`
          + ' or set avdName in transport options to auto-start it.'
      );
    }

    this.log(`Device ${deviceId} not found, starting emulator AVD "${avdName}"...`);
    const emulatorProcess = this.startEmulator(avdName);
    await this.waitForDevice(deviceId);
    this.log(`Emulator "${avdName}" started, device ${deviceId} is connected.`);
    return emulatorProcess;
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

  private async startAppiumAndEmulator(params: StartAppiumAndEmulatorParams): Promise<[ChildProcess | undefined, ChildProcess | undefined]> {
    const { appiumUrl, avdName, deviceId, port, shouldAutoStartAppium } = params;

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

    const [, emulatorProcess] = await Promise.all([
      needsAppiumStart
        ? this.waitForAppiumReady(appiumUrl).then(() => {
          this.log('Auto-started Appium server is ready.');
        })
        : Promise.resolve(),
      this.ensureDeviceConnected(avdName, deviceId)
    ]);

    return [appiumProcess, emulatorProcess];
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

  private async waitForDevice(deviceId: string): Promise<void> {
    this.log(
      `Waiting for device ${deviceId} to appear in ADB (timeout: ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms, poll: ${
        String(EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS)
      }ms)...`
    );
    const deadline = Date.now() + EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS;

    while (Date.now() < deadline) {
      if (await this.checkDeviceConnected(deviceId)) {
        this.log(`Device ${deviceId} appeared in ADB, waiting for boot to complete...`);
        await this.waitForBoot(deviceId, deadline);
        await this.wakeScreen(deviceId);
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS);
      });
    }

    throw new Error(
      `Emulator device "${deviceId}" did not appear within ${String(EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS)}ms.`
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
