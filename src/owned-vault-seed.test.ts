import {
  describe,
  expect,
  it
} from 'vitest';

import { buildOwnedObsidianJson } from './owned-vault-seed.ts';

const VAULT_ID = '0123456789abcdef';
const VAULT_PATH = '/tmp/harness-vault';
const TS = 1_700_000_000_000;

describe('buildOwnedObsidianJson', () => {
  it('should register the vault under its id with the path, timestamp, and per-entry open flag', () => {
    const json = buildOwnedObsidianJson({ ts: TS, vaultId: VAULT_ID, vaultPath: VAULT_PATH });

    expect(json.vaults).toEqual({
      [VAULT_ID]: { open: true, path: VAULT_PATH, ts: TS }
    });
  });

  it('should seed the top-level last_open with the vault id so old versions auto-open (not the selector)', () => {
    const json = buildOwnedObsidianJson({ ts: TS, vaultId: VAULT_ID, vaultPath: VAULT_PATH });

    expect(json.last_open).toBe(VAULT_ID);
    expect(json.last_open).toBe(Object.keys(json.vaults)[0]);
  });

  it('should carry both auto-open markers so the seed is version-agnostic', () => {
    const json = buildOwnedObsidianJson({ ts: TS, vaultId: VAULT_ID, vaultPath: VAULT_PATH });

    // Old versions read `last_open`; newer versions read the per-entry `open`.
    expect(json.last_open).toBe(VAULT_ID);
    expect(json.vaults[VAULT_ID]?.open).toBe(true);
  });

  it('should disable self-update on the throwaway instance', () => {
    const json = buildOwnedObsidianJson({ ts: TS, vaultId: VAULT_ID, vaultPath: VAULT_PATH });

    expect(json.updateDisabled).toBe(true);
  });
});
