import {
  describe,
  expect,
  it
} from 'vitest';

import { IntegrationSetupFailedError } from './integration-setup-failed-error.ts';

describe('IntegrationSetupFailedError', () => {
  const error = new IntegrationSetupFailedError({
    errorName: 'WebDriverError',
    message: 'WebDriverError: Could not find a connected Android device in 20000ms',
    transportLabel: 'obsidian-android-appium'
  });

  it('is an Error with the specific name', () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('IntegrationSetupFailedError');
  });

  it('names the configured transport and the original failure in the message', () => {
    // The whole point: the report must name the platform the suite was meant to run on and the real
    // Cause, rather than a downstream transport error from a fallback nobody asked for.
    expect(error.message).toContain('obsidian-android-appium');
    expect(error.message).toContain('Could not find a connected Android device');
  });

  it('exposes the original name, message and transport as fields', () => {
    expect(error.errorName).toBe('WebDriverError');
    expect(error.originalMessage).toBe('WebDriverError: Could not find a connected Android device in 20000ms');
    expect(error.transportLabel).toBe('obsidian-android-appium');
  });

  it('carries no stack frames', () => {
    // The global setup already logged the original failure with its own trace; a second trace pointing
    // Into the harness only suggests the harness broke.
    expect(error.stack).toBe(`${error.name}: ${error.message}`);
    expect(error.stack).not.toContain('    at ');
  });
});
