/**
 * @file
 *
 * The Android half of the per-eval cap, and the one that actually cost
 * something: an overrun here used to be a **silent hang**, which reads as a
 * device with no network rather than as a closure that waits too long. A plugin
 * release was held for two days by that reading.
 *
 * What this asserts, and why no unit test can: that the cap is enforced at all on
 * this transport. Two measured facts shape the assertion —
 *
 * - the W3C `timeouts.script` capability is accepted, reads back as `30000` from
 *   the WebView context, and is **never enforced**: over-cap closures ran past a
 *   60s ceiling without WebDriver raising `script timeout` once; and
 * - past roughly half a minute the closure COMPLETES in the guest on schedule
 *   (timers armed at 30s and 40s fired within ~13ms of nominal, on a visible and
 *   focused page) while its Execute Script response never reaches the client.
 *
 * So the cap is enforced by `AppiumTransport.evaluate` on the Node side, and this
 * file is what proves that enforcement is live rather than nominal. An earlier
 * version of it asserted `isScriptTimeoutError`'s error instead and could only
 * ever have failed, because that error is never raised here.
 *
 * The closure sleeps rather than working, so the execution left running in the
 * WebView after the harness stops waiting cannot touch anything.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { DEFAULT_SCRIPT_TIMEOUT_IN_MILLISECONDS } from './appium-session-config.ts';
import { EvalCapExceededError } from './eval-cap-exceeded-error.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { TemporaryVault } from './temporary-vault.ts';

/*
 * The same budget the other Android suite waits out: Appium start and session
 * connection alone are 180s each, plus what the network-ready gate can add.
 */
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 360_000;
// Comfortably past the 30s default cap, so the transport gives up first.
const OVER_CAP_SLEEP_IN_MILLISECONDS = 40_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

/*
 * How far past the cap the report may arrive and still count as the CAP having produced it. Without this
 * the test would pass on a closure that merely finished late, which is the failure mode the whole issue
 * turned on — the previous version could not tell a cap from a hang, and neither could its author.
 */
const CAP_REPORT_TOLERANCE_IN_MILLISECONDS = 10_000;

describe('the Android per-eval cap', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  // The same guard the sibling Android suite carries: without a registered transport resolver the harness
  // Falls back to the desktop owned-CDP default, and this file would then prove the desktop path twice.
  it('should actually be running on mobile', async () => {
    const isMobile = await evalInObsidian({
      callback({ obsidianModule }): boolean {
        return obsidianModule.Platform.isMobile;
      },
      vaultPath: vault.path
    });

    expect(isMobile).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should report an over-cap closure as a cap overrun, pointing at pollInObsidian', async () => {
    const startedAt = Date.now();
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
    await expect(evaluation).rejects.toThrow(/Android \(Appium\)/);
    await expect(evaluation).rejects.toThrow(/pollInObsidian/);

    /*
     * The assertion that makes the three above mean something. A cap that fires at the right MOMENT is the
     * Claim; a cap that eventually fires proves only that something gave up. The window runs from the cap
     * Itself to the cap plus tolerance, and the 40s sleep sits inside it — so a run where the closure was
     * Simply allowed to finish, or where some outer budget expired, fails here rather than passing.
     */
    const elapsedInMilliseconds = Date.now() - startedAt;
    expect(elapsedInMilliseconds).toBeGreaterThanOrEqual(DEFAULT_SCRIPT_TIMEOUT_IN_MILLISECONDS);
    expect(elapsedInMilliseconds).toBeLessThan(DEFAULT_SCRIPT_TIMEOUT_IN_MILLISECONDS + CAP_REPORT_TOLERANCE_IN_MILLISECONDS);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // A capped eval must not take the session with it, or every later Android test fails for a reason that
  // Has nothing to do with what it is testing. This is not a formality: the abandoned Execute Script is
  // Still in flight on the wire, and nothing cancels it — `Runtime.terminateExecution` over the
  // Transport's own CDP channel was measured releasing nothing — so the only evidence that abandoning is
  // Safe is this assertion.
  it('should leave the session usable for the next evaluation', async () => {
    const markdownPaths = await evalInObsidian({
      callback({ app }): string[] {
        return app.vault.getMarkdownFiles().map((file) => file.path);
      },
      vaultPath: vault.path
    });

    expect(markdownPaths).toContain('note.md');
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
