/**
 * @file
 *
 * Factory for creating transport instances from {@link ObsidianTransportOptions}.
 */

/* v8 ignore start -- Integration-time factory covered by integration tests, not unit tests. */

import type { ChildProcess } from 'node:child_process';

import { spawn } from 'node:child_process';
import http from 'node:http';
import { remote } from 'webdriverio';

import type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianTransportOptions
} from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';

import { AppiumTransport } from './transport-appium.ts';
import { DesktopCdpTransport } from './transport-desktop-cdp.ts';
import { DesktopCliTransport } from './transport-desktop-cli.ts';

const APP_PACKAGE = 'md.obsidian';
const APP_ACTIVITY = `${APP_PACKAGE}.MainActivity`;
const APPIUM_CONNECTION_RETRY_COUNT = 1;
const APPIUM_CONNECTION_RETRY_TIMEOUT_IN_MILLISECONDS = 10000;
const APPIUM_PREFLIGHT_TIMEOUT_IN_MILLISECONDS = 5000;
const APPIUM_START_POLL_INTERVAL_IN_MILLISECONDS = 500;
const APPIUM_START_TIMEOUT_IN_MILLISECONDS = 30000;
const CDP_DEFAULT_PORT = 8315;
const COMMAND_TIMEOUT_IN_MILLISECONDS = 300;
const SERVER_LAUNCH_TIMEOUT_IN_MILLISECONDS = 30000;

let cachedTransport: ObsidianTransport | undefined;

/**
 * Creates a new transport instance from the given options.
 *
 * @param options - Transport configuration. Defaults to CLI transport.
 * @returns A new transport instance.
 */
export async function createTransportFromOptions(options?: ObsidianTransportOptions): Promise<ObsidianTransport> {
  if (!options || options.type === 'obsidian-cli') {
    console.warn('[transport-factory] Creating DesktopCliTransport (no options or type=obsidian-cli)');
    return new DesktopCliTransport();
  }

  if (options.type === 'obsidian-cdp') {
    console.warn(`[transport-factory] Creating DesktopCdpTransport (host=${options.host ?? 'localhost'}, port=${String(options.port ?? CDP_DEFAULT_PORT)})`);
    return new DesktopCdpTransport({
      ...(options.host !== undefined && { cdpHost: options.host }),
      ...(options.port !== undefined && { cdpPort: options.port }),
      ...(options.commandTimeoutInMilliseconds !== undefined && { commandTimeoutInMilliseconds: options.commandTimeoutInMilliseconds })
    });
  }

  console.warn(`[transport-factory] Creating AppiumTransport (url=${options.appiumUrl}, device=${options.deviceId})`);
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

  console.warn(`[transport-factory] Checking Appium server at ${options.appiumUrl}...`);
  let appiumProcess: ChildProcess | undefined;

  try {
    await checkAppiumReachable(url);
    console.warn('[transport-factory] Appium server is reachable.');
  } catch (error: unknown) {
    if (options.shouldAutoStartAppium === false) {
      throw error;
    }

    console.warn(`[transport-factory] Appium not reachable, auto-starting on port ${String(port)}...`);
    appiumProcess = startAppiumServer(port);
    await waitForAppiumReady(url);
    console.warn('[transport-factory] Auto-started Appium server is ready.');
  }

  console.warn(`[transport-factory] Connecting to Appium (device=${options.deviceId}, app=${appId})...`);
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

  console.warn('[transport-factory] Appium session established.');
  const transport = new AppiumTransport({
    appId,
    browser,
    platform: 'android',
    ...(options.vaultBasePath !== undefined && { vaultBasePath: options.vaultBasePath })
  });

  if (appiumProcess) {
    const originalDispose = transport.dispose.bind(transport);
    transport.dispose = async (): Promise<void> => {
      await originalDispose();
      appiumProcess.kill();
      console.warn('[transport-factory] Auto-started Appium server stopped.');
    };
  }

  return transport;
}

/**
 * Spawns an Appium server as a detached background process.
 *
 * @param port - The port to start Appium on.
 * @returns The spawned child process.
 */
function startAppiumServer(port: number): ChildProcess {
  const child = spawn('npx', ['appium', '--port', String(port)], {
    detached: true,
    shell: true,
    stdio: 'ignore'
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

/* v8 ignore stop */
