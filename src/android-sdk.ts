/**
 * @file
 *
 * Resolves the Android SDK binaries the harness shells out to.
 *
 * Lives here rather than as a private method on the integration-only
 * `transport-factory` because it is an **agreement**, not an implementation
 * detail: `scripts/emulator-wedge-probe.ts` exists to reproduce a host fault by
 * booting the emulator exactly as a run would, and a probe that resolved a
 * different binary than the harness would quietly measure something else. One
 * function, one answer, both callers.
 *
 * The lookup itself is the SDK's own convention — `ANDROID_HOME` first, then the
 * older `ANDROID_SDK_ROOT` — and it deliberately does **not** fall back to a
 * platform-default install path. A wrong guess would boot some other SDK's
 * emulator and report on it as though it were the configured one; an error that
 * names both variables is the shorter route to a working setup.
 */

import { join } from 'node:path';
import process from 'node:process';

/**
 * Resolves the `emulator` binary from the Android SDK root.
 *
 * No extension is appended: Node's process spawning resolves `emulator.exe` on
 * Windows on its own, and the same path string is what the SDK's own tooling
 * documents.
 *
 * @returns The absolute path to the `emulator` binary.
 * @throws When neither `ANDROID_HOME` nor `ANDROID_SDK_ROOT` is set.
 */
export function resolveEmulatorBinaryPath(): string {
  return join(resolveAndroidSdkRoot(), 'emulator', 'emulator');
}

function resolveAndroidSdkRoot(): string {
  const sdkRoot = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
  if (!sdkRoot) {
    throw new Error(
      'Cannot find Android emulator: neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable is set.'
    );
  }

  return sdkRoot;
}
