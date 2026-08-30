/**
 * @file
 *
 * Per-worker setup for the `integration-tests:android-trusted-input` project: points the harness at the
 * Android/Appium transport.
 *
 * `src/vitest/setup.ts` cannot be reused here — it reads the options a `globalSetup` published via
 * `provide`, and this project deliberately has no global setup (each test owns its own
 * {@link TemporaryVault}). Without a registered resolver `getTransportOptions()` returns `undefined` and the
 * harness silently falls back to the **desktop** owned-CDP default, which is exactly the failure this file
 * exists to prevent: the suite would pass on desktop while claiming to prove something about Android.
 */
/* v8 ignore start -- Integration-time setup covered by the Android integration suite, not unit tests. */

import type { ObsidianAndroidAppiumTransportOptions } from '../src/transport-options.ts';

import { setTransportOptionsResolver } from '../src/context-provider.ts';

const ANDROID_TRANSPORT_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

setTransportOptionsResolver(() => ANDROID_TRANSPORT_OPTIONS);

/* v8 ignore stop */
