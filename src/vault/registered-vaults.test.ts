import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianTransport } from '../transport/transport.ts';

import {
  forgetRegisteredVault,
  getMostRecentRegisteredVault,
  recordRegisteredVault
} from './registered-vaults.ts';

const transport = {} as ObsidianTransport;

describe('registered vaults', () => {
  it('returns the most recent vault, moves a re-recorded one to the end, and forgets one', () => {
    expect(getMostRecentRegisteredVault()).toBeNull();
    recordRegisteredVault({ path: 'a', transport });
    recordRegisteredVault({ path: 'b', transport });
    expect(getMostRecentRegisteredVault()?.path).toBe('b');
    recordRegisteredVault({ path: 'a', transport });
    expect(getMostRecentRegisteredVault()?.path).toBe('a');
    forgetRegisteredVault('a');
    expect(getMostRecentRegisteredVault()?.path).toBe('b');
    forgetRegisteredVault('missing');
    forgetRegisteredVault('b');
    expect(getMostRecentRegisteredVault()).toBeNull();
  });
});
