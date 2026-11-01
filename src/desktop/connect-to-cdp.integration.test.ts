import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { CdpConnection } from './connect-to-cdp.ts';

import { getFunctionExpressionString } from '../eval/function-expression.ts';
import { connectToCdp } from './connect-to-cdp.ts';

// Launching an owned Obsidian instance can take up to a minute (download-free
// when the installed asar is reused, but CDP still needs time to come up).
const LAUNCH_TIMEOUT_IN_MILLISECONDS = 120_000;

// A config folder that is not Obsidian's default, so a vault opened against the
// default is distinguishable from one opened against the override.
const CONFIG_DIRECTORY = '.obsidian-desktop';

/**
 * What a raw `getObsidianModule()` call saw, sampled inside Obsidian.
 */
interface ObsidianModuleProbe {
  /**
  `typeof` the resolved module's `Plugin` export.
  */
  readonly pluginType: string;

  /**
  Whether community plugins were already on before the call.
  */
  readonly wasEnabled: boolean;
}

/**
 * One entry of the registry Obsidian's `vault-list` IPC returns.
 */
interface RegisteredVault {
  /**
  The vault's folder.
  */
  readonly path: string;
}

/**
 * The observable state of the owned window, sampled inside Obsidian.
 */
interface WindowState {
  /**
  Whether the window's left edge sits at/beyond the screen's right edge.
  */
  readonly isOffscreen: boolean;

  /**
  Whether `requestAnimationFrame` kept firing (renderer not backgrounded).
  */
  readonly rafFired: boolean;

  /**
  `document.visibilityState` at sample time.
  */
  readonly visibility: string;
}

/**
 * Samples the owned window's position and liveness from inside Obsidian, after a
 * short delay so `requestAnimationFrame` has time to fire. Serialized to a string
 * and run via {@link CdpConnection.invoke}; returns a JSON {@link WindowState}.
 *
 * @returns A promise resolving to the JSON-serialized {@link WindowState}.
 */
async function sampleWindowState(): Promise<string> {
  const RAF_ALIVE_THRESHOLD = 10;
  const SAMPLE_DELAY_IN_MILLISECONDS = 800;
  let rafCount = 0;
  requestAnimationFrame(tick);
  // Runs serialized inside Obsidian, so `sleep` is the Obsidian runtime global.
  await sleep(SAMPLE_DELAY_IN_MILLISECONDS);
  return JSON.stringify({
    isOffscreen: window.screenX >= window.screen.width,
    rafFired: rafCount > RAF_ALIVE_THRESHOLD,
    visibility: document.visibilityState
  });

  function tick(): void {
    rafCount++;
    requestAnimationFrame(tick);
  }
}

const WINDOW_STATE_EXPR = `(${getFunctionExpressionString(sampleWindowState)})()`;

/**
 * The fields of CDP's `/json/version` answer this suite reads.
 */
interface CdpVersionInfo {
  /**
  The browser target's socket URL; its id is new for every Electron main process.
  */
  readonly webSocketDebuggerUrl: string;
}

/**
 * Reads the browser socket URL, which identifies the Electron main process serving the port.
 *
 * @param cdpUrl - The instance's CDP base URL.
 * @returns The browser target's socket URL.
 */
async function readBrowserWebSocketUrl(cdpUrl: string): Promise<string> {
  const response = await fetch(`${cdpUrl}/json/version`);
  const info = await response.json() as CdpVersionInfo;
  return info.webSocketDebuggerUrl;
}

