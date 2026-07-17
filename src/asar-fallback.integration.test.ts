/**
 * @file
 *
 * Integration test for the post-boot **silent-asar-fallback** verify: after an
 * owned instance boots, the transport reads the live running app version over CDP
 * and, when it differs from the swapped-in pin (the installer shell silently ran
 * its own bundled asar instead of the pin), throws `SilentAsarFallbackError` — or,
 * when the throw is disabled, surfaces a `'fallback'` verdict on
 * `CdpConnection.asarFallback`. This is the healthy-UI companion to the
 * black-screen dead-boot fast-fail (`RendererFailedToInitializeError`): a silent
 * fallback renders a real (older) UI, so the dead-boot detector cannot catch it.
 *
 * The canonical fallback pair is app `1.13.0` on the `1.1.9` installer shell:
 * `1.13.0`'s run floor is installer `1.6.5`, and on the below-floor `1.1.9` shell
 * it silently reverts to the shell's bundled `1.1.9` asar (CDP-verified — the
 * mis-measurement this feature guards against). Because `1.1.9` is below `1.13.0`'s
 * run floor, the proactive installer↔app check would throw first, so the boot-based
 * cases also disable that proactive throw (`shouldThrowOnIncompatibleInstaller:
 * false`) to reach the launch. The no-false-positive case pins app `1.13.1` on the
 * same `1.1.9` shell — `1.13.1` genuinely runs there (its run floor IS `1.1.9`), so
 * the running version matches the pin and the verdict is `'match'`.
 *
 * Pinning `obsidianInstallerVersion` downloads/extracts a multi-hundred-MB shell
 * and launches Electron, so — like the other download-and-boot suites — it is
 * opt-in via `OBSIDIAN_TEST_ASAR_FALLBACK=1` (and needs `xvfb` + the sandbox
 * disabled on Linux CI). `OBSIDIAN_METADATA` is provided by
 * `scripts/vitest-metadata-setup.ts` (already in the `integration-tests` project).
 */

import process from 'node:process';
import {
  describe,
  expect,
  it
} from 'vitest';

import { connectToCdp } from './connect-to-cdp.ts';
import { SilentAsarFallbackError } from './silent-asar-fallback-error.ts';

// Downloading + extracting the old installer shell, then launching Electron and
// Waiting for CDP plus the vault to open. Give it a wide margin like the other
// Installer boot tests.
const FALLBACK_BOOT_TIMEOUT_IN_MILLISECONDS = 1_800_000;

// App pinned above the below-floor shell's bundled version: on the `1.1.9` shell,
// `1.13.0` silently reverts to the shell's own `1.1.9` asar (its run floor is
// `1.6.5`, above `1.1.9`).
const FALLBACK_APP_VERSION = '1.13.0';
const SHELL_BUNDLED_APP_VERSION = '1.1.9';
const OLD_INSTALLER_VERSION = '1.1.9';

// App whose run floor IS `1.1.9`, so it genuinely runs on that shell (no fallback).
const RUNNABLE_APP_VERSION = '1.13.1';

const SHOULD_RUN = process.env['OBSIDIAN_TEST_ASAR_FALLBACK'] === '1';

describe.runIf(SHOULD_RUN)('post-boot silent-asar-fallback verify', () => {
  it(
    'surfaces a `fallback` verdict when a below-floor shell runs its own bundled asar (throw disabled)',
    { timeout: FALLBACK_BOOT_TIMEOUT_IN_MILLISECONDS },
    async () => {
      const connection = await connectToCdp({
        isObsidianAppVisible: false,
        obsidianInstallerVersion: OLD_INSTALLER_VERSION,
        obsidianVersion: FALLBACK_APP_VERSION,
        shouldDisableSandbox: true,
        // Below the run floor, so bypass the proactive throw to reach the boot.
        shouldThrowOnIncompatibleInstaller: false,
        // Surface the fallback as data instead of throwing, so it can be asserted.
        shouldThrowOnSilentAsarFallback: false
      });
      try {
        const { asarFallback } = connection;
        expect(asarFallback).toBeDefined();
        expect(asarFallback?.tier).toBe('fallback');
        expect(asarFallback?.requestedVersion).toBe(FALLBACK_APP_VERSION);
        expect(asarFallback?.runningApiVersion).toBe(SHELL_BUNDLED_APP_VERSION);
        expect(asarFallback?.message).toContain(FALLBACK_APP_VERSION);
        expect(asarFallback?.message).toContain(SHELL_BUNDLED_APP_VERSION);
      } finally {
        await connection.dispose();
      }
    }
  );

  it(
    'throws SilentAsarFallbackError by default on a silent fallback',
    { timeout: FALLBACK_BOOT_TIMEOUT_IN_MILLISECONDS },
    async () => {
      // Default `shouldThrowOnSilentAsarFallback` (true); still bypass the proactive
      // Installer throw so the boot proceeds far enough to hit the reactive check.
      await expect(connectToCdp({
        isObsidianAppVisible: false,
        obsidianInstallerVersion: OLD_INSTALLER_VERSION,
        obsidianVersion: FALLBACK_APP_VERSION,
        shouldDisableSandbox: true,
        shouldThrowOnIncompatibleInstaller: false
      })).rejects.toThrow(SilentAsarFallbackError);
    }
  );

  it(
    'reports `match` when the pinned app genuinely runs on the shell (no false positive)',
    { timeout: FALLBACK_BOOT_TIMEOUT_IN_MILLISECONDS },
    async () => {
      const connection = await connectToCdp({
        isObsidianAppVisible: false,
        obsidianInstallerVersion: OLD_INSTALLER_VERSION,
        obsidianVersion: RUNNABLE_APP_VERSION,
        shouldDisableSandbox: true
      });
      try {
        const { asarFallback } = connection;
        expect(asarFallback).toBeDefined();
        expect(asarFallback?.tier).toBe('match');
        expect(asarFallback?.requestedVersion).toBe(RUNNABLE_APP_VERSION);
        expect(asarFallback?.runningApiVersion).toBe(RUNNABLE_APP_VERSION);
      } finally {
        await connection.dispose();
      }
    }
  );
});
