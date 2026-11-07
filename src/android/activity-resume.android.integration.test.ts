/**
 * @file
 *
 * Proves an `evalInObsidian` call survives Obsidian's activity being brought back to the front by an intent.
 *
 * A share intent (`android.intent.action.SEND`) resumes the app's activity, and now and then that leaves ChromeDriver
 * holding a WebView window that is gone, so the next command answers `no such window`. `AppiumTransport.evaluate`
 * re-attaches the window and runs the eval again once (AGENTS.md L81), so every eval below must return. The stale
 * window cannot be produced on demand (it was one run in four in a consumer suite), so the suite resumes the
 * activity several times and evaluates straight after each one.
 *
 * Runs in its own Vitest project (`integration-tests:android`) against a real emulator via Appium.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import { runAdbText } from './adb/adb.ts';
import { resolveEmulatorDeviceId } from './avd/resolve-emulator-device-id.ts';

// The same budget the other Android suites carry: emulator boot, Appium session and the network-ready gate (L19).
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 840_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 300_000;

const AVD_NAME = 'obsidian_test';
const RESUME_COUNT = 5;
const SHARED_TEXT = 'activity-resume';

describe('Android activity resume', () => {
  const vault = new TemporaryVault();
  let deviceId = '';

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
    deviceId = await resolveEmulatorDeviceId({ avdName: AVD_NAME });
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  it('should evaluate after a share intent resumes the activity', async () => {
    const vaultNames: string[] = [];

    for (let index = 0; index < RESUME_COUNT; index++) {
      vaultNames.push(
        await evalInObsidian({
          callback: ({ app }): string => app.vault.getName(),
          vaultPath: vault.path
        })
      );

      await runAdbText({
        commandArguments: [
          'shell',
          'am',
          'start',
          '-a',
          'android.intent.action.SEND',
          '-t',
          'text/plain',
          '--es',
          'android.intent.extra.TEXT',
          SHARED_TEXT,
          '-p',
          'md.obsidian'
        ],
        deviceId
      });

      // The eval straight after the resume is the one that met the dead window. It also closes the share menu.
      vaultNames.push(
        await evalInObsidian({
          async callback({ app, lib: { waitUntil } }): Promise<string> {
            await waitUntil({
              message: 'the share menu to open',
              predicate: () => activeDocument.querySelector('.menu') !== null,
              timeoutInMilliseconds: 10_000
            });
            for (const element of activeDocument.querySelectorAll('.menu, .suggestion-bg')) {
              element.remove();
            }
            return app.vault.getName();
          },
          vaultPath: vault.path
        })
      );
    }

    expect(new Set(vaultNames).size).toBe(1);
    expect(vaultNames).toHaveLength(RESUME_COUNT * 2);
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
