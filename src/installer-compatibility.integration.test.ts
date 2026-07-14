import {
  describe,
  expect,
  it
} from 'vitest';

import { IncompatibleInstallerVersionError } from './incompatible-installer-version-error.ts';
import { createTransportFromOptions } from './transport-factory.ts';

// A pinned installer below the app's run floor: Obsidian 1.12.7's run floor is
// Installer 1.1.9 (metadata.json), so the 0.14.5 installer (Electron 18.0.3)
// Cannot boot it. The proactive compatibility check catches this from the table
// At version-resolution time and throws before any shell/asar download or launch,
// So this suite is fast and needs no real Obsidian — unlike the reactive
// Dead-boot fast-fail it supersedes (which had to launch and wait out a grace).
const UNRUNNABLE_ASAR_VERSION = '1.12.7';
const UNRUNNABLE_INSTALLER_VERSION = '0.14.5';

describe('proactive installer compatibility', () => {
  it('throws IncompatibleInstallerVersionError before launch when the installer is below the run floor', async () => {
    await expect(createTransportFromOptions({
      obsidianInstallerVersion: UNRUNNABLE_INSTALLER_VERSION,
      obsidianVersion: UNRUNNABLE_ASAR_VERSION,
      type: 'obsidian-cdp'
    })).rejects.toBeInstanceOf(IncompatibleInstallerVersionError);
  });

  it('names the run floor in the error so the caller knows which installer would work', async () => {
    const error = await createTransportFromOptions({
      obsidianInstallerVersion: UNRUNNABLE_INSTALLER_VERSION,
      obsidianVersion: UNRUNNABLE_ASAR_VERSION,
      type: 'obsidian-cdp'
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IncompatibleInstallerVersionError);
    if (!(error instanceof IncompatibleInstallerVersionError)) {
      throw new Error('expected IncompatibleInstallerVersionError');
    }
    expect(error.appVersion).toBe(UNRUNNABLE_ASAR_VERSION);
    expect(error.installerVersion).toBe(UNRUNNABLE_INSTALLER_VERSION);
    expect(error.minRunnableInstallerVersion).toBe('1.1.9');
  });
});
