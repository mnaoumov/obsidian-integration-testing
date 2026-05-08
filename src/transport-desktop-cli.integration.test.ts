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
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  homedir,
  tmpdir
} from 'node:os';
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
  getAnyRegisteredVaultPath,
  isVaultOpen,
  isVaultRegistered,
  registerVaultInConfig,
  removeVaultFromConfig
} from './obsidian-config.ts';
import { TempVault } from './temp-vault.ts';
import { DesktopCliTransport } from './transport-desktop-cli.ts';

interface ObsidianJsonConfig {
  vaults: Record<string, ObsidianVaultEntry>;
}

interface ObsidianVaultEntry {
  open?: boolean;
  path: string;
}

const LONG_TIMEOUT_IN_MILLISECONDS = 120000;
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 2000;
const OBSIDIAN_POLL_INTERVAL_IN_MILLISECONDS = 2000;

const transport = new DesktopCliTransport();
const dialogMonitor = new NativeDialogMonitor();

/**
 * Backs up obsidian.json and returns the backup content.
 *
 * @returns The raw JSON string of obsidian.json.
 */
function backupObsidianJson(): string {
  return readFileSync(getObsidianJsonPath(), 'utf-8');
}

/**
 * Checks if Obsidian is currently running.
 *
 * @returns `true` if Obsidian is running, `false` otherwise.
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
 * Removes stale temp vault entries from obsidian.json.
 */
function cleanStaleTempVaults(): void {
  const configPath = getObsidianJsonPath();
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as ObsidianJsonConfig;
  for (const [id, entry] of Object.entries(config.vaults)) {
    if (entry.path.includes('temp-vault-') || entry.path.includes('cli-test-')) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Cleaning up stale entries by dynamic key.
      delete config.vaults[id];
    }
  }
  writeFileSync(configPath, JSON.stringify(config));
}

/**
 * Closes a vault window and waits for Obsidian to update its open flag.
 *
 * @param vaultPath - The vault path whose window to close.
 */
async function closeVaultAndWaitForFlag(vaultPath: string): Promise<void> {
  await closeVaultWindow(vaultPath);
  const deadline = Date.now() + LONG_TIMEOUT_IN_MILLISECONDS;
  while (isVaultOpen(vaultPath) && Date.now() < deadline) {
    await delay(OBSIDIAN_POLL_INTERVAL_IN_MILLISECONDS);
  }
}

/**
 * Closes a vault window by destroying it via eval.
 *
 * @param vaultPath - The vault path whose window to close.
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
 * Creates a fresh temp directory with .obsidian folder.
 *
 * @returns The absolute path to the new temp directory.
 */
function createTempVaultDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
  mkdirSync(join(dir, '.obsidian'), { recursive: true });
  return dir;
}

/**
 * Waits for a given number of milliseconds.
 *
 * @param ms - The delay in milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Returns the platform-specific path to obsidian.json.
 *
 * @returns The absolute path to obsidian.json.
 */
function getObsidianJsonPath(): string {
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? '', 'obsidian', 'obsidian.json');
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }

  return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'obsidian', 'obsidian.json');
}

/**
 * Kills the Obsidian process and waits for it to stop.
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

  while (await checkObsidianRunning()) {
    await delay(OBSIDIAN_POLL_INTERVAL_IN_MILLISECONDS);
  }
}

/**
 * Removes temp directory.
 *
 * @param dirPath - The directory to remove.
 */
async function removeTempDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { force: true, recursive: true });
  } catch {
    // May fail on Windows due to file locks.
  }
}

/**
 * Restores obsidian.json from a backup string.
 *
 * @param backup - The raw JSON string to restore.
 */
function restoreObsidianJson(backup: string): void {
  writeFileSync(getObsidianJsonPath(), backup);
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

  const deadline = Date.now() + LONG_TIMEOUT_IN_MILLISECONDS;
  while (Date.now() < deadline) {
    if (await checkObsidianRunning()) {
      await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);
      return;
    }
    await delay(OBSIDIAN_POLL_INTERVAL_IN_MILLISECONDS);
  }
  throw new Error('Obsidian did not start within timeout');
}

// ─── Global setup ───────────────────────────────────────────────

beforeAll(() => {
  cleanStaleTempVaults();
  dialogMonitor.start();
});

