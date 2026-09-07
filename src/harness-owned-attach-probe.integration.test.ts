/**
 * @file
 *
 * Covers the once-per-file liveness probe a worker runs before attaching to a
 * harness-owned instance.
 *
 * Hermetic: it launches nothing, downloads nothing and takes no setup lock. It
 * attaches to port 1, which `fetch` refuses outright — the same trick the
 * failed-setup project uses — so "the instance this worker was told to attach to
 * is not there" is produced instantly and without an Obsidian.
 *
 * The probe is what makes a dead instance cost **one named error per file**
 * rather than one anonymous `ECONNREFUSED` per eval, and it is the harness-side
 * replacement for the per-file CDP probe consumers were writing into their own
 * `setupFiles`.
 */

import {
  describe,
  expect,
  it
} from 'vitest';

import { OwnedInstanceExitedError } from './owned-instance-exited-error.ts';
import { getOrCreateTransport } from './transport-factory.ts';

const UNREACHABLE_CDP_PORT = 1;

describe('attaching to a harness-owned instance that is not there', () => {
  it('should fail transport creation with the named error, before any eval', async () => {
    const transportPromise = getOrCreateTransport({
      isHarnessOwnedInstance: true,
      port: UNREACHABLE_CDP_PORT,
      type: 'obsidian-cdp'
    });

    await expect(transportPromise).rejects.toThrow(OwnedInstanceExitedError);
    // No marker for this port, so the error says what it can and still names the
    // Instance as the cause — the point of it is that the reader stops looking at
    // Their own test for an explanation.
    await expect(transportPromise).rejects.toThrow('is gone');
    await expect(transportPromise).rejects.toThrow('these failures are not test results');
  });
});
