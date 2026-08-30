---
title: Android testing
description: Run the suites against Obsidian Mobile on an Android emulator or device — setup, AVD provisioning, options, and the failures they cause.
sidebar:
    order: 6
---

The `obsidian-android-appium` transport runs tests against Obsidian Mobile on an Android emulator or a
real device, via Appium WebView injection.

## Setup

1. Install [Android Studio](https://developer.android.com/studio), which includes the Android SDK and the
   `adb` command-line tools.

2. Create an Android Virtual Device (AVD):

   - Device Manager → *Create Virtual Device*.
   - Pick a phone profile (e.g. Pixel 7) and a system image (e.g. API 34).
   - Give it a name (e.g. `obsidian_test`) — that is the value you pass as `avdName`.
   - **Provision it deliberately.** Android Studio's defaults are not enough; see
     [AVD provisioning](#avd-provisioning) and apply it before you start using the device.
   - You do **not** need to start the emulator manually — the harness auto-starts it.

   To list existing AVD names:

   ```bash
   emulator -list-avds
   ```

3. Install [Obsidian](https://obsidian.md/download) on the emulator (Play Store or APK sideload) and grant
   storage permission — either through the app's prompt or over `adb`:

   ```bash
   adb shell appops set md.obsidian MANAGE_EXTERNAL_STORAGE allow
   ```

4. *(Optional)* Install [Appium](https://appium.io/) and the
   [UiAutomator2 driver](https://github.com/appium/appium-uiautomator2-driver):

   ```bash
   npm install -g appium
   appium driver install uiautomator2
   ```

   :::note
   This step is optional. You do not need to start the Appium server manually — the harness auto-starts it
   if it is not already running, and by default it also **auto-installs** Appium (globally) and the
   UiAutomator2 driver when they are missing. Set `shouldAutoInstallAppiumDependencies: false` to manage
   the Appium toolchain yourself and skip the global install.
   :::

5. Configure the runner:

   ```ts
   // vitest.config.ts
   export default defineConfig({
     test: {
       fileParallelism: false,
       globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin'],
       environmentOptions: {
         obsidianTransport: {
           type: 'obsidian-android-appium',
           appiumUrl: 'http://localhost:4723',
           avdName: 'obsidian_test'
         }
       }
     }
   });
   ```

:::note
Plugins with `isDesktopOnly: true` in `manifest.json` automatically reject Android tests.
:::

## AVD provisioning

These are minimums, not suggestions. Following the setup above with Android Studio's defaults produces a
device that fails — and it fails in ways that look like plugin bugs, so the cost of getting this wrong is
paid in debugging, not in an obvious error.

| Setting                   | Minimum | Android Studio's default | Why                                                                     |
| ------------------------- | ------- | ------------------------ | ----------------------------------------------------------------------- |
| `disk.dataPartition.size` | `16G`   | `6G`                     | This is the one that actually bites — see below.                        |
| `hw.ramSize`              | `4096`  | `2048`                   | The WebView has to become ready inside a fixed budget.                  |
| `vm.heapSize`             | `512`   | `256`                    | Obsidian is a large WebView app.                                        |
| `hw.cpu.ncore`            | `4`+    | `4`                      | Raise it if the host has cores to spare; emulator startup is CPU-bound. |

Edit them in Device Manager → *Edit* → *Show Advanced Settings*, or directly in the AVD's `config.ini`
(`~/.android/avd/<name>.avd/config.ini`); a size change needs a wipe of user data.

**Why disk is the setting that matters.** Every failed run leaks a `temp-vault-*` directory, and every
leaked vault stays **registered** for Obsidian to enumerate at startup — inside the same WebView-readiness
budget the run is already straining (see
[Leftover cleanup](/obsidian-integration-testing/guides/leftover-cleanup/)). A full `/data` then produces
failures that look like anything but a full disk:

- `/data` at 92 % with 103 leftover vaults: runs failed in global setup with `WEBVIEW_md.obsidian` timing
  out at the full 60 s. After a sweep the same context was found in **0.3 s**.
- `/data` at 91 % with only **8** leftover vaults — the count alone is not the signal. The four
  disk-bound cases (the only ones creating folders and renaming files) timed out at webdriver's 30 s wall,
  and the same four passed **6/6 in isolation on the same device**.

**Prefer a `google_apis` image over `google_apis_playstore`.** A Play-Store image consumes most of a
default data partition on its own, and it blocks `adb root` (`adbd cannot run as root in production
builds`) — so when `/data` does fill, you cannot inspect it to find out what is using the space.
`pm trim-caches 5G` recovers on the order of tens of megabytes and is the only lever left without root.
`google_apis` is smaller and does allow `adb root`; nothing in this harness needs the Play Store.

**Health check — run this before blaming the plugin:**

```bash
adb shell df -h /data
adb shell ls -d /sdcard/Documents/temp-vault-* | wc -l
```

And apply the isolation rule: **a suite that fails in the aggregate and passes alone is the device**, not
the code.

## Options

Besides the required `appiumUrl` and `avdName`, the transport accepts these optional knobs, all with
sensible defaults:

| Option                                        | Purpose                                                                                                                | Default                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `appId`                                       | App package (Android) or bundle ID (iOS).                                                                              | `'md.obsidian'`        |
| `appiumStartTimeoutInMilliseconds`            | Max wait for the auto-started Appium server to become ready; only when the harness auto-starts it.                     | `180000`               |
| `deviceIdleTimeoutInMilliseconds`             | Max wait after boot for a started emulator to go idle before the session; avoids inflated cold setup. `0` skips.       | `60000`                |
| `isAppiumConsoleVisible`                      | Show the auto-started Appium server console window and live output. Hidden and quiet by default.                       | `false`                |
| `isEmulatorVisible`                           | Show the auto-started emulator window. Hidden (`-no-window`, headless) by default so it never steals focus.            | `false`                |
| `layoutReadyTimeoutInMilliseconds`            | Max wait for `app.workspace.layoutReady` after the vault (re)opens; raise on slow emulators.                           | `90000`                |
| `leftoverMaxAgeInMilliseconds`                | Age gate for the **host** leftover sweep; the device sweep is unconditional.                                           | `7200000`              |
| `sessionConnectionRetryTimeoutInMilliseconds` | Max wait to establish the Appium session (UiAutomator2 install + app launch); the dominant startup cost.               | `180000`               |
| `shouldAutoInstallAppiumDependencies`         | Auto-install missing Appium and the UiAutomator2 driver before auto-starting the server (global `npm install -g`).     | `true`                 |
| `shouldAutoStartAppium`                       | Auto-start the Appium server when it is not already reachable.                                                         | `true`                 |
| `shouldSweepLeftovers`                        | Remove the temp vaults / instance profiles earlier runs leaked.                                                        | `true`                 |
| `vaultBasePath`                               | Base device path where Obsidian stores vaults.                                                                         | `'/sdcard/Documents/'` |
| `webviewTimeoutInMilliseconds`                | Max wait for the WebView context after the Appium session starts.                                                      | `60000`                |

## Troubleshooting

### "Process system isn't responding"

A resource-starved emulator can raise a **"Process system isn't responding"** ANR dialog during boot. If
it appears before Appium attaches, nothing can dismiss it and the run fails intermittently. As soon as the
device reports `sys.boot_completed`, the harness runs
`adb shell settings put global hide_error_dialogs 1` so Android no longer draws crash/ANR dialogs. That
narrows but cannot fully close the race — an ANR that fires between boot completing and that command still
slips through. To eliminate it entirely, boot the AVD once, run the command yourself, save a snapshot, and
always boot from that snapshot. Either way, an ANR signals the emulator is under-provisioned, so check it
against [AVD provisioning](#avd-provisioning) and confirm hardware acceleration (`emulator -accel-check`).

### "Android AVD ... not found" / "Appium server ... exited during startup"

The Android setup fails fast, rather than spinning out a timeout, when the toolchain cannot be brought up
— and names what is missing:

- **`Android AVD "<name>" not found. Available AVDs: ...`** — the `avdName` you passed does not exist. Run
  `emulator -list-avds`, then either point `avdName` at a listed AVD or create the one you want (Android
  Studio Device Manager, or `avdmanager create avd`). AVD creation is not automated: it needs a
  system-image download, license acceptance, and hardware/API-level choices.
- **`Auto-started Appium server ... during startup` / `... did not become ready ...`** — the harness
  auto-started Appium (`npx --no-install appium`) but it exited or never responded; the message appends the
  captured server output. Usually a missing or broken toolchain: pass `isAppiumConsoleVisible: true` to
  watch the live server log, or manage Appium yourself (`shouldAutoStartAppium: false`, with `appiumUrl`
  pointing at your own running server).
- **`Appium was installed ... but is still not resolvable ...`** — the auto-install ran
  `npm install -g appium`, but the npm global bin directory is not on `PATH` (common with scoop- or
  nvm-managed Node). Add it to `PATH` (see `npm config get prefix`), or set
  `shouldAutoInstallAppiumDependencies: false` and install Appium yourself.

### "Integration setup for transport ... failed, so its tests cannot run"

Every test in the project reports this when the project's global setup failed — the device was not
found, Appium never came up, the vault could not be pushed. It is not the defect itself: the cause is
the `Original error:` it quotes, and the setup logged it once, in full, above the first test.

Only that project is affected; other projects in the same run still execute. Nothing in the failed
project runs against Obsidian, which is the point — with no transport published, a worker would
otherwise build the default **desktop** instance and an Android suite would quietly prove itself on
desktop, then fail on an unrelated CDP error naming neither the device nor the setup.

A related message, `No CDP endpoint configured: the owned Obsidian instance has not been launched
yet`, means a worker reached the desktop transport with nothing prepared for it — either that same
failed setup, or an integration project missing `obsidian-integration-testing/vitest-setup` from its
`setupFiles`.

### "Obsidian layout did not become ready"

Registering a vault reloads the page, triggering a full Obsidian re-init — reopen the vault and reload
every plugin, the heaviest startup step. On a cold-booted or under-provisioned emulator that can exceed
the default `90000` ms budget and fail setup with
`Obsidian layout did not become ready within 90000ms`. Run the health check in
[AVD provisioning](#avd-provisioning) first (a full `/data` presents exactly like this), then bring the
AVD up to the minimums there and, if still needed, raise the budget with
`layoutReadyTimeoutInMilliseconds`. It is headroom, not a substitute for adequate provisioning.

## Related

- [`ObsidianAndroidAppiumTransportOptions` API reference](/obsidian-integration-testing/api/transport-options/ObsidianAndroidAppiumTransportOptions/)
- [`AppiumTransport` API reference](/obsidian-integration-testing/api/transport-appium/AppiumTransport/)
- [Leftover cleanup](/obsidian-integration-testing/guides/leftover-cleanup/)
