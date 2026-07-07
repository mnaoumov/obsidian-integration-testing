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
// Generous overall budget: the connectivity check retries a flaky public
// Endpoint several times with backoff before giving up.
const FETCH_TIMEOUT_IN_MILLISECONDS = 60000;

interface NetworkCheckResult {
  readonly status: number;
  readonly textLength: number;
}

const tempVault = new TempVault();

beforeAll(async () => {
  await tempVault.register();
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await tempVault.dispose();
});

describe('emulator network connectivity', () => {
  it('should reach the internet over HTTPS (DNS + status + body)', async () => {
    // One retrying request exercises DNS, the HTTPS handshake, status, and body.
    // `httpbin.org` intermittently drops requests, so we retry with backoff.
    const result = await evalInObsidian({
      fn: async (): Promise<NetworkCheckResult> => {
        const MAX_ATTEMPTS = 5;
        const RETRY_DELAY_IN_MILLISECONDS = 1500;
        const PER_ATTEMPT_TIMEOUT_IN_MILLISECONDS = 8000;

        let lastError: unknown = new Error('No fetch attempt was made.');
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            const response = await fetch('https://httpbin.org/get', {
              signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_IN_MILLISECONDS)
            });
            const text = await response.text();
            return { status: response.status, textLength: text.length };
          } catch (error) {
            lastError = error;
            await sleep(RETRY_DELAY_IN_MILLISECONDS);
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      },
      vaultPath: tempVault.path
    });

    expect(result.status).toBe(200);
    expect(result.textLength).toBeGreaterThan(0);
  }, FETCH_TIMEOUT_IN_MILLISECONDS);
});
