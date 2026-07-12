import {
  describe,
  expect,
  it
} from 'vitest';

import { RendererFailedToInitializeError } from './renderer-failed-to-initialize-error.ts';
import { TempVault } from './temp-vault.ts';
import { createTransportFromOptions } from './transport-factory.ts';

// Pinning an old installer means downloading + extracting it on a cold cache, so
// This suite is generous. The healthy-boot path (no false-positive dead-boot
// Detection) is already covered by the connect-to-cdp integration suite, which
// Launches the installed version through the same owned-vault readiness wait.
const COLD_LAUNCH_TIMEOUT_IN_MILLISECONDS = 240_000;

// An asar too new for the shell it is launched on: Obsidian 1.12.7 does not boot
// On the Electron 18.0.3 shell that installer 0.14.5 bundles — the renderer
// Loads index.html but the app never bootstraps (empty <body>, no window.app).
const INCOMPATIBLE_ASAR_VERSION = '1.12.7';
const INCOMPATIBLE_INSTALLER_VERSION = '0.14.5';

// A short grace keeps the test quick; getting the RendererFailedToInitializeError
// At all proves the fast-fail fired well before the full readiness timeout (only
// The grace-elapsed dead-boot branch throws that error — timing out throws a
// Generic Error instead).
const SHORT_DEAD_BOOT_GRACE_IN_MILLISECONDS = 2000;

describe('renderer dead-boot fast-fail', () => {
  it('fails fast with RendererFailedToInitializeError when the asar cannot run on the shell', async () => {
    const transport = await createTransportFromOptions({
      deadBootGraceInMilliseconds: SHORT_DEAD_BOOT_GRACE_IN_MILLISECONDS,
      obsidianInstallerVersion: INCOMPATIBLE_INSTALLER_VERSION,
      obsidianVersion: INCOMPATIBLE_ASAR_VERSION,
      type: 'obsidian-cdp'
    });

    try {
      const vault = new TempVault();
      try {
        await expect(vault.register(transport)).rejects.toBeInstanceOf(RendererFailedToInitializeError);
      } finally {
        await vault.dispose(transport);
      }
    } finally {
      await transport.dispose?.();
    }
  }, COLD_LAUNCH_TIMEOUT_IN_MILLISECONDS);
});
