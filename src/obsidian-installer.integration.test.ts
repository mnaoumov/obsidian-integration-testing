/**
 * @file
 *
 * Integration test for the desktop **installer/shell** provisioning path:
 * downloading a public version's GitHub release installer and extracting a
 * portable Obsidian shell from it (`obsidian-installer.ts`) — the mechanism
 * behind pinning `obsidianInstallerVersion` to run a version older than the
 * installed shell.
 *
 * This is expensive (the Windows installer is ~300 MB, plus a two-stage 7-Zip
 * extraction) and platform-specific, so it is **opt-in**: it runs only on
 * Windows and only when `OBSIDIAN_TEST_INSTALLER_DOWNLOAD=1` is set. The macOS
 * `.dmg` (`hdiutil`) and Linux `.tar.gz` extraction branches are gated behind
 * `process.platform` and need their own platform runners to exercise.
 */

import {
  existsSync,
  rmSync
} from 'node:fs';
import process from 'node:process';
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  detectInstalledShellVersion,
  ensureShellCached,
  getCachedShellDir
} from './obsidian-installer.ts';
import { resolveConcreteVersion } from './obsidian-version-switch.ts';

// A ~300 MB download plus a two-stage NSIS/7-Zip extraction. GitHub's release-
// Asset CDN can be very slow (observed ~0.3 MB/s), so the download alone can
// Take ~18 min; give it a wide margin. No retry: re-pulling a multi-minute
// Download to absorb a transient blip costs far more than it saves — re-run the
// Opt-in test manually if it fails.
const INSTALLER_TIMEOUT_IN_MILLISECONDS = 1_800_000;

const SHOULD_RUN_INSTALLER_TEST = process.platform === 'win32'
  && process.env['OBSIDIAN_TEST_INSTALLER_DOWNLOAD'] === '1';

describe.runIf(SHOULD_RUN_INSTALLER_TEST)('installer shell download and extract (Windows)', () => {
  it(
    'should download the installer, 7-Zip-extract a runnable Obsidian.exe, and reuse the cache',
    { timeout: INSTALLER_TIMEOUT_IN_MILLISECONDS },
    async () => {
      // Installer assets exist for public releases only (catalyst ships no exe).
      const version = await resolveConcreteVersion('public-latest');
      // Evict any cached shell so the download + extraction path actually runs.
      rmSync(getCachedShellDir(version), { force: true, recursive: true });

      const exePath = await ensureShellCached(version);
      expect(existsSync(exePath)).toBe(true);
      expect(exePath.endsWith('Obsidian.exe')).toBe(true);

      // The extracted exe must be the pinned build: its PE FileVersion matches.
      const detectedVersion = detectInstalledShellVersion(exePath);
      expect(detectedVersion).toBeDefined();
      expect(detectedVersion?.startsWith(version)).toBe(true);

      // A second call is a cache hit — same executable path, no re-extraction.
      const cachedExePath = await ensureShellCached(version);
      expect(cachedExePath).toBe(exePath);
    }
  );
});
