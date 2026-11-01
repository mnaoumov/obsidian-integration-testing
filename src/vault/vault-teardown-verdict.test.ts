import {
  describe,
  expect,
  it
} from 'vitest';

import { shouldTearDownVaultWindow } from './vault-teardown-verdict.ts';

describe('shouldTearDownVaultWindow', () => {
  it('refuses for an owned instance, which is killed wholesale instead', () => {
    expect(shouldTearDownVaultWindow({
      isOwnedInstance: true,
      isSelfRegistered: true
    })).toBe(false);

    expect(shouldTearDownVaultWindow({
      isOwnedInstance: true,
      isSelfRegistered: false
    })).toBe(false);
  });

  it('refuses when an attached transport did not open the vault window itself', () => {
    // Both regressions this module exists for. In a harness-owned instance the shared setup vault's window is the
    // only one, and in plain attach mode an already-open vault is the owner's own window: tearing either down quits
    // the app.
    expect(shouldTearDownVaultWindow({
      isOwnedInstance: false,
      isSelfRegistered: false
    })).toBe(false);
  });

  it('allows an attached transport to tear down a vault window it opened itself', () => {
    expect(shouldTearDownVaultWindow({
      isOwnedInstance: false,
      isSelfRegistered: true
    })).toBe(true);
  });
});
