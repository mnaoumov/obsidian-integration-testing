import {
  describe,
  expect,
  it
} from 'vitest';

import { checkIsVaultListed } from './vault-list-membership.ts';

describe('checkIsVaultListed', () => {
  it('finds a vault listed in the registry', () => {
    expect(checkIsVaultListed({
      first: { path: '/vaults/other', ts: 1 },
      second: { path: '/vaults/real', ts: 2 }
    }, '/vaults/real')).toBe(true);
  });

  it('matches the way the transport routes, ignoring a trailing separator', () => {
    expect(checkIsVaultListed({ abc: { path: '/vaults/real/', ts: 1 } }, '/vaults/real')).toBe(true);
  });

  it('reports a vault the registry does not list', () => {
    expect(checkIsVaultListed({ abc: { path: '/vaults/other', ts: 1 } }, '/vaults/real')).toBe(false);
    expect(checkIsVaultListed({}, '/vaults/real')).toBe(false);
  });

  it('skips entries that carry no string path', () => {
    expect(checkIsVaultListed({
      a: null,
      b: 'not-an-entry',
      c: { ts: 1 },
      d: { path: 42 }
    }, '/vaults/real')).toBe(false);
  });

  it('counts an unreadable answer as listing the vault, so its entry is never removed', () => {
    expect(checkIsVaultListed(undefined, '/vaults/real')).toBe(true);
    expect(checkIsVaultListed(null, '/vaults/real')).toBe(true);
    expect(checkIsVaultListed('{}', '/vaults/real')).toBe(true);
  });
});
