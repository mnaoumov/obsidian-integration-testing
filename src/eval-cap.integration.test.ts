/**
 * @file
 *
 * The desktop half of the per-eval cap: a closure that deliberately outruns
 * `commandTimeoutInMilliseconds` must come back as `EvalCapExceededError`
 * naming the cap and `pollInObsidian`, not as a generic CDP command timeout.
 *
 * Unit tests already prove the message and the translation in isolation. What
 * only a live run can prove is the link between them — that the transport
 * really does give up at the cap, and that the give-up really does travel
 * through `evaluate()`'s translation rather than past it. That link is exactly
 * the kind that rots silently: it would keep passing every unit test while the
 * real failure went back to reading as a wedged app.
 *
 * The closure sleeps rather than working, so the execution left running inside
 * Obsidian after the harness stops waiting cannot touch anything.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { EvalCapExceededError } from './eval-cap-exceeded-error.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { TemporaryVault } from './temporary-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
/*
 * Comfortably past the 30s default cap, so the transport gives up first and the
 * assertion is about the cap rather than about a race with it.
 */
const OVER_CAP_SLEEP_IN_MILLISECONDS = 40_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

describe('the desktop per-eval cap', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  it('should report an over-cap closure as a cap overrun, pointing at pollInObsidian', async () => {
    const evaluation = evalInObsidian({
      async callback({ overCapSleepInMilliseconds }): Promise<string> {
        await new Promise((resolve) => {
          globalThis.setTimeout(resolve, overCapSleepInMilliseconds);
        });

        return 'the closure was allowed to finish';
      },
      input: { overCapSleepInMilliseconds: OVER_CAP_SLEEP_IN_MILLISECONDS },
      vaultPath: vault.path
    });

    await expect(evaluation).rejects.toThrow(EvalCapExceededError);
    // The two things a reader needs and the old message withheld: which budget ended it, and the way out.
    await expect(evaluation).rejects.toThrow(/desktop \(CDP\)/);
    await expect(evaluation).rejects.toThrow(/pollInObsidian/);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // The cap must not have eaten the session with the closure: everything after it would otherwise fail
  // For a reason that has nothing to do with what it is testing.
  it('should leave the transport usable for the next evaluation', async () => {
    const markdownPaths = await evalInObsidian({
      callback({ app }): string[] {
        return app.vault.getMarkdownFiles().map((file) => file.path);
      },
      vaultPath: vault.path
    });

    expect(markdownPaths).toContain('note.md');
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