afterAll(() => {
  dialogMonitor.stop();
  cleanStaleTempVaults();
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
  }, LONG_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await tempVault.dispose();
  }, LONG_TIMEOUT_IN_MILLISECONDS);

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
    const configBackup = backupObsidianJson();
    removeVaultFromConfig(tempVault.path);

    try {
      await expect(transport.preflightCheck(tempVault.path))
        .rejects.toThrow(/not registered/i);
    } finally {
      restoreObsidianJson(configBackup);
    }
  });

  it('B3: no vaults registered (inconsistent) — preflightCheck should fail', async () => {
    const configBackup = backupObsidianJson();
    writeFileSync(getObsidianJsonPath(), JSON.stringify({ cli: true, vaults: {} }));

    try {
      expect(isVaultRegistered(tempVault.path)).toBe(false);
      await expect(transport.preflightCheck(tempVault.path))
        .rejects.toThrow(/not registered/i);
    } finally {
      restoreObsidianJson(configBackup);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// C. Obsidian running with other vault (not target)
// ─────────────────────────────────────────────────────────────────
describe('C: Obsidian running + other vault open', () => {
  let targetDir: string;

  beforeAll(() => {
    targetDir = createTempVaultDir();
  });

  afterAll(async () => {
    removeVaultFromConfig(targetDir);
    await removeTempDir(targetDir);
  });

  it('C1: target registered — preflightCheck should auto-open vault', async () => {
    // Use the user's already-open vault to register target via IPC
    const existingVaultPath = getAnyRegisteredVaultPath();
    expect(existingVaultPath).toBeDefined();

    // Register via IPC so Obsidian's in-memory registry has the vault
    await transport.registerVault(targetDir);
    // Close the window and wait for Obsidian to mark it as not open
    await closeVaultAndWaitForFlag(targetDir);

    // Now preflightCheck should auto-open it via URI (using known vault ID)
    await transport.preflightCheck(targetDir);
    expect(isVaultOpen(targetDir)).toBe(true);

    // Clean up: close the vault window
    await closeVaultAndWaitForFlag(targetDir);
  }, LONG_TIMEOUT_IN_MILLISECONDS);

  it('C2: target not registered — preflightCheck should fail', async () => {
    removeVaultFromConfig(targetDir);
    expect(isVaultRegistered(targetDir)).toBe(false);

    await expect(transport.preflightCheck(targetDir))
      .rejects.toThrow(/not registered/i);
  });

  it('C3: no vaults registered (inconsistent) — preflightCheck should fail', async () => {
    const configBackup = backupObsidianJson();
    writeFileSync(getObsidianJsonPath(), JSON.stringify({ cli: true, vaults: {} }));

    try {
      expect(isVaultRegistered(targetDir)).toBe(false);
      await expect(transport.preflightCheck(targetDir))
        .rejects.toThrow(/not registered/i);
    } finally {
      restoreObsidianJson(configBackup);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// D. Obsidian with vault chooser (no vaults open)
//
// To get the vault chooser, we must close ALL vault windows.
// We register the target via IPC first, then close everything.
// ─────────────────────────────────────────────────────────────────
describe('D: Obsidian with vault chooser UI', () => {
  let targetDir: string;
  let configBackupBeforeD: string;

  beforeAll(async () => {
    targetDir = createTempVaultDir();
    configBackupBeforeD = backupObsidianJson();

    // Register target vault via IPC while user's vault is still open
    await transport.registerVault(targetDir);
    await closeVaultAndWaitForFlag(targetDir);

    // Save config again (now includes target vault with its IPC-assigned ID)
    configBackupBeforeD = backupObsidianJson();

    // Close ALL vault windows to trigger vault chooser
    const config = JSON.parse(readFileSync(getObsidianJsonPath(), 'utf-8')) as ObsidianJsonConfig;
    for (const entry of Object.values(config.vaults)) {
      if (entry.open) {
        await closeVaultAndWaitForFlag(entry.path);
      }
    }
  }, LONG_TIMEOUT_IN_MILLISECONDS * 2);

  afterAll(async () => {
    // Restore original config (preserves original vault IDs)
    restoreObsidianJson(configBackupBeforeD);

    // Kill and restart Obsidian so it re-reads the restored config
    await killObsidian();
    await startObsidian();

    // Clean up test vault
    removeVaultFromConfig(targetDir);
    await removeTempDir(targetDir);
  }, LONG_TIMEOUT_IN_MILLISECONDS * 2);

  it('D1: target registered — preflightCheck should open vault', async () => {
    expect(isVaultRegistered(targetDir)).toBe(true);
    expect(isVaultOpen(targetDir)).toBe(false);

    await transport.preflightCheck(targetDir);
    expect(isVaultOpen(targetDir)).toBe(true);

    await closeVaultAndWaitForFlag(targetDir);
  }, LONG_TIMEOUT_IN_MILLISECONDS);

  it('D2: target not registered — preflightCheck should fail', async () => {
    const configBackup = backupObsidianJson();
    removeVaultFromConfig(targetDir);

    try {
      expect(isVaultRegistered(targetDir)).toBe(false);
      await expect(transport.preflightCheck(targetDir))
        .rejects.toThrow(/not registered/i);
    } finally {
      restoreObsidianJson(configBackup);
    }
  });

  it('D3: no vaults registered — preflightCheck should fail', async () => {
    const configBackup = backupObsidianJson();
    writeFileSync(getObsidianJsonPath(), JSON.stringify({ cli: true, vaults: {} }));

    try {
      expect(isVaultRegistered(targetDir)).toBe(false);
      await expect(transport.preflightCheck(targetDir))
        .rejects.toThrow(/not registered/i);
    } finally {
      restoreObsidianJson(configBackup);
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
    wasObsidianRunning = await checkObsidianRunning();
    await killObsidian();
  }, LONG_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    removeVaultFromConfig(targetDir);
    await removeTempDir(targetDir);

    if (wasObsidianRunning) {
      await startObsidian();
    }
  }, LONG_TIMEOUT_IN_MILLISECONDS);

  it('A1: target registered — should auto-start Obsidian', async () => {
    registerVaultInConfig(targetDir);
    expect(await checkObsidianRunning()).toBe(false);

    await transport.preflightCheck(targetDir);
    expect(await checkObsidianRunning()).toBe(true);
  }, LONG_TIMEOUT_IN_MILLISECONDS);

  it('A2: target not registered — preflightCheck should fail', async () => {
    removeVaultFromConfig(targetDir);
    expect(isVaultRegistered(targetDir)).toBe(false);

    await expect(transport.preflightCheck(targetDir))
      .rejects.toThrow(/not registered/i);
  });

  it('A3: no vaults registered — preflightCheck should fail', async () => {
    const configBackup = backupObsidianJson();
    writeFileSync(getObsidianJsonPath(), JSON.stringify({ cli: true, vaults: {} }));

    try {
      expect(isVaultRegistered(targetDir)).toBe(false);
      await expect(transport.preflightCheck(targetDir))
        .rejects.toThrow(/not registered/i);
    } finally {
      restoreObsidianJson(configBackup);
    }
  });
});
