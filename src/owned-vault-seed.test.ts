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

  it('should withhold BOTH auto-open markers when the caller wants the starter screen', () => {
    const json = buildOwnedObsidianJson({ shouldAutoOpenVault: false, ts: TS, vaultId: VAULT_ID, vaultPath: VAULT_PATH });

    // Either marker left behind would auto-open the vault on the version that reads it,
    // Destroying the starter-screen renderer the caller needs to write into.
    expect(json.last_open).toBeUndefined();
    expect(json.vaults[VAULT_ID]?.open).toBeUndefined();
  });

  it('should omit last_open entirely rather than carry it as undefined, so the written JSON has no such key', () => {
    const json = buildOwnedObsidianJson({ shouldAutoOpenVault: false, ts: TS, vaultId: VAULT_ID, vaultPath: VAULT_PATH });

    expect(Object.hasOwn(json, 'last_open')).toBe(false);
    // Asserted on the serialized form, because that string is what Obsidian reads.
    expect(JSON.stringify(json)).toBe(JSON.stringify({
      updateDisabled: true,
      vaults: { [VAULT_ID]: { path: VAULT_PATH, ts: TS } }
    }));
  });

  it('should still register the vault under the harness id when auto-open is withheld, so vault-open reuses it', () => {
    const json = buildOwnedObsidianJson({ shouldAutoOpenVault: false, ts: TS, vaultId: VAULT_ID, vaultPath: VAULT_PATH });

    expect(json.vaults[VAULT_ID]).toEqual({ path: VAULT_PATH, ts: TS });
  });

  it('should auto-open by default, so only an explicit false changes the seed', () => {
    const json = buildOwnedObsidianJson({ shouldAutoOpenVault: true, ts: TS, vaultId: VAULT_ID, vaultPath: VAULT_PATH });

    expect(json.last_open).toBe(VAULT_ID);
    expect(json.vaults[VAULT_ID]?.open).toBe(true);
  });
});
