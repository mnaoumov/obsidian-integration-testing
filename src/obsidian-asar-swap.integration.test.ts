/**
 * @file
 *
 * Linux-specific integration test for the owned-instance asar-swap version-pin
 * bug. On Linux `detectInstalledShellVersion` is a best-effort path parse that
 * returns `undefined` for a typical PATH install, so `resolveOwnedInstanceConfig`
 * takes the *upgrade-only* asar-swap branch even when the pinned `obsidianVersion`
 * is OLDER than the installed shell's bundled version — the swap is silently
 * ignored and the newer shell version runs instead, so the pin has no effect.
 *
 * The `.github/workflows/validate-installer-boot.yml` Linux step reproduces the
 * triggering condition around this test: it symlinks a newer, already-cached
 * shell under a *versionless* directory and puts it on `PATH`, so
 * `resolveObsidianExecutable` finds it but `detectInstalledShellVersion` returns
 * `undefined`. That PATH must be set before this process starts — `exec.ts`
 * snapshots `process.env` at import — which is why the workflow, not the test,
 * arranges it. The test then pins an OLDER `obsidianVersion` and asserts the
 * running app is actually that version.
 *
 * Windows/macOS detect the shell version reliably, so the bug cannot occur there
 * — the test is Linux-only and opt-in via OBSIDIAN_TEST_ASAR_SWAP=1. It launches
 * Electron, so it needs xvfb + the sandbox disabled.
 */

import process from 'node:process';
import {
  describe,
  expect,
  it
} from 'vitest';

import { connectToCdp } from './connect-to-cdp.ts';

// Downloads the older version's asar (bug path) or installer (fixed path), then
// Boots. Give it a wide margin like the other installer tests.
const ASAR_SWAP_TIMEOUT_IN_MILLISECONDS = 1_800_000;

// An app version comfortably OLDER than any current public-latest shell, so the
// Upgrade-only asar-swap cannot apply it: honoring the pin requires resolving
// This version's own installer shell instead.
const OLDER_APP_VERSION = '1.8.10';

const SHOULD_RUN = process.env['OBSIDIAN_TEST_ASAR_SWAP'] === '1' && process.platform === 'linux';

describe.runIf(SHOULD_RUN)('Linux asar-swap version-pin regression', () => {
  it(
    'runs the pinned obsidianVersion even when older than the (undetectable) shell',
    { timeout: ASAR_SWAP_TIMEOUT_IN_MILLISECONDS },
    async () => {
      const connection = await connectToCdp({
        isObsidianAppVisible: false,
        obsidianVersion: OLDER_APP_VERSION,
        shouldDisableSandbox: true
      });
      try {
        const runningVersion = await connection.evalInObsidian({
          fn({ obsidianModule }): string {
            return obsidianModule.apiVersion;
          }
        });
        // The pinned older version must actually run. With the bug, the
        // Upgrade-only asar-swap is silently ignored and the newer shell version
        // Runs instead, so this reads the shell version rather than the pin.
        expect(runningVersion).toBe(OLDER_APP_VERSION);
      } finally {
        await connection.dispose();
      }
    }
  );
});
