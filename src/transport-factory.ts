/**
 * @file
 *
 * Factory for creating transport instances from {@link ObsidianTransportOptions}.
 */

/* v8 ignore start -- Integration-time factory covered by integration tests, not unit tests. */

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
    return new DesktopCliTransport();
  }

  if (options.type === 'obsidian-cdp') {
    return new DesktopCdpTransport({
      ...(options.host !== undefined && { cdpHost: options.host }),
      ...(options.port !== undefined && { cdpPort: options.port }),
      ...(options.commandTimeoutInMilliseconds !== undefined && { commandTimeoutInMilliseconds: options.commandTimeoutInMilliseconds })
    });
  }

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
    hostname: url.hostname,
    path: url.pathname,
    port
  });

  return new AppiumTransport({
    appId,
    browser,
    platform: 'android',
    ...(options.vaultBasePath !== undefined && { vaultBasePath: options.vaultBasePath })
  });
}

/* v8 ignore stop */
