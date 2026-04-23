/**
 * @file
 *
 * Android integration test global setup. Use as `globalSetup` in your
 * Vitest config for `*.android.integration.test.ts` files.
 *
 * ```typescript
 * // vitest.config.ts
 * {
 *   test: {
 *     name: 'integration-android',
 *     include: ['src/**\/*.android.integration.test.ts'],
 *     globalSetup: 'obsidian-integration-testing/obsidian-plugin-android-setup',
 *   }
 * }
 * ```
 *
 * Required environment variables (e.g. in `.env`):
 *
 * - `OBSIDIAN_APPIUM_URL` — Appium server URL (e.g. `http://localhost:4723`)
 * - `OBSIDIAN_APPIUM_DEVICE_ID` — Android device/emulator UDID (e.g. `emulator-5554`)
 */

/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import type { TestProject } from 'vitest/node';

import { remote } from 'webdriverio';

import {
  setup as baseSetup,
  teardown as baseTeardown
} from './integration-global-setup.ts';
import { AppiumTransport } from './transport-appium.ts';
import { setTransport } from './transport-state.ts';

const APP_PACKAGE = 'md.obsidian';
const APP_ACTIVITY = `${APP_PACKAGE}.MainActivity`;
const COMMAND_TIMEOUT_MS = 300;
const SERVER_LAUNCH_TIMEOUT_MS = 120000;

let transport: AppiumTransport | undefined;

/**
 * Vitest global setup function for Android integration tests.
 *
 * Creates an Appium session using the WebDriverIO `remote()` function,
 * configures the transport, and delegates to the base setup.
 *
 * Requires `webdriverio` to be installed as a dev dependency in the consumer project.
 *
 * @param project - The Vitest project.
 */
export async function setup(project: TestProject): Promise<void> {
  const appiumUrl = requireEnv('OBSIDIAN_APPIUM_URL');
  const udid = requireEnv('OBSIDIAN_APPIUM_DEVICE_ID');

  const url = new URL(appiumUrl);

  const port = Number(url.port);
  if (isNaN(port)) {
    throw new Error(`Invalid port: ${url.port}`);
  }

  const browser = await remote({
    capabilities: {
      'appium:appActivity': APP_ACTIVITY,
      'appium:appPackage': APP_PACKAGE,
      'appium:autoGrantPermissions': true,
      'appium:automationName': 'UiAutomator2',
      // 'appium:chromedriverAutodownload': true,
      'appium:newCommandTimeout': COMMAND_TIMEOUT_MS,
      'appium:noReset': true,
      'appium:skipServerInstallation': true,
      'appium:udid': udid,
      'appium:uiautomator2ServerLaunchTimeout': SERVER_LAUNCH_TIMEOUT_MS,
      'platformName': 'Android'
    },
    hostname: url.hostname,
    path: url.pathname,
    port
  });

  transport = new AppiumTransport({ browser, platform: 'android' });
  setTransport(transport);

  await baseSetup(project);
}

/**
 * Vitest global teardown function for Android integration tests.
 *
 * Disposes the temp vault and closes the Appium session.
 */
export async function teardown(): Promise<void> {
  await baseTeardown();
  await transport?.dispose();
}

/**
 * Reads a required environment variable or throws.
 *
 * @param name - The environment variable name.
 * @returns The value.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in .env or your shell.`
    );
  }
  return value;
}

/* v8 ignore stop */
