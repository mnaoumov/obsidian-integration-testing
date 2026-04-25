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
import http from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { remote } from 'webdriverio';

import type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianTransportOptions
} from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';

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
const EMULATOR_BOOT_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS = 120000;
const KEYCODE_MENU = 82;
const KEYCODE_WAKEUP = 224;
const SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS = 30000;

/**
 * Parameters for {@link ensureDeviceConnected}.
 */
interface EnsureDeviceConnectedParams {
  /** AVD name to auto-start if the device is not connected. */
  avdName?: string | undefined;

  /** Device UDID to check (e.g. `'emulator-5554'`). */
  deviceId: string;
}

/**
 * Parameters for {@link startAppiumAndEmulator}.
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
 * Creates a new transport instance from the given options.
 *
 * @param options - Transport configuration. Defaults to CLI transport.
 * @returns A new transport instance.
 */
export async function createTransportFromOptions(options?: ObsidianTransportOptions): Promise<ObsidianTransport> {
  if (!options || options.type === 'obsidian-cli') {
    log('[transport-factory] Creating DesktopCliTransport (no options or type=obsidian-cli)');
    return new DesktopCliTransport();
  }

  if (options.type === 'obsidian-cdp') {
    log(`[transport-factory] Creating DesktopCdpTransport (host=${options.host ?? 'localhost'}, port=${String(options.port ?? CDP_DEFAULT_PORT)})`);
    return new DesktopCdpTransport({
      ...(options.host !== undefined && { cdpHost: options.host }),
      ...(options.port !== undefined && { cdpPort: options.port }),
      ...(options.commandTimeoutInMilliseconds !== undefined && { commandTimeoutInMilliseconds: options.commandTimeoutInMilliseconds })
    });
  }

  log(`[transport-factory] Creating AppiumTransport (url=${options.appiumUrl}, device=${options.deviceId})`);
  return createAppiumTransport(options);
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
 * Performs a quick HTTP check against the Appium server's status endpoint.
 *
 * Fails fast (within {@link APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS}) with
 * a clear error message instead of letting WebDriverIO retry silently for minutes.
 *
 * @param url - The parsed Appium URL.
 */
function checkAppiumReachable(url: URL): Promise<void> {
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

/**
 * Checks whether the specified device is connected via ADB.
 *
 * @param deviceId - The device UDID to check (e.g. `'emulator-5554'`).
 * @returns `true` if the device is connected and in the `device` state.
 */
async function checkDeviceConnected(deviceId: string): Promise<boolean> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile('adb', ['devices'], { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to run 'adb devices': ${error.message}. Is ADB installed and in PATH?`));
        return;
      }
      if (stderr) {
        log(`[transport-factory] ADB stderr: ${stderr.trim()}`);
      }
      resolve(stdout);
    });
  });

  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const deviceLine = lines.find((line) => line.startsWith(deviceId));
  return deviceLine?.includes('\tdevice') ?? false;
}

/**
 * Creates an Appium transport by establishing a WebDriverIO session.
 *
 * @param options - Android Appium transport options.
 * @returns A configured Appium transport.
 */
async function createAppiumTransport(options: ObsidianAndroidAppiumTransportOptions): Promise<AppiumTransport> {
  const url = new URL(options.appiumUrl);

  const port = Number(url.port);
  if (isNaN(port)) {
    throw new Error(`Invalid port in appiumUrl: ${url.port}`);
  }

  const appId = options.appId ?? APP_PACKAGE;

  let appiumProcess: ChildProcess | undefined;
  let emulatorProcess: ChildProcess | undefined;

  try {
    [appiumProcess, emulatorProcess] = await startAppiumAndEmulator({
      appiumUrl: url,
      avdName: options.avdName,
      deviceId: options.deviceId,
      port,
      shouldAutoStartAppium: options.shouldAutoStartAppium
    });

    log(`[transport-factory] Connecting to Appium (device=${options.deviceId}, app=${appId})...`);
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
      path: url.pathname,
      port
    });

    log('[transport-factory] Appium session established.');
    const transport = new AppiumTransport({
      appId,
      browser,
      platform: 'android',
      ...(options.vaultBasePath !== undefined && { vaultBasePath: options.vaultBasePath })
    });

    const originalDispose = transport.dispose.bind(transport);
    transport.dispose = async (): Promise<void> => {
      await originalDispose();
      if (appiumProcess) {
        appiumProcess.kill();
        log('[transport-factory] Auto-started Appium server stopped.');
      }
      if (emulatorProcess) {
        emulatorProcess.kill();
        log('[transport-factory] Auto-started emulator stopped.');
      }
    };

    return transport;
  } catch (error: unknown) {
    if (appiumProcess) {
      appiumProcess.kill();
      log('[transport-factory] Killed auto-started Appium server after connection failure.');
    }
    if (emulatorProcess) {
      emulatorProcess.kill();
      log('[transport-factory] Killed auto-started emulator after connection failure.');
    }
    throw error;
  }
}

/**
 * Ensures the specified device is connected, optionally auto-starting an
 * emulator if an AVD name is provided.
 *
 * @param params - Device and optional AVD configuration.
 * @param params.avdName - AVD name to auto-start if the device is not connected.
 * @param params.deviceId - Device UDID to check.
 * @returns The emulator child process if one was auto-started, or `undefined`.
 */
async function ensureDeviceConnected(params: EnsureDeviceConnectedParams): Promise<ChildProcess | undefined> {
  const { avdName, deviceId } = params;
  log(`[transport-factory] Checking device ${deviceId} is connected via ADB...`);

  if (await checkDeviceConnected(deviceId)) {
    log(`[transport-factory] Device ${deviceId} is connected.`);
    return undefined;
  }

  if (!avdName) {
    throw new Error(
      `Device "${deviceId}" is not connected. Start the emulator before running integration tests,`
        + ' or set avdName in transport options to auto-start it.'
    );
  }

  log(`[transport-factory] Device ${deviceId} not found, starting emulator AVD "${avdName}"...`);
  const emulatorProcess = startEmulator(avdName);
  await waitForDevice(deviceId);
  log(`[transport-factory] Emulator "${avdName}" started, device ${deviceId} is connected.`);
  return emulatorProcess;
}

/**
 * Resolves the path to the Android emulator binary.
 *
 * Uses `ANDROID_HOME` or `ANDROID_SDK_ROOT` environment variable if set,
 * otherwise falls back to `emulator` (assumes it's in PATH).
 *
 * @returns The path to the emulator binary.
 */
function resolveEmulatorBinary(): string {
  const sdkRoot = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
  if (!sdkRoot) {
    throw new Error(
      'Cannot find Android emulator: neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable is set.'
    );
  }
  return join(sdkRoot, 'emulator', 'emulator');
}

/**
 * Starts the Appium server and emulator in parallel when both need auto-starting.
 *
 * @param params - Configuration for Appium and emulator startup.
 * @returns A tuple of `[appiumProcess, emulatorProcess]`, either of which may be `undefined`.
 */
async function startAppiumAndEmulator(params: StartAppiumAndEmulatorParams): Promise<[ChildProcess | undefined, ChildProcess | undefined]> {
  const { appiumUrl, avdName, deviceId, port, shouldAutoStartAppium } = params;

  let needsAppiumStart = false;

  log(`[transport-factory] Checking Appium server at ${appiumUrl.href}...`);
  try {
    await checkAppiumReachable(appiumUrl);
    log('[transport-factory] Appium server is reachable.');
  } catch (error: unknown) {
    if (shouldAutoStartAppium === false) {
      throw error;
    }
    needsAppiumStart = true;
  }

  let appiumProcess: ChildProcess | undefined;

  if (needsAppiumStart) {
    log(`[transport-factory] Appium not reachable, auto-starting on port ${String(port)}...`);
    appiumProcess = startAppiumServer(port);
  }

  const [, emulatorProcess] = await Promise.all([
    needsAppiumStart
      ? waitForAppiumReady(appiumUrl).then(() => {
        log('[transport-factory] Auto-started Appium server is ready.');
      })
      : Promise.resolve(),
    ensureDeviceConnected({ avdName, deviceId })
  ]);

  return [appiumProcess, emulatorProcess];
}

/**
 * Spawns an Appium server as a detached background process.
 *
 * @param port - The port to start Appium on.
 * @returns The spawned child process.
 */
function startAppiumServer(port: number): ChildProcess {
  const child = spawn(`npx appium --log-timestamp --port ${String(port)}`, {
    detached: true,
    shell: true,
    stdio: ['ignore', 'inherit', 'inherit']
  });

  child.unref();
  return child;
}

/**
 * Spawns an Android emulator as a background process.
 *
 * @param avdName - The AVD name to start.
 * @returns The spawned child process.
 */
function startEmulator(avdName: string): ChildProcess {
  const emulatorBinary = resolveEmulatorBinary();
  log(`[transport-factory] Running: ${emulatorBinary} -avd ${avdName} -no-snapshot-save`);
  const child = spawn(emulatorBinary, ['-avd', avdName, '-no-snapshot-save'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore']
  });

  child.unref();
  return child;
}

/**
 * Polls the Appium server until it responds to `/status`.
 *
 * @param url - The Appium server URL.
 */
async function waitForAppiumReady(url: URL): Promise<void> {
  const deadline = Date.now() + APPIUM_START_TIMEOUT_IN_MILLISECONDS;

  while (Date.now() < deadline) {
    try {
      await checkAppiumReachable(url);
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

/**
 * Waits for the device to finish booting by polling `sys.boot_completed`.
 *
 * @param deviceId - The device UDID.
 * @param deadline - Absolute timestamp deadline.
 */
async function waitForBoot(deviceId: string, deadline: number): Promise<void> {
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
      log(`[transport-factory] Device ${deviceId} boot completed.`);
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

/**
 * Polls `adb devices` until the specified device appears in the `device` state.
 *
 * Also waits for the device to finish booting by checking `sys.boot_completed`.
 *
 * @param deviceId - The device UDID to wait for.
 */
async function waitForDevice(deviceId: string): Promise<void> {
  const deadline = Date.now() + EMULATOR_BOOT_TIMEOUT_IN_MILLISECONDS;

  while (Date.now() < deadline) {
    if (await checkDeviceConnected(deviceId)) {
      log(`[transport-factory] Device ${deviceId} appeared in ADB, waiting for boot to complete...`);
      await waitForBoot(deviceId, deadline);
      await wakeScreen(deviceId);
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

/**
 * Wakes the emulator screen and dismisses the lock screen.
 *
 * After boot, the emulator screen may be off. Sends `KEYCODE_WAKEUP` to turn
 * on the display and `KEYCODE_MENU` to dismiss the lock screen.
 *
 * @param deviceId - The device UDID.
 */
async function wakeScreen(deviceId: string): Promise<void> {
  log(`[transport-factory] Waking screen on device ${deviceId}...`);

  await new Promise<void>((resolve, reject) => {
    execFile(
      'adb',
      ['-s', deviceId, 'shell', 'input', 'keyevent', String(KEYCODE_WAKEUP)],
      { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
      (error) => {
        if (error) {
          reject(new Error(`Failed to wake screen: ${error instanceof Error ? error.message : 'unknown error'}`));
        } else {
          resolve();
        }
      }
    );
  });

  await new Promise<void>((resolve, reject) => {
    execFile(
      'adb',
      ['-s', deviceId, 'shell', 'input', 'keyevent', String(KEYCODE_MENU)],
      { timeout: ADB_DEVICE_CHECK_TIMEOUT_IN_MILLISECONDS },
      (error) => {
        if (error) {
          reject(new Error(`Failed to dismiss lock screen: ${error instanceof Error ? error.message : 'unknown error'}`));
        } else {
          resolve();
        }
      }
    );
  });

  log(`[transport-factory] Screen wake complete on device ${deviceId}.`);
}

/* v8 ignore stop */
