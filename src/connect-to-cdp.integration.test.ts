import {
  existsSync,
  mkdtempSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  expect,
  it
} from 'vitest';

import { connectToCdp } from './connect-to-cdp.ts';

// Launching an owned Obsidian instance can take up to a minute (download-free
// When the installed asar is reused, but CDP still needs time to come up).
const LAUNCH_TIMEOUT_IN_MILLISECONDS = 120_000;

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
        fn({ app }): string {
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
});
