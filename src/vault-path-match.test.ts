import {
  describe,
  expect,
  it
} from 'vitest';

import {
  normalizeVaultPathForComparison,
  vaultPathsMatch
} from './vault-path-match.ts';

describe('normalizeVaultPathForComparison', () => {
  it('unifies path separators to forward slashes', () => {
    expect(normalizeVaultPathForComparison('C:\\Users\\me\\vault', false)).toBe('C:/Users/me/vault');
    expect(normalizeVaultPathForComparison('/home/me/vault', false)).toBe('/home/me/vault');
    expect(normalizeVaultPathForComparison('C:\\Users/me\\vault', false)).toBe('C:/Users/me/vault');
  });

  it('collapses repeated separators and strips trailing separators', () => {
    expect(normalizeVaultPathForComparison('C:\\\\Users\\\\me\\\\', false)).toBe('C:/Users/me');
    expect(normalizeVaultPathForComparison('/home/me/vault/', false)).toBe('/home/me/vault');
    expect(normalizeVaultPathForComparison('/home/me/vault///', false)).toBe('/home/me/vault');
  });

  it('lowercases only when case-insensitive', () => {
    expect(normalizeVaultPathForComparison('C:\\Users\\Me\\Vault', true)).toBe('c:/users/me/vault');
    expect(normalizeVaultPathForComparison('C:\\Users\\Me\\Vault', false)).toBe('C:/Users/Me/Vault');
  });
});

describe('vaultPathsMatch', () => {
  it('matches identical paths', () => {
    expect(vaultPathsMatch('/home/me/vault', '/home/me/vault', false)).toBe(true);
  });

  it('matches across separator flavor and trailing separators', () => {
    expect(vaultPathsMatch('C:\\Users\\me\\vault', 'C:/Users/me/vault/', false)).toBe(true);
  });

  it('ignores case only on a case-insensitive filesystem', () => {
    expect(vaultPathsMatch('C:\\Users\\Me\\Vault', 'c:\\users\\me\\vault', true)).toBe(true);
    expect(vaultPathsMatch('C:\\Users\\Me\\Vault', 'c:\\users\\me\\vault', false)).toBe(false);
  });

  it('does not match different vaults', () => {
    expect(vaultPathsMatch('/home/me/vault-a', '/home/me/vault-b', false)).toBe(false);
  });
});
