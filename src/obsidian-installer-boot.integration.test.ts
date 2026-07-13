/**
 * @file
 *
 * Integration test for the desktop owned-instance **boot** path via a pinned
 * installer version: it downloads/extracts a public release's portable shell
 * (`obsidian-installer.ts`) and then actually **launches** it through
 * `connectToCdp`, confirming the app bootstraps (a real vault + a real eval both
 * work) — the "Tier 2" validation on top of the download-only installer test.
 *
 * Pinning `obsidianInstallerVersion` forces the installer path, so no
 * locally-installed Obsidian is required (a CI runner has none). Because it
 * launches Electron it needs a display (`xvfb` on Linux) and, on Linux CI, the
 * Chromium sandbox disabled (the test passes `shouldDisableSandbox: true`). It is
 * therefore opt-in via `OBSIDIAN_TEST_INSTALLER_BOOT=1` and run on GitHub runners
 * (see `.github/workflows/validate-installer-boot.yml`).
 */

import process from 'node:process';
import {
  describe,
  expect,
  it
} from 'vitest';

import { connectToCdp } from './connect-to-cdp.ts';
import { resolveConcreteVersion } from './obsidian-version-switch.ts';

// Downloading + extracting a multi-hundred-MB installer, then launching Electron
// And waiting for CDP plus the vault to open. GitHub's release CDN can be slow,
// So give it a wide margin (mirrors the installer download test).
const BOOT_TIMEOUT_IN_MILLISECONDS = 1_800_000;

const SHOULD_RUN_BOOT_TEST = process.env['OBSIDIAN_TEST_INSTALLER_BOOT'] === '1';

describe.runIf(SHOULD_RUN_BOOT_TEST)('owned-instance boot via pinned installer', () => {
  it(
    'downloads the pinned installer shell, boots it, and evaluates inside the real app',
    { timeout: BOOT_TIMEOUT_IN_MILLISECONDS },
    async () => {
      // Installer assets exist for public releases only (catalyst ships no exe).
      const version = await resolveConcreteVersion('public-latest');

      // Pinning the installer forces the download/extract path (no installed
      // Obsidian on CI); `--no-sandbox` lets Electron launch on Linux CI.
      const connection = await connectToCdp({
        isObsidianAppVisible: false,
        obsidianInstallerVersion: version,
        shouldDisableSandbox: true
      });
      try {
        // The app genuinely bootstrapped: a raw eval and a rich app eval both work.
        expect(await connection.invoke('2 + 3')).toBe('5');

        const vaultName = await connection.evalInObsidian({
          fn({ app }): string {
            return app.vault.getName();
          }
        });
        expect(typeof vaultName).toBe('string');
        expect(vaultName.length).toBeGreaterThan(0);
      } finally {
        await connection.dispose();
      }
    }
  );
});
