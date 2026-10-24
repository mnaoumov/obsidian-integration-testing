/**
 * @file
 *
 * Proves the write-loss guard (`src/android-write-loss-guard.ts`) is live in a vault the Android transport
 * opened, and that it writes a file again when the device reports it landed empty.
 *
 * The emulator loses about one write in a hundred, which cannot be produced on demand, so the suite makes
 * the adapter's `stat` report the size the loss leaves behind (0 bytes) for one call. That is exactly the
 * reading the guard acts on, and everything after it — the second write through the real adapter, and the
 * file Obsidian then reads back — is the live code path.
 *
 * Runs in its own Vitest project (`integration-tests:android`) against a real emulator via Appium.
 */

import type { Stat } from 'obsidian';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { TemporaryVault } from './temporary-vault.ts';

// The same budget the other Android suites carry: emulator boot, Appium session and the network-ready gate.
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 540_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

interface WriteLossGuardHolder {
  __obsidianIntegrationTestingWriteLossGuard?: WriteLossGuardState;
}

interface WriteLossGuardState {
  rewrites: string[];
}

interface WriteResult {
  readonly content: string;
  readonly rewrites: string[];
}

describe('Android write-loss guard', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  it('should be installed in the vault the transport opened', async () => {
    const isInstalled = await evalInObsidian({
      callback({ obsidianModule }): boolean {
        return obsidianModule.Platform.isMobile && !!(globalThis as WriteLossGuardHolder).__obsidianIntegrationTestingWriteLossGuard;
      },
      vaultPath: vault.path
    });

    expect(isInstalled).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should write a file again when the device reports it landed empty', async () => {
    const result = await evalInObsidian({
      async callback({ app }): Promise<WriteResult> {
        const adapter = app.vault.adapter;
        const originalStat = adapter.stat.bind(adapter);
        let isLossPending = true;
        adapter.stat = async (path): Promise<null | Stat> => {
          const stat = await originalStat(path);
          if (isLossPending && path === 'lost.md' && stat) {
            isLossPending = false;
            return { ...stat, size: 0 };
          }
          return stat;
        };

        try {
          await adapter.write('lost.md', 'written twice');
        } finally {
          adapter.stat = originalStat;
        }

        const state = (globalThis as WriteLossGuardHolder).__obsidianIntegrationTestingWriteLossGuard;
        const rewrites = state?.rewrites ?? [];
        if (state) {
          state.rewrites = [];
        }

        return { content: await adapter.read('lost.md'), rewrites };
      },
      vaultPath: vault.path
    });

    expect(result.rewrites).toEqual(['lost.md (13 bytes, attempt 1)']);
    expect(result.content).toBe('written twice');
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
