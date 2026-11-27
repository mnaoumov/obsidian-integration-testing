---
title: Screenshot quality
description: Shoot sharp, reproducible screenshots at a named destination size, with animations held still, a fixed clock, a clean UI, and a refusal when something private is in the frame.
sidebar:
    order: 17
---

`captureObsidianScreenshot` takes a few options for screenshots that are published, such as store listings, READMEs and link previews.

```ts
import { captureObsidianScreenshot, cleanObsidianUi, freezeObsidianTime } from 'obsidian-integration-testing';

const ui = await cleanObsidianUi({ ribbon: true, statusBar: true });
const clock = await freezeObsidianTime({ date: '2026-03-14T09:26:00' });
try {
  const png = await captureObsidianScreenshot({ forbiddenSelectors: ['.notice'], preset: 'listing-desktop' });
} finally {
  await clock.restore();
  await ui.restore();
}
```

## Size and density

- `widthInPixels` and `heightInPixels` set the exact PNG size, and the result is checked. The page is laid out at that size divided by `deviceScaleFactor`, which must give whole CSS pixels.
- `deviceScaleFactor` defaults to `1` with a size, so a sized frame keeps its layout and its bytes. It defaults to `2` without one, so a frame of the window as it is comes out sharp. Under the [mobile layout](/obsidian-integration-testing/guides/mobile-layout/) an unsized capture keeps the layout's own factor.
- `preset` names a destination instead. It cannot be combined with a size or a density.

| Preset | PNG size | Density | Layout |
| --- | --- | --- | --- |
| `readme` | 1000 x 640 | 1 | 1000 x 640 |
| `listing-desktop` | 1200 x 800 | 1 | 1200 x 800 |
| `listing-phone` | 900 x 1600 | 2 | 450 x 800 |
| `social` | 1200 x 630 | 1 | 1200 x 630 |

The size options apply to the desktop transport. The Android transport returns the device's own framebuffer.

## Animations held still

Every capture freezes the page first: CSS transitions are switched off, a running finite animation is jumped to its end, and an endless one, such as a spinner, is paused and played again after the frame is taken. Pass `shouldFreezeAnimations: false` to photograph an animation mid-flight. `freezeAnimations` is exported for a device capture, which has no page channel of its own.

## A fixed clock

`freezeObsidianTime({ date })` fixes `new Date()`, `Date.now()`, `Date()` and `moment()` at one moment, until `restore()`. A `Date` given arguments is built from them as before, and `instanceof Date` still holds for dates made before the freeze. Timers keep running, but code that measures elapsed time with `Date.now()` sees none pass while the clock is frozen.

## A clean UI

`cleanObsidianUi()` hides the ribbon, the status bar, the tab headers, the view header and the inline title, and collapses both sidebars. Pass `false` for a part to keep it. The ribbon, view header and inline title are vault settings, saved at once; the status bar and tab headers are hidden with a stylesheet. `restore()` puts every part back, deleting a setting the vault did not have before.

## Forbidden elements

`forbiddenSelectors` refuses a frame in which a visible element matches one of the selectors, and names the selector. Use it for anything that must never be published, such as a notice showing a real path, or a settings field holding a token. `assertNoForbiddenElements` runs the same check before a device capture.

These options are re-implemented from the demo stills of [obsidian-plugin-dev-kit](https://github.com/Dimagious/obsidian-plugin-dev-kit) (MIT).
