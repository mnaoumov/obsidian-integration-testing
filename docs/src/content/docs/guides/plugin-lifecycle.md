---
title: Plugin lifecycle patterns
description: Test a plugin enabled late, on a fresh install, with a corrupt data.json, for leaks on unload, and against a large generated vault.
sidebar:
    order: 11
---

A setup that installs the plugin and enables it once, at startup, with whatever settings it last saved, never reaches the cases that break plugins in the field. The harness ships one helper for each of them.

## Enabled at startup, or enabled later

A user who installs a plugin turns it on in settings, with the vault already open and its layout ready. A plugin can break on that path and not on a startup load, or the other way round: an `onload` that reads the workspace before `onLayoutReady`, or one that waits for a `layout-ready` event that already fired.

`pluginEnableTiming` on `createSetup` chooses which path the plugin under test takes:

```ts
// vitest.global-setup.late.ts
import { createSetup } from 'obsidian-integration-testing/vitest-global-setup-plugin';

export const { setup, teardown } = createSetup({ pluginEnableTiming: 'after-layout-ready' });
```

The default, `'app-start'`, lists the plugin in `community-plugins.json` before the vault opens. `'after-layout-ready'` leaves it out, and the harness enables it once the layout is ready. To run every suite both ways, define two projects that differ only in the global setup they use. The option is available on the Jest adapter too.

## A fresh install and a corrupt `data.json`

`reloadPlugin` disables the plugin, puts its `data.json` into the state you ask for, and enables it again, with the layout ready:

```ts
import { reloadPlugin } from 'obsidian-integration-testing';

it('loads on a fresh install', async () => {
  const result = await reloadPlugin({ pluginId: 'my-plugin', shouldRemoveDataJson: true });
  expect(result.errorMessage).toBeUndefined();
});

it('survives a corrupt data.json', async () => {
  const result = await reloadPlugin({ dataJsonText: '{ not json', pluginId: 'my-plugin' });
  expect(result.errorMessage).toBeUndefined();
});
```

What Obsidian hands the plugin differs between the two, and both are worth a test:

- A missing `data.json` makes `loadData()` resolve `null`.
- A corrupt one makes `loadData()` resolve `undefined`: Obsidian logs the parse error and returns nothing. A plugin that then calls `saveData()` overwrites the user's file.

`dataJsonText` is written verbatim, so `JSON.stringify(settings)` loads given settings, for example an old settings shape to test a migration.

The result is returned rather than thrown. Obsidian stores the plugin's instance before it calls `onload`, so `isLoaded` stays `true` when `onload` throws: `errorMessage` is the signal for a plugin that failed.

## A leak on unload

`detectPluginUnloadLeak` disables the plugin, forces a garbage collection, and reports whether the plugin's instance survived it:

```ts
import { detectPluginUnloadLeak } from 'obsidian-integration-testing';

it('releases everything on unload', async () => {
  const result = await detectPluginUnloadLeak({ pluginId: 'my-plugin' });
  expect(result.isLeaked).toBe(false);
});
```

The instance is the sentinel. Everything a plugin owns is reachable only through it, so a collected instance means the unload released all of it. A surviving one means something outside the plugin still holds it: a listener registered without `registerEvent`, an interval without `registerInterval`, a patch that was never removed, or the plugin storing itself on a global. The plugin is enabled again afterwards, unless you pass `shouldReenable: false`.

The garbage collection is a CDP command, so this needs a transport that can send one: the desktop transport, and the Android transport over local `adb`.

## A large vault

`generateLargeVault` builds a seeded fixture as a populate map: notes spread over folders, with frontmatter, headings, tags, links between notes and a share of unresolved links. Pass it to `populate`, so Obsidian indexes it in one pass when the vault opens:

```ts
import { generateLargeVault } from 'obsidian-integration-testing';
import { createSetup } from 'obsidian-integration-testing/vitest-global-setup-plugin';

export const { setup, teardown } = createSetup({
  populate: () => generateLargeVault({ noteCount: 20_000, seed: 1 })
});
```

The same `seed` and options always give the same files, so a slow or failing run can be repeated exactly. `folderCount`, `linksPerNote`, `unresolvedLinkRatio`, `tagCount`, `tagsPerNote`, `paragraphsPerNote` and `rootFolder` shape it.
