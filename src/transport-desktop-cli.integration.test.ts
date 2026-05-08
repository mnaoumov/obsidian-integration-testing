/**
 * @file
 *
 * Integration tests for DesktopCliTransport covering 12 scenarios:
 * 4 Obsidian states × 3 vault registration states.
 *
 * Obsidian states:
 *   A. No Obsidian running
 *   B. Running with the target vault open
 *   C. Running with a different vault open (not target)
 *   D. Running with vault chooser UI (no vaults open)
 *
 * Vault registration states:
 *   1. Target vault registered in obsidian.json
 *   2. Target vault NOT registered (other vaults may be)
 *   3. No vaults registered at all
 *
 * Some combinations are inherently inconsistent (e.g., vault open
 * but not registered) — we still test them to verify graceful handling.
 */

import type { FileSystemAdapter } from 'obsidian';

import {
  mkdirSync,
  mkdtempSync
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { exec } from './exec.ts';
import { NativeDialogMonitor } from './native-dialog-monitor.ts';
import {
  getRegisteredVaults,
  isVaultOpen,
  isVaultRegistered,
  registerVaultInConfig,
  removeVaultFromConfig
} from './obsidian-config.ts';
import { TempVault } from './temp-vault.ts';
import { DesktopCliTransport } from './transport-desktop-cli.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60000;
const OBSIDIAN_START_TIMEOUT_IN_MILLISECONDS = 60000;
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 2000;
const OBSIDIAN_POLL_INTERVAL_IN_MILLISECONDS = 2000;

const transport = new DesktopCliTransport();
const dialogMonitor = new NativeDialogMonitor();

/**
 * Checks if Obsidian is currently running.
 */
async function checkObsidianRunning(): Promise<boolean> {
  const command = process.platform === 'win32'
    ? 'tasklist /FI "IMAGENAME eq Obsidian.exe" /NH'
    : 'pgrep -f Obsidian';
  try {
    const output = await exec(command, { isQuiet: true });
    if (process.platform === 'win32') {
      return output.includes('Obsidian.exe');
    }
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Closes all open vault windows.
 */
async function closeAllVaultWindows(): Promise<void> {
  const vaults = getRegisteredVaults();
  for (const vault of vaults) {
    if (vault.open) {
      await closeVaultWindow(vault.path);
    }
  }
}

/**
 * Closes a vault window by destroying it via eval.
 */
async function closeVaultWindow(vaultPath: string): Promise<void> {
  try {
    await evalInObsidian({
      fn(): void {
        window.electronWindow.destroy();
      },
      shouldSkipPreflightChecks: true,
      vaultPath
    });
  } catch {
    // Window may already be closed.
  }
  await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);
}

/**
 * Creates a fresh temp directory to use as a vault path.
 */
function createTempVaultDir(): string {
  return mkdtempSync(join(tmpdir(), 'cli-test-'));
}

/**
 * Waits for a given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Kills the Obsidian process.
 */
async function killObsidian(): Promise<void> {
  const command = process.platform === 'win32'
    ? 'taskkill /IM Obsidian.exe /F'
    : 'pkill -f Obsidian';
  try {
    await exec(command, { isQuiet: true });
  } catch {
    // May not be running.
  }
  await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);
}

/**
 * Opens a vault via URI protocol.
 */
async function openVaultViaUri(vaultPath: string): Promise<void> {
  const vaults = getRegisteredVaults();
  const entry = vaults.find((v) => v.path.toLowerCase() === vaultPath.toLowerCase());
  if (!entry) {
    throw new Error(`Cannot open: vault not registered: ${vaultPath}`);
  }
  const uri = `obsidian://open?vault=${encodeURIComponent(entry.id)}`;
  if (process.platform === 'win32') {
    await exec(`start "" "${uri}"`, { isQuiet: true });
  } else if (process.platform === 'darwin') {
    await exec(`open "${uri}"`, { isQuiet: true });
  } else {
    await exec(`xdg-open "${uri}"`, { isQuiet: true });
  }
}

/**
 * Removes temp directory with retry.
 */
async function removeTempDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { force: true, recursive: true });
  } catch {
    // May fail on Windows due to file locks.
  }
}

/**
 * Launches Obsidian and waits until it's running.
 */
