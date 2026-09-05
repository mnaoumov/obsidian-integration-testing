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
  it
} from 'vitest';

import { connectToCdp } from './connect-to-cdp.ts';
import { getFunctionExpressionString } from './function-expression.ts';

// Launching an owned Obsidian instance can take up to a minute (download-free
// When the installed asar is reused, but CDP still needs time to come up).
const LAUNCH_TIMEOUT_IN_MILLISECONDS = 120_000;

// A config folder that is not Obsidian's default, so a vault opened against the
// Default is distinguishable from one opened against the override.
const CONFIG_DIRECTORY = '.obsidian-desktop';

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
    // The motivating case (T908): a vault that has both folders. Asserting on
    // `app.vault.configDir` alone would pass even if Obsidian had loaded the stale folder's
    // Settings, so this asserts on a value that differs BETWEEN the two folders.
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
    // Have to fail here rather than boot a plausible-looking wrong vault.
    for (const configDirectory of ['obsidian-desktop', '.', '.config/nested']) {
      await expect(connectToCdp({ configDirectory })).rejects.toThrow('Invalid configDir');
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS);
});

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
