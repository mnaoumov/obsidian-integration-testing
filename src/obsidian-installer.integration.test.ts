/**
 * @file
 *
 * Integration test for the desktop **installer/shell** provisioning path:
 * downloading a public version's GitHub release installer and extracting a
 * portable Obsidian shell from it (`obsidian-installer.ts`) — the mechanism
 * behind pinning `obsidianInstallerVersion` to run a version older than the
 * installed shell.
 *
 * The download + extraction is expensive (a multi-hundred-MB asset plus a
 * platform-specific unpack) and platform-specific, so it is **opt-in**: it runs
 * only when `OBSIDIAN_TEST_INSTALLER_DOWNLOAD=1` is set, and exercises the
 * `process.platform` branch of the host it runs on — the Windows NSIS/7-Zip
 * `.exe`, the macOS `.dmg`/`hdiutil`, or the Linux `.tar.gz`/`tar` path. The
 * local dev box is Windows-only, so the macOS and Linux branches are covered by
 * running this file on `macos-latest` / `ubuntu-latest` GitHub runners (see
 * `.github/workflows/validate-installer-path.yml`).
 *
 * It downloads and extracts only — it never launches Obsidian — so it needs
 * network access but no display, `xvfb`, or sandbox flags.
 */

import {
  existsSync,
  rmSync
} from 'node:fs';
import { join } from 'node:path';
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

// A multi-hundred-MB download plus a platform-specific extraction. GitHub's
// Release-asset CDN can be very slow (observed ~0.3 MB/s), so the download alone
// Can take ~18 min; give it a wide margin. No retry: re-pulling a multi-minute
// Download to absorb a transient blip costs far more than it saves — re-run the
// Opt-in test manually if it fails.
const INSTALLER_TIMEOUT_IN_MILLISECONDS = 1_800_000;

const SHOULD_RUN_INSTALLER_TEST = process.env['OBSIDIAN_TEST_INSTALLER_DOWNLOAD'] === '1';

describe.runIf(SHOULD_RUN_INSTALLER_TEST)('installer shell download and extract', () => {
  it(
    'should download the installer, extract a runnable Obsidian shell, and reuse the cache',
    { timeout: INSTALLER_TIMEOUT_IN_MILLISECONDS },
    async () => {
      // Installer assets exist for public releases only (catalyst ships no exe).
      const version = await resolveConcreteVersion('public-latest');
      // Evict any cached shell so the download + extraction path actually runs.
      rmSync(getCachedShellDir(version), { force: true, recursive: true });

      const exePath = await ensureShellCached(version);
      expect(existsSync(exePath)).toBe(true);
      // The extracted executable lands at the platform-correct path/name.
      expect(exePath.endsWith(getExpectedExeSuffix())).toBe(true);

      // Windows (PE FileVersion) and macOS (Info.plist) reliably report the
      // Shell's version, so it must match the pinned build. Linux detection is a
      // Best-effort path parse that is usually `undefined`, so it is not asserted
      // There — the exe-path and cache-hit checks validate that branch instead.
      if (process.platform !== 'linux') {
        const detectedVersion = detectInstalledShellVersion(exePath);
        expect(detectedVersion).toBeDefined();
        expect(detectedVersion?.startsWith(version)).toBe(true);
      }

      // A second call is a cache hit — same executable path, no re-extraction.
      const cachedExePath = await ensureShellCached(version);
      expect(cachedExePath).toBe(exePath);
    }
  );
});

/**
 * Returns the trailing path segment the extracted shell executable is expected
 * to end with on the current platform.
 *
 * @returns The platform-correct executable path suffix.
 */
function getExpectedExeSuffix(): string {
  if (process.platform === 'win32') {
    return 'Obsidian.exe';
  }

  if (process.platform === 'darwin') {
    return join('Obsidian.app', 'Contents', 'MacOS', 'Obsidian');
  }

  return 'obsidian';
}
