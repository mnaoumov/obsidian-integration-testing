/**
 * @file
 *
 * Integration test for {@link pollInObsidian}: a `start` closure kicks off a
 * delayed in-renderer mutation, and the Node-side poll loop drives short `poll`
 * evals until the mutation lands — exercising the "kick off + poll from Node"
 * path that works around CDP's ~30s single-eval cap.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { pollInObsidian } from './poll-in-obsidian.ts';
import { TemporaryVault } from './temporary-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const POLL_TIMEOUT_IN_MILLISECONDS = 15_000;
const POLL_INTERVAL_IN_MILLISECONDS = 100;
const WORK_DELAY_IN_MILLISECONDS = 1000;

/**
A window view exposing the ad-hoc marker the closures read/write.
*/
interface MarkerWindow extends Window {
  __t116PollMarker?: boolean;
}

describe('pollInObsidian', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  it('kicks off work with start, then polls until it completes', async () => {
    const isWorkMarkerSet = await pollInObsidian({
      input: { workDelayInMilliseconds: WORK_DELAY_IN_MILLISECONDS },
      intervalInMilliseconds: POLL_INTERVAL_IN_MILLISECONDS,

      poll(): boolean {
        // eslint-disable-next-line unicorn/prefer-global-this -- This closure is serialized into the Obsidian renderer, where the marker lives on `Window`. Node's `typeof globalThis` is not a `Window`, so the annotation only typechecks against `window`.
        const markerWindow: MarkerWindow = window;
        return Boolean(markerWindow.__t116PollMarker);
      },

      start({ workDelayInMilliseconds }): void {
        // eslint-disable-next-line unicorn/prefer-global-this -- This closure is serialized into the Obsidian renderer, where the marker lives on `Window`. Node's `typeof globalThis` is not a `Window`, so the annotation only typechecks against `window`.
        const markerWindow: MarkerWindow = window;
        markerWindow.__t116PollMarker = false;
        globalThis.setTimeout(() => {
          markerWindow.__t116PollMarker = true;
        }, workDelayInMilliseconds);
      },

      timeoutInMilliseconds: POLL_TIMEOUT_IN_MILLISECONDS,
      until: (done) => done,
      vaultPath: vault.path
    });

    expect(isWorkMarkerSet).toBe(true);
  });

  it('rejects with the timeout message when the condition never holds', async () => {
    await expect(pollInObsidian({
      intervalInMilliseconds: POLL_INTERVAL_IN_MILLISECONDS,
      poll(): boolean {
        return false;
      },
      timeoutInMilliseconds: POLL_INTERVAL_IN_MILLISECONDS * 3,
      timeoutMessage: 'marker never set',
      until: (done) => done,
      vaultPath: vault.path
    })).rejects.toThrow('marker never set');
  });
});
