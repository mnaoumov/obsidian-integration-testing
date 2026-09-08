import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { resolveEmulatorBinaryPath } from './android-sdk.ts';

const SDK_ROOT = '/opt/android-sdk';
const LEGACY_SDK_ROOT = '/opt/android-sdk-legacy';
const NO_SDK_ROOT_MESSAGE = 'Cannot find Android emulator: neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable is set.';

/*
 * `vi.stubEnv` mutates the one `process.env` the module under test reads through its `node:process`
 * default import, and `undefined` deletes rather than blanks — which is what lets the refusal cases run
 * green on a developer box where `ANDROID_HOME` is genuinely set.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveEmulatorBinaryPath', () => {
  it('should resolve the emulator under ANDROID_HOME', () => {
    vi.stubEnv('ANDROID_HOME', SDK_ROOT);
    vi.stubEnv('ANDROID_SDK_ROOT', undefined);

    expect(resolveEmulatorBinaryPath()).toBe(join(SDK_ROOT, 'emulator', 'emulator'));
  });

  it('should fall back to the older ANDROID_SDK_ROOT', () => {
    vi.stubEnv('ANDROID_HOME', undefined);
    vi.stubEnv('ANDROID_SDK_ROOT', LEGACY_SDK_ROOT);

    expect(resolveEmulatorBinaryPath()).toBe(join(LEGACY_SDK_ROOT, 'emulator', 'emulator'));
  });

  it('should prefer ANDROID_HOME when both are set', () => {
    vi.stubEnv('ANDROID_HOME', SDK_ROOT);
    vi.stubEnv('ANDROID_SDK_ROOT', LEGACY_SDK_ROOT);

    expect(resolveEmulatorBinaryPath()).toBe(join(SDK_ROOT, 'emulator', 'emulator'));
  });

  /*
   * Naming BOTH variables is the module's stated reason for refusing a platform-default fallback: a wrong
   * guess would boot some other SDK's emulator and report on it as though it were the configured one. So
   * the message is behavior, and asserted verbatim rather than by a substring.
   */
  it('should refuse rather than guess at a platform default, naming both variables', () => {
    vi.stubEnv('ANDROID_HOME', undefined);
    vi.stubEnv('ANDROID_SDK_ROOT', undefined);

    expect(() => resolveEmulatorBinaryPath()).toThrow(NO_SDK_ROOT_MESSAGE);
  });

  it('should treat an empty ANDROID_HOME as no root, rather than joining onto nothing', () => {
    vi.stubEnv('ANDROID_HOME', '');
    vi.stubEnv('ANDROID_SDK_ROOT', LEGACY_SDK_ROOT);

    expect(() => resolveEmulatorBinaryPath()).toThrow(NO_SDK_ROOT_MESSAGE);
  });
});
