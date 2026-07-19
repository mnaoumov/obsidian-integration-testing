/**
 * @file
 *
 * Integration test for making a **very old** owned Obsidian instance fully usable
 * end-to-end: the vault auto-opens (not the first-run selector), the owned
 * instance reaches readiness, and an `evalInObsidian` closure runs in it.
 *
 * It pins **0.6.4** — the oldest installer the harness supports — because that one
 * version exercises the entire old-version compatibility stack at once (all
 * empirically established via real boots, 2026-07-18):
 *
 * 1. **Auto-open** — 0.6.4 ignores the modern per-entry `open: true` and auto-opens
 *    from the top-level `last_open` id (see `owned-vault-seed.ts` / L26).
 * 2. **Bootstrap syntax** — 0.6.4 runs Chromium 80, which cannot parse the ES2021
 *    `??=` the serialized namespace bootstrap used to contain.
 * 3. **Readiness** — 0.6.4 predates `Workspace.onLayoutReady` (the `layoutReady`
 *    flag guard) and the `FileSystemAdapter.getBasePath()` method (the `.basePath`
 *    property fallback).
 * 4. **Closure path** — 0.6.4 predates the community-plugin API (`plugins.isEnabled`
 *    / the `manifests` registry), so `evalWrapper` must skip plugin-enable and
 *    resolve `obsidianModule` to `undefined` while still running app-only closures.
 * 5. **Off-screen hiding** — 0.6.4 (Electron 8) has no `window.electron`, but the
 *    built-in `require('electron').remote` still moves the window off-screen, which
 *    is also what stops the boot-time CDP hammering that would otherwise wedge
 *    Electron-10-era boots.
 *
 * `obsidianModule` is `undefined` on 0.6.4 (a genuine platform limit — no plugin
 * API, and `require('obsidian')` fails there), so the closure uses only `app`.
 *
 * Pinning `obsidianInstallerVersion` downloads/extracts a multi-hundred-MB shell
 * and launches Electron, so — like the other download-and-boot suites — it is
 * opt-in via `OBSIDIAN_TEST_OLD_VAULT_OPEN=1` (and needs `xvfb` + the sandbox
 * disabled on Linux CI). `OBSIDIAN_METADATA` is provided by
 * `scripts/vitest-metadata-setup.ts` (already in the `integration-tests` project).
 */

import { basename } from 'node:path';
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
const OLD_VAULT_OPEN_BOOT_TIMEOUT_IN_MILLISECONDS = 1_800_000;

// The oldest supported installer — exercises the whole old-version stack (see the
// File overview).
const OLD_VERSION = '0.6.4';

const SHOULD_RUN = process.env['OBSIDIAN_TEST_OLD_VAULT_OPEN'] === '1';

describe.runIf(SHOULD_RUN)('force auto-open + full usability of the owned vault on the oldest supported version', () => {
  it(
    'auto-opens the seeded vault, reaches readiness, and runs an app-only closure on 0.6.4',
    { timeout: OLD_VAULT_OPEN_BOOT_TIMEOUT_IN_MILLISECONDS },
    async () => {
      const connection = await connectToCdp({
        isObsidianAppVisible: false,
        obsidianInstallerVersion: OLD_VERSION,
        obsidianVersion: OLD_VERSION,
        shouldDisableSandbox: true
      });
      try {
        // Reaching here already proves readiness — the owned instance opened the
        // Seeded vault rather than sticking on the selector (which would time out).
        // Run an app-only closure end-to-end (evalWrapper must tolerate the missing
        // Community-plugin API) and confirm it sees the seeded vault.
        const vaultName = await connection.evalInObsidian({ fn: ({ app }) => app.vault.getName() });
        expect(vaultName).toBe(basename(connection.vault.path));
      } finally {
        await connection.dispose();
      }
    }
  );
});
