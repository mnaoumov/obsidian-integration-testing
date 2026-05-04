/**
 * @file
 *
 * Integration test that verifies the emulator (or desktop host) has working
 * internet connectivity. This catches DNS / routing issues that can silently
 * break plugin downloads, sync, and other network-dependent features.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { TempVault } from './temp-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60000;
const FETCH_TIMEOUT_IN_MILLISECONDS = 15000;

const tempVault = new TempVault();

beforeAll(async () => {
  await tempVault.register();
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await tempVault.dispose();
});

describe('emulator network connectivity', () => {
  it('should be able to reach the internet via fetch', async () => {
    const statusCode = await evalInObsidian({
      fn: async (): Promise<number> => {
        const response = await fetch('https://httpbin.org/get');
        return response.status;
      },
      vaultPath: tempVault.path
    });

    expect(statusCode).toBe(200);
  }, FETCH_TIMEOUT_IN_MILLISECONDS);

  it('should be able to resolve DNS and fetch HTTPS content', async () => {
    const hasBody = await evalInObsidian({
      fn: async (): Promise<boolean> => {
        const response = await fetch('https://httpbin.org/get');
        const text = await response.text();
        return text.length > 0;
      },
      vaultPath: tempVault.path
    });

    expect(hasBody).toBe(true);
  }, FETCH_TIMEOUT_IN_MILLISECONDS);
});
