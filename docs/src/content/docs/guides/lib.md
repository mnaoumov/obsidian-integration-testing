---
title: The `lib` bag
description: Share your own helpers with serialized callbacks, write notes that actually reach disk, and open a settings tab that renders.
sidebar:
    order: 3
---

A callback is serialized with `toString()` and **cannot import modules**, so it cannot reach your utility
library directly. Every callback instead receives a `lib` argument: one bag that provider packages
populate with their whole (renderer-safe) library, so closures call shared helpers instead of
hand-rolling them.

`lib` is `{}` until a provider registers a resolver. The harness's own
[trusted-input helpers](/obsidian-integration-testing/guides/user-input/) and the ones below arrive the
same way.

## Register a resolver

A provider registers a **renderer-side resolver** with `registerLibResolver` from its per-worker test
setup (a `setupFiles` entry — the same place the context resolvers are registered). The resolver runs
inside Obsidian and returns an object; every registered resolver's result is merged (`Object.assign`) into
the single `lib` bag, so multiple providers compose.

The resolver is serialized too, so it must be self-contained — for example, read a value a fixture plugin
published on `window`:

```ts
// provider's setup file (registered via setupFiles)
import { registerLibResolver } from 'obsidian-integration-testing';

registerLibResolver(() => window.__myLibraryModule__);
```

Make `lib` type-safe by augmenting the `Lib` interface. Multiple augmentations merge, mirroring the
runtime merge:

```ts
declare module 'obsidian-integration-testing' {
  interface Lib {
    getThing(id: string): Thing;
  }
}

const name = await evalInObsidian({
  callback: ({ lib: { getThing } }) => getThing('a').name
});
```

## `createNote` — a write that is verified to land

**Use `lib.createNote({ content, path })` instead of `app.vault.create` in any suite that may run on
Android.** The emulator transport loses roughly **0.9 %** of `vault.create` writes — measured at 7 lost in
800 creates, over two runs of a 400-create stress harness.

What a lost write looks like, captured at the moment of failure and before any repair:

| Probe                                 | Value                   |
| ------------------------------------- | ----------------------- |
| `adapter.stat(path).size`             | `0`                     |
| `adapter.stat(path).size` + 500 ms    | `0`                     |
| `vault.read(file).length`             | `0`                     |
| `vault.cachedRead(file).length`       | `0`                     |
| `file.stat.size` (Obsidian's `TFile`) | `38` — the full content |

So the write is lost **below** Obsidian: `TFile.stat` says it wrote the content, the filesystem holds zero
bytes, and it does not heal on its own. It is not a trash/recreate race — creating a fresh, never-used
path fails at the same rate as recreating a just-trashed one.

The consequence for a suite is worse than the rate suggests: at ~34 creates per run there is a **~26 %**
chance of at least one lost write, and whichever test loses that lottery is the one that fails — on a
`waitUntil` for content that was never written. It moves between tests run to run, which is exactly why it
reads as a per-test flake rather than one shared cause.

`createNote` creates the note, **reads it back**, and rewrites it through `vault.modify` (which lands
correctly) until the content matches, up to three repairs. Verification is by read-back and never by
`TFile.stat` — `stat` is precisely the field that lies here. If the content still has not landed, it
throws naming the path and both lengths, so a genuinely broken write fails loudly instead of being retried
forever. On a transport that does not lose writes the first read matches and nothing is rewritten, so it
is safe to use everywhere.

```ts
const heading = await evalInObsidian({
  callback: async ({ app, lib: { createNote, waitUntil }, obsidianModule }) => {
    // Guaranteed on disk before the wait below can depend on it.
    const file = await createNote({ content: '# Title\n', path: 'note.md' });
    await app.workspace.getLeaf().openFile(file);
    await waitUntil({
      message: 'the rendered heading did not appear',
      predicate: () => Boolean(document.querySelector('.markdown-preview-view h1'))
    });
    return document.querySelector('.markdown-preview-view h1')?.textContent ?? null;
  }
});
```

Whether `modify` / `process` writes can be lost the same way is **not** measured — only `create` was
stressed — so a content assertion that fails elsewhere may share this cause.

## `openSettingsTab` — a settings tab that actually renders

**Use `lib.openSettingsTab({ tabId })` — never a bare `app.setting.open()` — to put a settings tab on
screen.** `app.setting.open()` on its own does nothing a test can observe: `app.setting.containerEl` is
built at startup and is never in the document, and `open()` does not attach it, so the modal builds into a
detached tree. `open()` returns without throwing and the document you then read, or screenshot, is
untouched. Plugins have concluded from this that the settings tab cannot be captured at all.

It can. The container just has to be appended to `document.body` **before** `open()` — and the order is the
whole trick. Attaching afterwards is too late: whatever the modal rendered on open has already gone into
the detached container, so the modal appears on screen showing the wrong thing while looking entirely
successful. `openSettingsTab` does it in the right order for you, then waits until the requested tab has
genuinely rendered, and resolves to the setting names it drew.

```ts
import { captureObsidianScreenshot, openObsidianSettingsTab } from 'obsidian-integration-testing';

// From the test body — the usual case for a screenshot suite.
const names = await openObsidianSettingsTab({ tabId: 'my-plugin-id' });
expect(names).toContain('Should handle renames');
await captureObsidianScreenshot();

// From inside a callback that also probes the rendered DOM.
const hasToggle = await evalInObsidian({
  callback: async ({ lib: { openSettingsTab } }) => {
    await openSettingsTab({ tabId: 'my-plugin-id' });
    return Boolean(document.querySelector('.setting-item .checkbox-container'));
  }
});
```

`tabId` is **required**, and that is deliberate. Opening the modal without naming a tab renders nothing at
all on a test instance: the modal restores whichever tab the profile last used, and a harness-owned profile
has never opened one — so `activeTab` stays `null` and no row is drawn. An id that matches no tab is
rejected immediately, listing the ids that do exist, rather than spending the whole timeout looking exactly
like the modal-does-not-render symptom. Both core tabs and plugin tabs are searched.

A tab that legitimately draws no `.setting-item-name` rows (Hotkeys, for instance) resolves to an empty
array; the render itself has still been waited for. Close the modal again with `app.setting.close()` — the
attach is idempotent, so the tab can simply be re-opened afterwards.

## Related

- [`registerLibResolver` API reference](/obsidian-integration-testing/api/lib-registry/registerLibResolver/)
- [`Lib` API reference](/obsidian-integration-testing/api/eval-in-obsidian/Lib/)
- [`openObsidianSettingsTab` API reference](/obsidian-integration-testing/api/open-obsidian-settings-tab/openObsidianSettingsTab/)
