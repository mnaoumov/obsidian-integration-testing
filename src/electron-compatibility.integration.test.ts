/**
 * @file
 *
 * Integration test for the tier-2 **runtime** Electron nag: after an owned
 * instance boots, the transport reads the live `process.versions.electron` and the
 * running app version over CDP and, when the running Electron is older than the
 * app's recommended minimum (`minRecommendedElectronVersion` in `metadata.json`),
 * warns and surfaces a `'nagged'` verdict on `CdpConnection.electronCompatibility`.
 *
 * It pins a deliberately old pair that genuinely boots but is below the Electron
 * recommendation: app `1.13.1` (recommends Electron `28.2.3`) on the `1.1.9`
 * installer shell (Electron 18) — `1.13.1` is CDP-verified to actually run on the
 * `1.1.9` shell, so the live read yields a real sub-recommendation Electron. Unlike
 * the offline tier-1 check (asserted without a boot in
 * `installer-compatibility.integration.test.ts`), tier 2 can only be observed from
 * a real boot, so this must launch the instance.
 *
 * Pinning `obsidianInstallerVersion` downloads/extracts a multi-hundred-MB shell
 * and launches Electron, so — like the other download-and-boot suites — it is
 * opt-in via `OBSIDIAN_TEST_ELECTRON_NAG=1` (and needs `xvfb` + the sandbox
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

// Downloading + extracting the old installer shell, then launching Electron and
// Waiting for CDP plus the vault to open. Give it a wide margin like the other
// Installer boot tests.
const NAG_BOOT_TIMEOUT_IN_MILLISECONDS = 1_800_000;

// A modern app that recommends a recent Electron, pinned onto an old installer
// Shell whose bundled Electron is below that recommendation — but new enough that
// The app still boots (verified: 1.13.1 runs on the 1.1.9 shell).
const APP_VERSION = '1.13.1';
const OLD_INSTALLER_VERSION = '1.1.9';
const RECOMMENDED_ELECTRON_VERSION = '28.2.3';

const SHOULD_RUN = process.env['OBSIDIAN_TEST_ELECTRON_NAG'] === '1';

describe.runIf(SHOULD_RUN)('tier-2 runtime Electron nag', () => {
  it(
    'nags when the booted instance runs an Electron older than the app recommends',
    { timeout: NAG_BOOT_TIMEOUT_IN_MILLISECONDS },
    async () => {
      const connection = await connectToCdp({
        isObsidianAppVisible: false,
        obsidianInstallerVersion: OLD_INSTALLER_VERSION,
        obsidianVersion: APP_VERSION,
        shouldDisableSandbox: true
      });
      try {
        const { electronCompatibility } = connection;
        expect(electronCompatibility).toBeDefined();
        expect(electronCompatibility?.tier).toBe('nagged');
        expect(electronCompatibility?.appVersion).toBe(APP_VERSION);
        expect(electronCompatibility?.minRecommendedElectronVersion).toBe(RECOMMENDED_ELECTRON_VERSION);
        // The live Electron read is a real version string below the recommendation.
        expect(electronCompatibility?.actualElectronVersion).toMatch(/^\d+\.\d+\.\d+/);
        expect(electronCompatibility?.message).toContain(RECOMMENDED_ELECTRON_VERSION);
      } finally {
        await connection.dispose();
      }
    }
  );
});
