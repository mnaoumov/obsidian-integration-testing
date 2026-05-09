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
import { ensureNamespaceBootstrapped } from './namespace-bootstrap.ts';
import { NativeDialogMonitor } from './native-dialog-monitor.ts';
import {
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

const CLI_READINESS_TIMEOUT_IN_MILLISECONDS = 120000;
const OBSIDIAN_POLL_INTERVAL_IN_MILLISECONDS = 2000;
const VAULT_CLOSE_DELAY_IN_MILLISECONDS = 2000;
const VAULT_LIFECYCLE_TIMEOUT_IN_MILLISECONDS = 120000;
const VAULT_CHOOSER_SETUP_TIMEOUT_IN_MILLISECONDS = 240000;

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
 * Closes a vault window and manually clears the open flag.
 *
 * Obsidian may not update `open: false` promptly after a forced
 * `window.electronWindow.destroy()`, so we patch obsidian.json directly.
 *
 * @param vaultPath - The vault path whose window to close.
 */
async function closeVaultAndClearFlag(vaultPath: string): Promise<void> {
  await closeVaultWindow(vaultPath);
  setVaultOpenFlag(vaultPath, false);
}

/**
 * Closes a vault window by destroying it via eval.
 *
 * @param vaultPath - The vault path whose window to close.
 */
async function closeVaultWindow(vaultPath: string): Promise<void> {
  const CLOSE_TIMEOUT_IN_MILLISECONDS = 10000;
  try {
    await ensureNamespaceBootstrapped(transport, vaultPath);
    const destroyExpr = 'window.__obsidianIntegrationTesting.destroyCurrentWindow()';
    await transport.evaluate(destroyExpr, { cwd: vaultPath, timeoutInMilliseconds: CLOSE_TIMEOUT_IN_MILLISECONDS });
  } catch {
    // Window may already be closed or eval timed out (expected when destroying own window).
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
 * Sets the `open` flag for a vault in obsidian.json.
 *
 * @param vaultPath - The vault path to update.
 * @param isOpen - Whether to mark the vault as open.
 */
function setVaultOpenFlag(vaultPath: string, isOpen: boolean): void {
  const configPath = getObsidianJsonPath();
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as ObsidianJsonConfig;
  const normalizedTarget = vaultPath.toLowerCase();
  for (const entry of Object.values(config.vaults)) {
    if (entry.path.toLowerCase() === normalizedTarget) {
      if (isOpen) {
        entry.open = true;
      } else {
        delete entry.open;
      }
      break;
    }
  }
  writeFileSync(configPath, JSON.stringify(config));
}

/**
 * Waits until the Obsidian CLI eval command is responsive.
 * Useful after vault window destruction which can temporarily disable the CLI.
 */
async function waitForCliReady(): Promise<void> {
  const deadline = Date.now() + CLI_READINESS_TIMEOUT_IN_MILLISECONDS;
  while (Date.now() < deadline) {
    try {
      await exec('obsidian eval --allow-focus-steal "code=1"', { isQuiet: true });
      return;
    } catch {
      await delay(OBSIDIAN_POLL_INTERVAL_IN_MILLISECONDS);
    }
  }
  throw new Error('Obsidian CLI did not become responsive');
}

// ─── Global setup ───────────────────────────────────────────────

beforeAll(async () => {
  cleanStaleTempVaults();
  dialogMonitor.start();

  // Fail early if Obsidian is not running or CLI is not responsive.
  // We never kill the user's Obsidian instance — require it to be running and healthy.
  if (!await checkObsidianRunning()) {
    throw new Error(
      'Obsidian is not running. Start Obsidian and open a vault before running integration tests.'
    );
  }

  try {
    await exec('obsidian eval --allow-focus-steal "code=1"', { isQuiet: true });
  } catch {
    throw new Error(
      'Obsidian is running but CLI eval is not responding. '
        + 'Ensure at least one vault is open and CLI is enabled in Obsidian settings.'
    );
  }
}, CLI_READINESS_TIMEOUT_IN_MILLISECONDS);

afterAll(() => {
  dialogMonitor.stop();
  cleanStaleTempVaults();
});

afterEach(async () => {
  dialogMonitor.assertNoDialogs();
  dialogMonitor.reset();

  // Check for web-based trust dialog in any open vault
  const config = JSON.parse(readFileSync(getObsidianJsonPath(), 'utf-8')) as ObsidianJsonConfig;
  for (const entry of Object.values(config.vaults)) {
    if (entry.open) {
      try {
        const hasTrustDialog = await evalInObsidian({
          fn(): boolean {
            const modals = document.querySelectorAll('.modal-container');
            for (const modal of modals) {
              if (modal.textContent.includes('Do you trust the author')) {
                return true;
              }
            }
            return false;
          },
          shouldSkipPreflightChecks: true,
          vaultPath: entry.path
        });
        if (hasTrustDialog) {
          throw new Error(`"Do you trust the author" dialog detected in vault: ${entry.path}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Do you trust the author')) {
          throw error;
        }
        // Eval failed (vault window may be closing) — skip check
      }
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// B. Obsidian running with target vault open
// ─────────────────────────────────────────────────────────────────
describe('B: Obsidian running + target vault open', () => {
  const tempVault = new TempVault();

  beforeAll(async () => {
    await tempVault.register();
  }, VAULT_LIFECYCLE_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await tempVault.dispose();
  }, VAULT_LIFECYCLE_TIMEOUT_IN_MILLISECONDS);

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
    // Unregister via IPC (removes from Obsidian's in-memory registry)
    // Then also clean the config file and temp dir
    try {
      await transport.unregisterVault(targetDir);
    } catch {
      // May already be unregistered from C2/C3 config manipulation
      removeVaultFromConfig(targetDir);
    }
    await removeTempDir(targetDir);
  }, VAULT_LIFECYCLE_TIMEOUT_IN_MILLISECONDS);

  it('C1: target registered — preflightCheck should auto-open vault', async () => {
    // Wait for CLI to be ready (may be temporarily unavailable after B's vault window destroy)
    await waitForCliReady();

    // Register via IPC so Obsidian's in-memory registry has the vault
    await transport.registerVault(targetDir);
    // Destroy the window
    await closeVaultWindow(targetDir);
    // Manually set open=false in obsidian.json since Obsidian may not
    // Update it promptly after a forced window.destroy()
    setVaultOpenFlag(targetDir, false);

    expect(isVaultRegistered(targetDir)).toBe(true);
    expect(isVaultOpen(targetDir)).toBe(false);

    // Now preflightCheck should auto-open it via URI (using known vault ID)
    await transport.preflightCheck(targetDir);
    expect(isVaultOpen(targetDir)).toBe(true);

    // Clean up
    await closeVaultWindow(targetDir);
  }, VAULT_LIFECYCLE_TIMEOUT_IN_MILLISECONDS);

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
  let previouslyOpenVaultIds: string[] = [];

  beforeAll(async () => {
    targetDir = createTempVaultDir();
    configBackupBeforeD = backupObsidianJson();

    // Wait for CLI to be ready (may be recovering from C's vault operations)
    await waitForCliReady();

    // Register target vault via IPC while user's vault is still open
    await transport.registerVault(targetDir);
    await closeVaultAndClearFlag(targetDir);

    // Save config again (now includes target vault with its IPC-assigned ID)
    configBackupBeforeD = backupObsidianJson();

    // Remember which vaults are currently open so we can restore them
    const config = JSON.parse(readFileSync(getObsidianJsonPath(), 'utf-8')) as ObsidianJsonConfig;
    previouslyOpenVaultIds = Object.entries(config.vaults)
      .filter(([_id, entry]) => entry.open === true)
      .map(([id]) => id);

    // Close ALL vault windows to trigger vault chooser
    for (const entry of Object.values(config.vaults)) {
      if (entry.open) {
        await closeVaultAndClearFlag(entry.path);
      }
    }
  }, VAULT_CHOOSER_SETUP_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    // Restore original config (preserves original vault IDs)
    restoreObsidianJson(configBackupBeforeD);

    // Reopen the vaults that were open before D closed them
    for (const vaultId of previouslyOpenVaultIds) {
      const uri = `obsidian://open?vault=${encodeURIComponent(vaultId)}`;
      if (process.platform === 'win32') {
        await exec(`start "" "${uri}"`, { isQuiet: true });
      } else if (process.platform === 'darwin') {
        await exec(`open "${uri}"`, { isQuiet: true });
      } else {
        await exec(`xdg-open "${uri}"`, { isQuiet: true });
      }
      await delay(VAULT_CLOSE_DELAY_IN_MILLISECONDS);
    }

    // Wait for CLI to recover
    await waitForCliReady();

    // Unregister test vault via IPC (clears in-memory registry too)
    try {
      await transport.unregisterVault(targetDir);
    } catch {
      removeVaultFromConfig(targetDir);
    }
    await removeTempDir(targetDir);
  }, VAULT_CHOOSER_SETUP_TIMEOUT_IN_MILLISECONDS);

  it('D1: target registered — preflightCheck should open vault', async () => {
    expect(isVaultRegistered(targetDir)).toBe(true);
    expect(isVaultOpen(targetDir)).toBe(false);

    await transport.preflightCheck(targetDir);
    expect(isVaultOpen(targetDir)).toBe(true);

    await closeVaultAndClearFlag(targetDir);
  }, VAULT_LIFECYCLE_TIMEOUT_IN_MILLISECONDS);

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
// A. No Obsidian running
//
// Skipped when Obsidian is already running — we never kill
// The user's instance. To run these: close Obsidian first.
// When Obsidian is not running, A1 will auto-start it via
// PreflightCheck using the test vault (not the user's vaults).
// ─────────────────────────────────────────────────────────────────
describe('A: No Obsidian running', () => {
  let targetDir: string;
  let obsidianWasRunningBeforeA: boolean;

  beforeAll(async () => {
    obsidianWasRunningBeforeA = await checkObsidianRunning();
    targetDir = createTempVaultDir();
  });

  afterAll(async () => {
    removeVaultFromConfig(targetDir);
    await removeTempDir(targetDir);
  });

  it('A1: target registered — should auto-start Obsidian', async ({ skip }) => {
    if (obsidianWasRunningBeforeA) {
      skip();
      return;
    }
    registerVaultInConfig(targetDir);

    await transport.preflightCheck(targetDir);
    expect(await checkObsidianRunning()).toBe(true);
  }, VAULT_LIFECYCLE_TIMEOUT_IN_MILLISECONDS);

  it('A2: target not registered — preflightCheck should fail', async ({ skip }) => {
    if (obsidianWasRunningBeforeA) {
      skip();
      return;
    }
    removeVaultFromConfig(targetDir);
    expect(isVaultRegistered(targetDir)).toBe(false);

    await expect(transport.preflightCheck(targetDir))
      .rejects.toThrow(/not registered/i);
  });

  it('A3: no vaults registered — preflightCheck should fail', async ({ skip }) => {
    if (obsidianWasRunningBeforeA) {
      skip();
      return;
    }
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
