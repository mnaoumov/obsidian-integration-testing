import {
  describe,
  expect,
  it
} from 'vitest';

import { shouldTearDownVaultWindow } from './vault-teardown-verdict.ts';

describe('shouldTearDownVaultWindow', () => {
  it('refuses for an owned instance, which is killed wholesale instead', () => {
    expect(shouldTearDownVaultWindow({
      isHarnessOwnedInstance: false,
      isOwnedInstance: true,
      isSelfRegistered: true
    })).toBe(false);

    expect(shouldTearDownVaultWindow({
      isHarnessOwnedInstance: false,
      isOwnedInstance: true,
      isSelfRegistered: false
    })).toBe(false);
  });

  it('refuses when an attached worker did not register the vault itself', () => {
    // The regression this module exists for: the shared setup vault's window is
    // The instance's only one, so tearing it down quits the app for every worker.
    expect(shouldTearDownVaultWindow({
      isHarnessOwnedInstance: true,
      isOwnedInstance: false,
      isSelfRegistered: false
    })).toBe(false);
  });

  it('allows an attached worker to tear down a vault it registered itself', () => {
    expect(shouldTearDownVaultWindow({
      isHarnessOwnedInstance: true,
      isOwnedInstance: false,
      isSelfRegistered: true
    })).toBe(true);
  });

  it('allows teardown in plain attach mode, whoever registered the vault', () => {
    expect(shouldTearDownVaultWindow({
      isHarnessOwnedInstance: false,
      isOwnedInstance: false,
      isSelfRegistered: true
    })).toBe(true);

    expect(shouldTearDownVaultWindow({
      isHarnessOwnedInstance: false,
      isOwnedInstance: false,
      isSelfRegistered: false
    })).toBe(true);
  });

  it('treats an owned instance as owned even when both flags are set', () => {
    expect(shouldTearDownVaultWindow({
      isHarnessOwnedInstance: true,
      isOwnedInstance: true,
      isSelfRegistered: true
    })).toBe(false);
  });
});
