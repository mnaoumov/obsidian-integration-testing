import {
  afterEach,
  describe,
  expect,
  it
} from 'vitest';

import { setSetupErrorResolver } from './context-provider.ts';
import { IntegrationSetupFailedError } from './integration-setup-failed-error.ts';
import { getOrCreateTransport } from './transport-factory.ts';

describe('getOrCreateTransport', () => {
  afterEach(() => {
    setSetupErrorResolver(() => undefined);
  });

  it('should throw the original setup failure instead of building a fallback transport', async () => {
    // The regression: with the global setup failed, no transport options reach the worker, and
    // `undefined` options mean the owned DESKTOP default -- so an Android project's suite ran on
    // Desktop and died on an unrelated CDP error. Nothing may be constructed here; if anything were,
    // This test would launch a real Obsidian rather than reject.
    setSetupErrorResolver(() => ({
      errorName: 'WebDriverError',
      message: 'WebDriverError: Could not find a connected Android device in 20000ms',
      transportLabel: 'obsidian-android-appium'
    }));

    await expect(getOrCreateTransport()).rejects.toThrow(IntegrationSetupFailedError);
    await expect(getOrCreateTransport()).rejects.toThrow('Could not find a connected Android device');
  });

  it('should name the transport the failed project was configured for', async () => {
    setSetupErrorResolver(() => ({
      errorName: 'Error',
      message: 'Appium server exited during startup',
      transportLabel: 'obsidian-android-appium'
    }));

    await expect(getOrCreateTransport()).rejects.toThrow('obsidian-android-appium');
  });
});