describe('connect-to-cdp integration', () => {
  it('opens a temp vault, evaluates, and removes the vault on dispose', async () => {
    const connection = await connectToCdp();
    const { path: vaultPath } = connection.vault;
    try {
      expect(connection.port).toBeGreaterThan(0);
      expect(connection.cdpUrl).toContain(String(connection.port));
      expect(existsSync(vaultPath)).toBe(true);

      expect(await connection.invoke('2 + 3')).toBe('5');

      const vaultName = await connection.evalInObsidian({
        callback({ app }): string {
          return app.vault.getName();
        }
      });
      expect(typeof vaultName).toBe('string');
      expect(vaultName.length).toBeGreaterThan(0);
    } finally {
      await connection.dispose();
    }

    // The throw-away temp vault is removed on dispose.
    expect(existsSync(vaultPath)).toBe(false);
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('resolves the obsidian module from a raw invoke while the fresh vault is still in restricted mode', async () => {
    // A fresh vault starts with community plugins off, and `loadPlugin` then runs
    // nothing, so a direct `getObsidianModule()` that skipped turning them on threw
    // `Failed to load obsidian module`. Only `evalWrapper` used to turn them on.
    const connection = await connectToCdp();
    try {
      const probe = JSON.parse(
        await connection.invoke(
          '(async () => { const wasEnabled = app.plugins.isEnabled(); const m = await window.__obsidianIntegrationTesting.getObsidianModule(); return JSON.stringify({ pluginType: typeof m.Plugin, wasEnabled }); })()'
        )
      ) as ObsidianModuleProbe;
      expect(probe.wasEnabled).toBe(false);
      expect(probe.pluginType).toBe('function');
    } finally {
      await connection.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('launches the owned window off-screen (hidden) yet keeps the renderer alive', async () => {
    const connection = await connectToCdp({ isObsidianAppVisible: false });
    try {
      const state = JSON.parse(await connection.invoke(WINDOW_STATE_EXPR)) as WindowState;
      // Hidden = moved off-screen (not minimized), so the renderer stays live:
      // `requestAnimationFrame` keeps firing and visibility stays `visible`.
      expect(state.isOffscreen).toBe(true);
      expect(state.visibility).toBe('visible');
      expect(state.rafFired).toBe(true);
    } finally {
      await connection.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('keeps the owned window on-screen when visible', async () => {
    const connection = await connectToCdp({ isObsidianAppVisible: true });
    try {
      const state = JSON.parse(await connection.invoke(WINDOW_STATE_EXPR)) as WindowState;
      expect(state.isOffscreen).toBe(false);
      expect(state.rafFired).toBe(true);
    } finally {
      await connection.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('kills an owned instance that relaunched itself into a new process', async () => {
    // Obsidian's `relaunch` IPC is `app.relaunch(); app.quit()`: the launched PID
    // exits and a new main process takes over the same CDP port, outside the tree
    // the harness holds. Dispose used to kill only that dead PID and leave the
    // relaunched instance running.
    const connection = await connectToCdp({ isObsidianAppVisible: false });
    const browserIdBefore = await readBrowserWebSocketUrl(connection.cdpUrl);
    try {
      await connection.invoke('(window.electron.ipcRenderer.sendSync("relaunch"), "sent")').catch(() => {
        // The renderer may die before it answers; the relaunch is what matters.
      });
      await vi.waitFor(async () => {
        const browserIdAfter = await readBrowserWebSocketUrl(connection.cdpUrl);
        expect(browserIdAfter).not.toBe(browserIdBefore);
      }, { interval: 500, timeout: 60_000 });
    } finally {
      await connection.dispose();
    }

    await vi.waitFor(async () => {
      await expect(fetch(`${connection.cdpUrl}/json/version`)).rejects.toThrow();
    }, { interval: 500, timeout: 15_000 });
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('never removes a real vault directory on dispose', async () => {
    const realVaultPath = mkdtempSync(join(tmpdir(), 'connect-to-cdp-real-'));
    try {
      const connection = await connectToCdp({ vault: realVaultPath });
      try {
        expect(connection.vault.path).toBe(realVaultPath);
        expect(await connection.invoke('1 + 1')).toBe('2');
      } finally {
        await connection.dispose();
      }

      // A real vault passed by path is preserved, never auto-deleted.
      expect(existsSync(realVaultPath)).toBe(true);
    } finally {
      rmSync(realVaultPath, { force: true, recursive: true });
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('leaves an already-open vault window alone when an attached connection to it is disposed', async () => {
    // Attaching to somebody's running Obsidian with `vault` set to the vault it already has open used to send
    // `vault-open` anyway, record the window as this connection's own, and destroy it on dispose. That was the
    // instance's only window, so the app quit. The owned connection stands in for the owner's Obsidian here.
    const owner = await connectToCdp();
    try {
      const attached = await connectToCdp({ port: owner.port, vault: owner.vault.path });
      try {
        expect(await attached.invoke('1 + 1')).toBe('2');
      } finally {
        await attached.dispose();
      }

      // The window survived, and so did the instance.
      expect(await owner.invoke('app.vault.adapter.getBasePath()')).toBe(owner.vault.path);
      expect(existsSync(owner.vault.path)).toBe(true);
    } finally {
      await owner.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('keeps a registered but closed vault in the vault list when an attached connection to it is disposed', async () => {
    // Attaching with `vault` set to a vault the instance lists but does not have open sends `vault-open`, so the
    // window is the connection's own and comes down on dispose. Its `vault-remove` used to come with it, which
    // deleted the entry from the instance's `obsidian.json`: an attach dropped a real vault from the owner's list.
    const owner = await connectToCdp();
    const closedVaultPath = mkdtempSync(join(tmpdir(), 'connect-to-cdp-closed-'));
    try {
      await owner.evalInObsidian({
        async callback({ closedVaultPath: pathToOpen, lib }): Promise<void> {
          const remote = globalThis.electron.remote;
          globalThis.electron.ipcRenderer.sendSync('vault-open', pathToOpen, false);
          await lib.waitUntil({
            message: 'the second vault window to open',
            predicate: () => remote.BrowserWindow.getAllWindows().length === 2,
            timeoutInMilliseconds: 20_000
          });
          const ownWindow = remote.getCurrentWindow();
          for (const browserWindow of remote.BrowserWindow.getAllWindows()) {
            if (browserWindow.id !== ownWindow.id) {
              browserWindow.destroy();
            }
          }
          await lib.waitUntil({
            message: 'the second vault window to close',
            predicate: () => remote.BrowserWindow.getAllWindows().length === 1,
            timeoutInMilliseconds: 20_000
          });
        },
        input: { closedVaultPath }
      });
      expect(await readRegisteredVaultPaths(owner)).toContain(closedVaultPath);

      const attached = await connectToCdp({ port: owner.port, vault: closedVaultPath });
      try {
        expect(await attached.invoke('app.vault.adapter.getBasePath()')).toBe(closedVaultPath);
      } finally {
        await attached.dispose();
      }

      // The connection closed the window it opened and left the registry entry it found.
      await vi.waitFor(async () => {
        expect(await owner.invoke('electron.remote.BrowserWindow.getAllWindows().length')).toBe('1');
      }, { timeout: 20_000 });
      expect(await readRegisteredVaultPaths(owner)).toContain(closedVaultPath);
      expect(existsSync(closedVaultPath)).toBe(true);
    } finally {
      await owner.dispose();
      rmSync(closedVaultPath, { force: true, recursive: true });
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('opens a vault whose config folder is not .obsidian', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'connect-to-cdp-config-dir-'));
    try {
      const connection = await connectToCdp({ configDirectory: CONFIG_DIRECTORY, vault: vaultPath });
      try {
        const configDirectory = await connection.evalInObsidian({
          callback({ app }): string {
            return app.vault.configDir;
          }
        });
        expect(configDirectory).toBe(CONFIG_DIRECTORY);
      } finally {
        await connection.dispose();
      }

      // Obsidian provisioned the requested folder, and never the default one —
      // A default `.obsidian` here would mean the override was ignored.
      expect(existsSync(join(vaultPath, CONFIG_DIRECTORY))).toBe(true);
      expect(existsSync(join(vaultPath, '.obsidian'))).toBe(false);
    } finally {
      rmSync(vaultPath, { force: true, recursive: true });
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('reads settings from the requested config folder, not from a stale .obsidian beside it', async () => {
    // The motivating case: a vault that has both folders. Asserting on
    // `app.vault.configDir` alone would pass even if Obsidian had loaded the stale folder's
    // settings, so this asserts on a value that differs BETWEEN the two folders.
    const vaultPath = mkdtempSync(join(tmpdir(), 'connect-to-cdp-stale-config-'));
    try {
      writeAppJson(join(vaultPath, '.obsidian'), 'stale');
      writeAppJson(join(vaultPath, CONFIG_DIRECTORY), 'requested');

      const connection = await connectToCdp({ configDirectory: CONFIG_DIRECTORY, vault: vaultPath });
      try {
        const attachmentFolderPath = await connection.evalInObsidian({
          callback({ app }): string {
            return String(app.vault.getConfig('attachmentFolderPath'));
          }
        });
        expect(attachmentFolderPath).toBe('requested');
      } finally {
        await connection.dispose();
      }
    } finally {
      rmSync(vaultPath, { force: true, recursive: true });
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);

  it('rejects an invalid config folder name before launching Obsidian', async () => {
    // Obsidian would silently substitute `.obsidian` for each of these, so they
    // have to fail here rather than boot a plausible-looking wrong vault.
    for (const configDirectory of ['obsidian-desktop', '.', '.config/nested']) {
      await expect(connectToCdp({ configDirectory })).rejects.toThrow('Invalid configDir');
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);
});

/**
 * Reads the vault paths the instance behind a connection lists in its registry, over Obsidian's `vault-list` IPC.
 *
 * @param connection - A connection to the instance.
 * @returns The registered vault paths.
 */
async function readRegisteredVaultPaths(connection: CdpConnection): Promise<string[]> {
  return await connection.evalInObsidian({
    callback(): string[] {
      const registry = globalThis.electron.ipcRenderer.sendSync('vault-list') as Record<string, RegisteredVault>;
      return Object.values(registry).map((entry) => entry.path);
    }
  });
}

/**
 * Writes a minimal `app.json` into a vault config folder, carrying a marker value
 * that identifies which folder Obsidian actually loaded its settings from.
 *
 * @param configDirectoryPath - Absolute path to the config folder to create.
 * @param marker - The `attachmentFolderPath` value to store as the marker.
 */
function writeAppJson(configDirectoryPath: string, marker: string): void {
  mkdirSync(configDirectoryPath, { recursive: true });
  writeFileSync(join(configDirectoryPath, 'app.json'), JSON.stringify({ attachmentFolderPath: marker }));
}
