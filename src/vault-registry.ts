/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

/**
 * @packageDocumentation
 *
 * Manages vault registration in the running Obsidian instance.
 */

import type { FileSystemAdapter } from 'obsidian';

import { evalInObsidian } from './obsidian-cli.ts';

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30000;
const CLOSE_DELAY_MS = 1000;

interface Electron {
  remote: ElectronRemote;
}

interface ElectronRemote {
  getCurrentWindow(): GetCurrentWindowResult;
}

interface GetCurrentWindowResult {
  destroy(): void;
}

/**
 * Registers a vault path in the running Obsidian instance so the CLI can target it via `cwd`.
 *
 * Uses the `vault-open` IPC to register and open the vault, then polls until
 * the vault's CLI is ready and `getBasePath()` matches `vaultPath`.
 *
 * @param vaultPath - The absolute path to the vault folder.
 */
export async function registerVault(vaultPath: string): Promise<void> {
  // Open the vault via IPC. The sendSync return value is unreliable
  // (CLI output may be lost when the new window opens), so we ignore it
  // And poll for readiness instead.
  await evalInObsidian({
    args: { vaultPath },
    // eslint-disable-next-line no-shadow -- No actual shadowing as the function is executed externally.
    fn({ vaultPath }): void {
      window.electron.ipcRenderer.sendSync('vault-open', vaultPath, false);
    },
    shouldSkipPreflightChecks: true
  });

  // Poll until the new vault's CLI responds with the correct basePath.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const basePath = await evalInObsidian({
        fn({ app }): string {
          return (app.vault.adapter as FileSystemAdapter).getBasePath();
        },
        shouldSkipPreflightChecks: true,
        vaultPath
      });
      if (basePath === vaultPath) {
        return;
      }
    } catch {
      // Vault not ready yet.
    }
    await new Promise((r) => {
      setTimeout(r, POLL_INTERVAL_MS);
    });
  }
  throw new Error(`Vault at ${vaultPath} did not become ready within ${String(POLL_TIMEOUT_MS)}ms`);
}

/**
 * Unregisters a vault path from the running Obsidian instance.
 *
 * Schedules the vault window to close, waits for it, then removes
 * the vault from the registry via `vault-remove` IPC.
 *
 * @param vaultPath - The absolute path to the vault folder.
 */
export async function unregisterVault(vaultPath: string): Promise<void> {
  // Schedule the vault window to close from within its own context.
  // Use setTimeout so the CLI response is sent before the window closes.
  try {
    await evalInObsidian({
      fn(): void {
        setTimeout(() => {
          (window.electron as Partial<Electron>).remote?.getCurrentWindow().destroy();
        }, 0);
      },
      shouldSkipPreflightChecks: true,
      vaultPath
    });
  } catch {
    // The window may have closed before the response was sent — that's OK.
  }

  // Wait for the window to actually close.
  await new Promise((r) => {
    setTimeout(r, CLOSE_DELAY_MS);
  });

  // Remove from the registry (from any remaining vault's context).
  await evalInObsidian({
    args: { vaultPath },
    // eslint-disable-next-line no-shadow -- No actual shadowing as the function is executed externally.
    fn({ vaultPath }): void {
      window.electron.ipcRenderer.sendSync('vault-remove', vaultPath);
    },
    shouldSkipPreflightChecks: true
  });
}

/* v8 ignore stop */
