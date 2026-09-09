/**
 * @file
 *
 * The Android half of the per-eval cap, and the one that actually cost
 * something: an overrun here used to surface as a bare
 * `WebDriverError: script timeout` naming only `AppiumTransport.evaluate`, which
 * reads as a device with no network rather than as a closure that waits too
 * long. A plugin release was held for two days by that reading.
 *
 * Two things this asserts that no unit test can. First, that the
 * `timeouts.script` capability is accepted — before it was sent, the 30s came
 * from WebDriver's own default, and a capability the server quietly ignored
 * would look identical from the outside. Second, that the error WebDriver
 * actually raises is one `isScriptTimeoutError` matches: that predicate reads a
 * message, and a message is precisely the thing that changes under you.
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
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // A script timeout must not take the session with it, or every later Android test fails for a reason
  // That has nothing to do with what it is testing.
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
