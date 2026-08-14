---
title: Transport modes
description: The owned CDP instance, version pinning, window visibility, attaching to a running Obsidian, and running several platforms from one config.
sidebar:
    order: 5
---

The transport determines how the library talks to Obsidian. Configure it through your runner's transport
options (see [Getting started](/obsidian-integration-testing/guides/getting-started/)).

| Type                      | Platform | Mechanism                                   |
| ------------------------- | -------- | ------------------------------------------- |
| `obsidian-cdp` (default)  | Desktop  | Obsidian `Chrome DevTools Protocol` (`CDP`) |
| `obsidian-android-appium` | Mobile   | Obsidian Android Appium WebView injection   |

This guide covers the desktop `CDP` transport; the mobile one has its own
[Android testing](/obsidian-integration-testing/guides/android/) guide.

## The owned `CDP` instance

By default the library **launches and owns an isolated Obsidian instance** in a temporary
`--user-data-dir` on a free `--remote-debugging-port`, and talks to it over `CDP`. The owned instance
never touches your real Obsidian — config, vault registry, running window and auto-update are all left
alone — and it runs in parallel with your everyday Obsidian.

Nothing needs configuring; the owned `CDP` instance is the default:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin']
  }
});
```

## Pin an Obsidian version

To run against a specific Obsidian version, set `obsidianVersion` and/or `obsidianInstallerVersion`. Each
accepts an explicit `'x.y.z'`, `'public-latest'`, or `'catalyst-latest'`. Downloaded asars and installer
shells are cached under the system temp directory for reuse.

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    // The Obsidian app version (asar). At or above the installed shell version
    // it is applied as a fast asar swap; an older version transparently
    // downloads the matching installer.
    obsidianVersion: '1.8.10'
  }
}
```

- **`obsidianVersion`** pins the app code (asar). When omitted, the owned instance runs the same version
  your installed Obsidian currently runs.
- **`obsidianInstallerVersion`** pins the Electron shell (installer build), downloaded and extracted from
  the matching GitHub release. Windows installers require [7-Zip](https://www.7-zip.org/) on `PATH`.
  Public releases only — catalyst and beta builds have no public installer, so a catalyst version can only
  be pinned at the asar level.

To run the whole suite across the supported range instead of one pinned version, see
[Version matrix](/obsidian-integration-testing/guides/version-matrix/).

### Dead-boot fast-fail

If you pin an app version that cannot run on the launched Electron shell — an `obsidianInstallerVersion`
too old for the `obsidianVersion` — Obsidian loads a black screen: the renderer finishes loading but the
app never bootstraps (empty `<body>`, no `window.app`). Rather than waiting out the full readiness
timeout, the harness detects this terminal state and throws a **`RendererFailedToInitializeError`** as
soon as it has held for a short grace window:

```ts
import { RendererFailedToInitializeError } from 'obsidian-integration-testing';

try {
  // ... register a vault against an incompatible version pair
} catch (error) {
  if (error instanceof RendererFailedToInitializeError) {
    // The installer/Electron version is too old for this Obsidian app version.
  }
}
```

- **`deadBootGraceInMilliseconds`** (default `10000`) — how long the renderer must sit in the dead state
  (document `complete`, empty `<body>`, no `window.app`) before fast-failing. The grace clock starts when
  the renderer first reports `readyState: 'complete'`, so a slow-but-valid boot is never misjudged. Set
  `0` to disable the fast-fail and restore the plain wait-out-the-readiness-timeout behavior. Owned mode
  only; ignored when attaching.

## Window visibility

By default the owned Obsidian window is shown. Integration setup explicitly hides its owned window so test
runs do not steal focus:

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    isObsidianAppVisible: false // hide the window for this run
  }
}
```

- **`isObsidianAppVisible`** (default `true`) — when `false`, the harness launches the owned instance with
  keep-alive Chromium flags and moves its window **off-screen** once Electron's remote bridge is up.
  Off-screen (not minimized) keeps the renderer fully live, so `setTimeout`, `requestAnimationFrame`,
  `:hover` and trusted keyboard/pointer input behave exactly as they would for a visible window — tests
  are unaffected. Set it explicitly to `false` in any automated run that should not show a window. Ignored
  when attaching: the harness never moves your own running Obsidian.

:::note
There is a brief (~1–2 s) flash while the window appears and is then moved off-screen. Obsidian's own
process shows and focuses the window at launch, which the harness cannot prevent from outside. The
persistent focus theft is eliminated, not the initial flash.
:::

## Attach to a running Obsidian

To attach to an already-running Obsidian instead of owning one, launch Obsidian with
`--remote-debugging-port=<port>` and set `port` to that same port. The version-pinning options do not
apply in attach mode.

```powershell
# Windows (PowerShell) — uses Obsidian from PATH (e.g. scoop), falling back to the installer location
$obsidian = (Get-Command Obsidian.exe -ErrorAction SilentlyContinue).Source
if (-not $obsidian) { $obsidian = "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe" }
Start-Process $obsidian -ArgumentList '--remote-debugging-port=8315'
```

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    port: 8315, // must match the --remote-debugging-port Obsidian was launched with

    // default values can be omitted
    host: 'localhost',
    commandTimeoutInMilliseconds: 30000
  }
}
```

## Run several platforms from one config

Vitest projects let the same tests run on both transports:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'integration-tests:desktop-cdp',
          fileParallelism: false,
          globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin'],
          include: ['src/**/*.integration.test.ts'],
          exclude: ['src/**/*.android.integration.test.ts'],
          // default transport, can be omitted
          environmentOptions: {
            obsidianTransport: { type: 'obsidian-cdp' }
          }
        }
      },
      {
        test: {
          name: 'integration-tests:android-appium',
          fileParallelism: false,
          globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin'],
          include: ['src/**/*.android.integration.test.ts'],
          environmentOptions: {
            obsidianTransport: {
              type: 'obsidian-android-appium',
              appiumUrl: 'http://localhost:4723',
              avdName: 'obsidian_test'
            }
          }
        }
      }
    ]
  }
});
```

```bash
# All tests
npx vitest run

# Desktop CDP only
npx vitest run --project integration-tests:desktop-cdp

# Android only (requires Appium + emulator running)
npx vitest run --project integration-tests:android-appium

# All platforms
npx vitest run --project integration-tests:*
```

## Related

- [`ObsidianCdpTransportOptions` API reference](/obsidian-integration-testing/api/transport-options/ObsidianCdpTransportOptions/)
- [`RendererFailedToInitializeError` API reference](/obsidian-integration-testing/api/renderer-failed-to-initialize-error/RendererFailedToInitializeError/)
- [Ad-hoc debugging](/obsidian-integration-testing/guides/debugging/) — the same knobs outside a test run.
