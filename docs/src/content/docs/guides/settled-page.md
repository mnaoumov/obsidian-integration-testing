---
title: Waiting for a settled page
description: Wait until a part of the Obsidian window has stopped changing, its fonts are loaded and its images in view are drawn, instead of sleeping before a screenshot or a layout check.
sidebar:
    order: 14
---

`waitForSettledPage` waits until the page has had no DOM change for a quiet window (150 ms), no font is loading, and every image in view has finished loading. Call it before a screenshot or a layout check, in place of a fixed sleep.

```ts
import { captureObsidianScreenshot, waitForSettledPage } from 'obsidian-integration-testing';

await waitForSettledPage({ root: '.modal.my-plugin-modal' });
const png = await captureObsidianScreenshot();
```

- `root` is a CSS selector of the part to watch. By default the whole `<body>` is watched. Pass a root when something elsewhere keeps changing that the shot does not care about, such as a clock in the status bar.
- `quietInMilliseconds` (150) is longer than the 100 ms debounce Obsidian's views and many plugins use for a refresh, so a refresh a change schedules still lands inside the wait.
- `timeoutInMilliseconds` (10000) is the budget. When it runs out, the call throws `PageNotSettledError`, whose message and `reasons` say what was still changing: `the DOM changed 12 ms ago`, `a font is still loading`, `2 images in view have not finished loading`, or that the watch was lost because the window reloaded.

Animations and transitions are not DOM changes, so an endless CSS animation does not keep the page from settling. A broken image counts as loaded. A root that matches nothing fails at once.

Each poll is one short `evalInObsidian`, so the wait is not bound by the per-eval cap and works on Android as well as desktop.

The wait is a port of `settle()` from [obsidian-plugin-dev-kit](https://github.com/Dimagious/obsidian-plugin-dev-kit) (MIT).