async function startObsidian(): Promise<void> {
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    await exec(`start "" "${localAppData}\\Programs\\Obsidian\\Obsidian.exe"`, { isQuiet: true });
  } else if (process.platform === 'darwin') {
    await exec('/Applications/Obsidian.app/Contents/MacOS/Obsidian &', { isQuiet: true });
  } else {
    await exec('obsidian &', { isQuiet: true });
  }

  const deadline = Date.now() + OBSIDIAN_START_TIMEOUT_IN_MILLISECONDS;
  while (Date.now() < deadline) {
    if (await checkObsidianRunning()) {
      await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);
      return;
    }
    await delay(OBSIDIAN_POLL_INTERVAL_IN_MILLISECONDS);
  }
  throw new Error('Obsidian did not start within timeout');
}

beforeAll(() => {
  dialogMonitor.start();
});

afterAll(() => {
  dialogMonitor.stop();
});

afterEach(() => {
  dialogMonitor.assertNoDialogs();
  dialogMonitor.reset();
});

// ─────────────────────────────────────────────────────────────────
// B. Obsidian running with target vault open
// ─────────────────────────────────────────────────────────────────
describe('B: Obsidian running + target vault open', () => {
  const tempVault = new TempVault();

  beforeAll(async () => {
    await tempVault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await tempVault.dispose();
  });

  it('B1: registered — should evaluate successfully', async () => {
    expect(isVaultRegistered(tempVault.path)).toBe(true);
    expect(isVaultOpen(tempVault.path)).toBe(true);

    const basePath = await evalInObsidian({
      fn({ app }): string {
        return (app.vault.adapter as FileSystemAdapter).getBasePath();
      },
      vaultPath: tempVault.path
    });
    expect(basePath).toBe(tempVault.path);
  });

  it('B2: not registered (inconsistent) — preflightCheck should fail', async () => {
    // Temporarily remove vault from config while it's still open
    const wasRemoved = removeVaultFromConfig(tempVault.path);
    expect(wasRemoved).toBe(true);

    try {
      await expect(transport.preflightCheck(tempVault.path))
        .rejects.toThrow(/not registered/i);
    } finally {
      // Re-register so cleanup works
      registerVaultInConfig(tempVault.path);
    }
  });

  it('B3: no vaults registered (inconsistent) — preflightCheck should fail', async () => {
    // Save and clear all vaults
    const savedVaults = getRegisteredVaults();
    for (const vault of savedVaults) {
      removeVaultFromConfig(vault.path);
    }

    try {
      expect(getRegisteredVaults()).toHaveLength(0);
      await expect(transport.preflightCheck(tempVault.path))
        .rejects.toThrow(/not registered/i);
    } finally {
      // Restore vaults
      for (const vault of savedVaults) {
        registerVaultInConfig(vault.path);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// C. Obsidian running with other vault (not target)
// ─────────────────────────────────────────────────────────────────
describe('C: Obsidian running + other vault open', () => {
  const anchorVault = new TempVault();
  let targetDir: string;

  beforeAll(async () => {
    // Register and open the anchor vault (the "other" vault)
    await anchorVault.register();
    targetDir = createTempVaultDir();
    mkdirSync(join(targetDir, '.obsidian'), { recursive: true });
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    removeVaultFromConfig(targetDir);
    await removeTempDir(targetDir);
    await anchorVault.dispose();
  });

  it('C1: target registered — preflightCheck should auto-open vault', async () => {
    // Register the target vault in config but don't open it
    registerVaultInConfig(targetDir);

    try {
      // PreflightCheck should detect vault is not open and open it
      await transport.preflightCheck(targetDir);
      expect(isVaultOpen(targetDir)).toBe(true);
    } finally {
      await closeVaultWindow(targetDir);
    }
  });

  it('C2: target not registered — preflightCheck should fail', async () => {
    // Ensure target is not registered
    removeVaultFromConfig(targetDir);
    expect(isVaultRegistered(targetDir)).toBe(false);

    await expect(transport.preflightCheck(targetDir))
      .rejects.toThrow(/not registered/i);
  });

  it('C3: no vaults registered (inconsistent) — preflightCheck should fail', async () => {
    const savedVaults = getRegisteredVaults();
    for (const vault of savedVaults) {
      removeVaultFromConfig(vault.path);
    }

    try {
      expect(getRegisteredVaults()).toHaveLength(0);
      await expect(transport.preflightCheck(targetDir))
        .rejects.toThrow(/not registered/i);
    } finally {
      for (const vault of savedVaults) {
        registerVaultInConfig(vault.path);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// D. Obsidian with vault chooser (no vaults open)
// ─────────────────────────────────────────────────────────────────
describe('D: Obsidian with vault chooser UI', () => {
  let targetDir: string;
  let savedOpenVaults: string[];

  beforeAll(async () => {
    targetDir = createTempVaultDir();
    mkdirSync(join(targetDir, '.obsidian'), { recursive: true });

    // Close all vault windows to get the vault chooser
    savedOpenVaults = getRegisteredVaults()
      .filter((v) => v.open)
      .map((v) => v.path);
    await closeAllVaultWindows();
    await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    // Re-open previously open vaults
    for (const vaultPath of savedOpenVaults) {
      if (isVaultRegistered(vaultPath)) {
        await openVaultViaUri(vaultPath);
        await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);
      }
    }
    removeVaultFromConfig(targetDir);
    await removeTempDir(targetDir);
  });

  it('D1: target registered — preflightCheck should open vault', async () => {
    registerVaultInConfig(targetDir);

    try {
      await transport.preflightCheck(targetDir);
      expect(isVaultOpen(targetDir)).toBe(true);
    } finally {
      await closeVaultWindow(targetDir);
      removeVaultFromConfig(targetDir);
    }
  });

  it('D2: target not registered — preflightCheck should fail', async () => {
    removeVaultFromConfig(targetDir);
    expect(isVaultRegistered(targetDir)).toBe(false);

    await expect(transport.preflightCheck(targetDir))
      .rejects.toThrow(/not registered/i);
  });

  it('D3: no vaults registered — preflightCheck should fail', async () => {
    const savedVaults = getRegisteredVaults();
    for (const vault of savedVaults) {
      removeVaultFromConfig(vault.path);
    }

    try {
      expect(getRegisteredVaults()).toHaveLength(0);
      await expect(transport.preflightCheck(targetDir))
        .rejects.toThrow(/not registered/i);
    } finally {
      for (const vault of savedVaults) {
        registerVaultInConfig(vault.path);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// A. No Obsidian running (most destructive — runs last)
// ─────────────────────────────────────────────────────────────────
describe('A: No Obsidian running', () => {
  let targetDir: string;
  let wasObsidianRunning: boolean;

  beforeAll(async () => {
    targetDir = createTempVaultDir();
    mkdirSync(join(targetDir, '.obsidian'), { recursive: true });
    wasObsidianRunning = await checkObsidianRunning();
    await killObsidian();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    removeVaultFromConfig(targetDir);
    await removeTempDir(targetDir);

    // Restore Obsidian if it was running before
    if (wasObsidianRunning) {
      await startObsidian();
    }
  }, OBSIDIAN_START_TIMEOUT_IN_MILLISECONDS);

  it('A1: target registered — should auto-start Obsidian', async () => {
    registerVaultInConfig(targetDir);
    expect(await checkObsidianRunning()).toBe(false);

    try {
      await transport.preflightCheck(targetDir);
      expect(await checkObsidianRunning()).toBe(true);
    } finally {
      await closeVaultWindow(targetDir);
    }
  }, OBSIDIAN_START_TIMEOUT_IN_MILLISECONDS);

  it('A2: target not registered — preflightCheck should fail', async () => {
    removeVaultFromConfig(targetDir);
    expect(isVaultRegistered(targetDir)).toBe(false);

    await expect(transport.preflightCheck(targetDir))
      .rejects.toThrow(/not registered/i);
  });

  it('A3: no vaults registered — preflightCheck should fail', async () => {
    const savedVaults = getRegisteredVaults();
    for (const vault of savedVaults) {
      removeVaultFromConfig(vault.path);
    }

    try {
      expect(getRegisteredVaults()).toHaveLength(0);
      await expect(transport.preflightCheck(targetDir))
        .rejects.toThrow(/not registered/i);
    } finally {
      for (const vault of savedVaults) {
        registerVaultInConfig(vault.path);
      }
    }
  });
});
