---
title: Failure artifacts
description: A failed integration test leaves a screenshot of the Obsidian window it failed against, and optionally the last frames of a screencast of the test.
sidebar:
    order: 15
---

When a test fails, the harness writes a PNG of the Obsidian window it was driving to `dist/integration-test-failures/`, named after the test file and the test:

```text
dist/integration-test-failures/my-modal.integration.test--my-modal--closes-on-Escape.png
```

The log names the file: `[failure-artifacts] "closes on Escape" failed: wrote screenshot ...`. A test that passes costs nothing.

## Vitest

Nothing to set up: the per-worker `obsidian-integration-testing/vitest-setup`, which an integration project already lists in `setupFiles`, registers the hook for every test.

- The window is the vault the worker registered last and has not disposed, else the shared vault the global setup opened.
- The screenshot uses a transport the worker already has. A test that failed before it ever reached Obsidian gets no screenshot, because making a transport just for the picture would launch Obsidian, or boot an emulator on Android.
- Every step is bounded (20 s) and best-effort. A test that failed because the instance died still reports its own error; the log says what could not be written.

## A screencast of the test

For a failure that a still picture does not explain, keep the last frames of a screencast too. Set the number of frames to keep, in the transport options:

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    failureScreencastFrameCount: 60
  }
}
```

or for one run, without editing a tracked file:

```sh
OBSIDIAN_TEST_FAILURE_SCREENCAST_FRAMES=60 npm run test:integration
```

Each test then runs under a CDP `Page.startScreencast`, and the renderer sends a JPEG of the window at every repaint. Only the most recent frames are kept, and they are written only when the test fails, to `<name>-frames/` as `frame-0001.jpg`, `frame-0002.jpg` and so on, with a `frames.json` giving each frame's paint time and how many frames the renderer sent in all. A window that does not repaint sends no frames, so a short test may have none.

It is off by default because the renderer encodes a frame for every repaint of every test, passing or not. Desktop only: on Android it is skipped with a log line.

## Options

| Option | Environment variable | Default |
| --- | --- | --- |
| `shouldCaptureFailureScreenshot` | `OBSIDIAN_TEST_FAILURE_SCREENSHOT=0` turns it off | `true` |
| `failureScreencastFrameCount` (0 to 600) | `OBSIDIAN_TEST_FAILURE_SCREENCAST_FRAMES` | `0` |
| `failureArtifactsDirectory` | | `dist/integration-test-failures` |

The environment variable wins over the option. Add the directory to `.gitignore` if `dist/` is not already ignored.

## Jest and hand-wired suites

Jest has no per-test failure hook a setup file can register, so call the same functions from your own failure handler:

```ts
import {
  buildFailureArtifactBaseName,
  writeFailureArtifacts
} from 'obsidian-integration-testing';

const result = await writeFailureArtifacts({
  baseName: buildFailureArtifactBaseName({ filePath: __filename, fullTestName: 'my test', retryCount: 0 }),
  outputDirectory: 'dist/integration-test-failures',
  screencast: null,
  shouldCaptureScreenshot: true,
  transport,
  vaultPath
});
```

`startFailureScreencast` starts a recording to pass as `screencast`; stop it with `recording.stop()` when the test ends.

The idea of keeping a picture only for a failed test comes from [obsidian-plugin-dev-kit](https://github.com/Dimagious/obsidian-plugin-dev-kit) (MIT), which keeps a Playwright trace and video. This is a re-implementation over CDP, not a port.
