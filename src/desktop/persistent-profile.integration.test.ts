import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  describe,
  expect,
  it
} from 'vitest';

import { connectToCdp } from './connect-to-cdp.ts';
import {
  PERSISTENT_PROFILE_LOCK_FILE_NAME,
  PersistentProfileInUseError
} from './owned-instance/persistent-profile.ts';

const LAUNCH_TIMEOUT_IN_MILLISECONDS = 240_000;
const KEPT_VAULT_ID = 'a1b2c3d4e5f60718';
const FOREIGN_VAULT_ID = 'f0f0f0f0f0f0f0f0';
const MARKER_KEY = 'obsidian-integration-testing-persistent-profile-marker';

interface ProfileProbe {
  readonly appId: string;
  readonly marker: null | string;
}

interface ProfileRegistry {
  readonly vaults: Record<string, RegisteredVault>;
}

interface RegisteredVault {
  readonly path: string;
}

describe('persistentUserDataDirectory', () => {
  const root = mkdtempSync(join(tmpdir(), 'persistent-profile-'));
  const profile = join(root, 'profile');
  const vaultPath = join(root, 'vault');
  const foreignVaultPath = join(root, 'foreign-vault');
  mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
  writeFileSync(join(vaultPath, '.obsidian', 'app.json'), '{}');
  // A real folder: Obsidian drops a registry entry whose folder is gone, which would mask a merge that lost it.
  mkdirSync(foreignVaultPath, { recursive: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'obsidian.json'),
    JSON.stringify({
      vaults: {
        [FOREIGN_VAULT_ID]: { open: true, path: foreignVaultPath, ts: 1 },
        [KEPT_VAULT_ID]: { path: vaultPath, ts: 2 }
      }
    })
  );

  afterAll(() => {
    rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 500 });
  });

  it('should reuse the profile across launches, keep its registry and vault id, and refuse a second run', async () => {
    const first = await connectToCdp({ isObsidianAppVisible: false, persistentUserDataDirectory: profile, vault: vaultPath });
    try {
      const probe = await first.evalInObsidian({
        callback({ app, key }): ProfileProbe {
          const marker = localStorage.getItem(key);
          localStorage.setItem(key, 'written by the first launch');
          return { appId: app.appId, marker };
        },
        input: { key: MARKER_KEY }
      });
      expect(probe).toEqual({ appId: KEPT_VAULT_ID, marker: null });
      expect(existsSync(join(profile, PERSISTENT_PROFILE_LOCK_FILE_NAME))).toBe(true);

      await expect(connectToCdp({ isObsidianAppVisible: false, persistentUserDataDirectory: profile, vault: vaultPath }))
        .rejects.toBeInstanceOf(PersistentProfileInUseError);
    } finally {
      await first.dispose();
    }

    expect(existsSync(profile)).toBe(true);
    expect(existsSync(vaultPath)).toBe(true);
    expect(existsSync(join(profile, PERSISTENT_PROFILE_LOCK_FILE_NAME))).toBe(false);
    const registry = JSON.parse(readFileSync(join(profile, 'obsidian.json'), 'utf-8')) as ProfileRegistry;
    expect(registry.vaults[FOREIGN_VAULT_ID]?.path).toBe(foreignVaultPath);
    expect(Object.keys(registry.vaults)).toHaveLength(2);

    const second = await connectToCdp({ isObsidianAppVisible: false, persistentUserDataDirectory: profile, vault: vaultPath });
    try {
      const probe = await second.evalInObsidian({
        callback({ app, key }): ProfileProbe {
          return { appId: app.appId, marker: localStorage.getItem(key) };
        },
        input: { key: MARKER_KEY }
      });
      expect(probe).toEqual({ appId: KEPT_VAULT_ID, marker: 'written by the first launch' });
    } finally {
      await second.dispose();
    }
  }, LAUNCH_TIMEOUT_IN_MILLISECONDS * 2);
});
