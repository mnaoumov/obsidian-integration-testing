---
title: The `lib` bag
description: Share your own helpers with serialized callbacks, and write notes that actually reach disk with `createNote`.
sidebar:
    order: 3
---

A callback is serialized with `toString()` and **cannot import modules**, so it cannot reach your utility
library directly. Every callback instead receives a `lib` argument: one bag that provider packages
populate with their whole (renderer-safe) library, so closures call shared helpers instead of
hand-rolling them.

`lib` is `{}` until a provider registers a resolver. The harness's own
[trusted-input helpers](/obsidian-integration-testing/guides/user-input/) and the two below arrive the
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

## Related

- [`registerLibResolver` API reference](/obsidian-integration-testing/api/lib-registry/registerLibResolver/)
- [`Lib` API reference](/obsidian-integration-testing/api/eval-in-obsidian/Lib/)
