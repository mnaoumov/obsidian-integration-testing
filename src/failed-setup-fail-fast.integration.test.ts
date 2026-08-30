/**
 * @file
 *
 * Regression suite for a **failed** global setup (**L9**, T726).
 *
 * Its project's global setup is wired to fail — an `obsidian-cdp` transport attaching to a port nothing
 * can serve — so every test here runs in the state a worker is left in after a real setup failure: no
 * transport options published, no temp vault path, only the stored failure.
 *
 * Before the fix, that state meant `getTransportOptions()` returned `undefined`, `undefined` meant the
 * owned **desktop** CDP default, and the first eval died on `Failed to parse URL from /json` — a mask
 * naming neither the transport nor the setup, which for an Android project also meant the suite was
 * quietly running on desktop. These tests assert the harness now fails with the ORIGINAL cause instead,
 * before any transport is built.
 *
 * Hermetic: nothing here launches Obsidian, downloads anything, or takes a setup lock.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { IntegrationSetupFailedError } from './integration-setup-failed-error.ts';
import { getTemporaryVault } from './vitest/global-setup.ts';

describe('a failed global setup', () => {
  it('should fail an eval with the setup failure, not a fallback transport error', async () => {
    const evalPromise = evalInObsidian({ callback: () => 'unreachable' });

    await expect(evalPromise).rejects.toThrow(IntegrationSetupFailedError);
    // The mask this suite exists to prevent: a desktop transport nobody asked for, fetching a bare path.
    await expect(evalPromise).rejects.not.toThrow('/json');
  });

  it('should name the transport the failed project was configured for', async () => {
    await expect(evalInObsidian({ callback: () => 'unreachable' })).rejects.toThrow('obsidian-cdp');
  });

  it('should fail the temp-vault accessor with the same error', () => {
    expect(() => getTemporaryVault()).toThrow(IntegrationSetupFailedError);
  });
});
