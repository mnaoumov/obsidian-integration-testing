---
title: Mobile layout on desktop
description: Check a plugin's mobile layout in seconds on the desktop instance, with a phone-sized viewport and Obsidian's own mobile emulation, without an Android emulator.
sidebar:
    order: 16
---

`enableMobileLayout` turns the desktop window into a phone: it pins the viewport to 390 by 844 CSS pixels at twice the pixel density, then turns on Obsidian's own mobile emulation (`app.emulateMobile(true)`), which reloads the window. It resolves once the reloaded window is laid out in the mobile layout. `disableMobileLayout` turns it off again, and `withMobileLayout` does both around a callback.

```ts
import { captureObsidianScreenshot, evalInObsidian, withMobileLayout } from 'obsidian-integration-testing';

const png = await withMobileLayout({
  async callback() {
    await evalInObsidian({
      callback({ app }) {
        app.commands.executeCommandById('my-plugin:open-view');
      }
    });
    return captureObsidianScreenshot();
  }
});
```

- **The viewport** is set before the reload, because Obsidian picks its phone or tablet layout when it loads: below 600 pixels in either dimension it draws `is-phone`, otherwise `is-tablet`. Pass `widthInPixels`, `heightInPixels` and `deviceScaleFactor` for another device. A window already in the mobile layout at the same viewport is not reloaded again; a different viewport reloads it.
- **A screenshot** with no size of its own is the viewport times the pixel ratio: 780 by 1688 for the default phone. A sized capture still works, and the phone viewport is put back after it.
- **The reload** is waited out from Node, one short read per poll, until the new page is laid out. `timeoutInMilliseconds` (60000) is the budget; when it runs out, `MobileLayoutTimeoutError` says what was missing, such as `the body lacks is-mobile` or `the viewport is 1200 pixels wide, not 390`.
- **The flag is kept in the profile's local storage** (`EmulateMobile`), so it applies to every vault window of that Obsidian on its next load. Turn it off with `disableMobileLayout`, or use `withMobileLayout`, which turns it off whether the callback returned or threw. An owned instance's temporary profile is deleted with it; an attached Obsidian or a persistent profile keeps the flag until it is turned off.

## What it does not replace

This is the desktop app drawing its mobile layout, not Obsidian Mobile. `Platform.isMobile` is `true`, but `Platform.isDesktopApp` stays `true` and `Platform.isMobileApp` stays `false`, Node built-ins such as `require('node:fs')` stay available, and the trusted-input helpers keep going through Electron, so `pressKey` and `clickElement` behave as on desktop (a right click is a right click, not a long press). Code that runs only in the mobile app, or depends on what a phone's WebView lacks, still needs the [Android transport](/obsidian-integration-testing/guides/android/).

On Android the layout is already the mobile one, so these functions refuse the Appium transport by name.

The mode is a re-implementation of the `mobile()` helper of [obsidian-plugin-dev-kit](https://github.com/Dimagious/obsidian-plugin-dev-kit) (MIT).
