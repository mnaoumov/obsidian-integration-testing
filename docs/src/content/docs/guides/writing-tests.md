---
title: Writing tests
description: How `evalInObsidian` executes your callback, what may cross the process boundary, and how to keep state between calls.
sidebar:
    order: 1
---

`evalInObsidian` is the whole API surface of a test. Everything else — vaults, transports, version pinning
— exists to put a real Obsidian on the other end of it.

## How a callback actually runs

Your callback does not run in your test process. It is serialized with `toString()`, shipped to Obsidian,
and invoked there as an IIFE. Three consequences follow, and every one of them shows up as a confusing
failure the first time it bites:

- **The callback must be self-contained.** A closure over a local variable in your test file is not
  serialized, so referencing one throws inside Obsidian. Pass values through `input` instead.
- **`import` / `require` are not available inside it.** Reach the Obsidian API through the injected
  `obsidianModule` and `app`; reach your own helpers through the
  [`lib` bag](/obsidian-integration-testing/guides/lib/).
- **Arguments and the return value cross a JSON boundary.** Strings, numbers, booleans, arrays and plain
  objects survive; `TFile`, `Editor`, `Map`, `Set`, DOM nodes and class instances do not. Return
  something serializable — a path, a length, a `textContent` — and keep the live object in a
  [context](#keep-state-between-calls).

## Pass arguments

`input` is merged into the object the callback receives:

```ts
const result = await evalInObsidian({
  input: { pluginId: 'my-plugin' },
  callback: ({ app, pluginId }) => app.plugins.enabledPlugins.has(pluginId)
});
```

Functions in `input` are supported — they are serialized with `toString()` too, under the same
self-contained constraint:

```ts
const result = await evalInObsidian({
  input: {
    transform(x: number): number {
      return x * 2;
    },
    value: 5
  },
  callback: ({ transform, value }) => transform(value)
});
// result === 10
```

## Keep state between calls

Obsidian objects live in the Obsidian process and cannot be returned. `ContextId` gives you a typed store
that persists across calls, so one call can create a `TFile` and the next can use it:

```ts
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ContextId, evalInObsidian } from 'obsidian-integration-testing';

interface Context {
  file: TFile;
}

const contextId = new ContextId<Context>();

beforeEach(async () => {
  await evalInObsidian({
    contextId,
    callback: async ({ app, context }) => {
      context.file = await app.vault.create('test.md', '# Hello');
    }
  });
});

afterEach(async () => {
  await evalInObsidian({
    contextId,
    callback: async ({ app, context: { file } }) => {
      await app.vault.delete(file);
    }
  });
  await contextId.dispose();
});

it('should read the file path', async () => {
  const path = await evalInObsidian({
    contextId,
    callback: ({ context: { file } }) => file.path
  });
  expect(path).toBe('test.md');
});
```

`ContextId` implements `AsyncDisposable`, so `await using` disposes it for you.

## Wait for something to happen

Anything asynchronous inside Obsidian — a view opening, a DOM node appearing, a setting taking effect —
needs polling rather than a fixed sleep. The injected `waitUntil` is that poll; see
[Simulating user input](/obsidian-integration-testing/guides/user-input/#wait-for-an-async-condition).

## Reach internal APIs

Because the callback runs inside a real Obsidian, undocumented internals like `app.plugins`,
`app.commands` and `app.title` are all there. They are simply not declared in `obsidian.d.ts`, so
TypeScript refuses to compile a reference. From best to worst:

1. **Install [`obsidian-typings`](https://www.npmjs.com/package/obsidian-typings)** (recommended). It
   declares the full internal API, and everything compiles with no extra work:

   ```ts
   const title = await evalInObsidian({
     callback: ({ app }) => app.title
   });
   ```

2. **Augment the module yourself**, declaring only what you use:

   ```ts
   declare module 'obsidian' {
     interface App {
       title: string;
     }
   }
   ```

3. **`as any` / `@ts-expect-error`** — works, but switches off the type checking that would have caught a
   genuine mistake in the same expression:

   ```ts
   const title = await evalInObsidian({
     // @ts-expect-error -- accessing internal API
     callback: ({ app }) => app.title
   });
   ```

## Wait longer than one eval may take

A single closure cannot run longer than `CDP`'s ~30 s `Runtime.evaluate` cap, so an operation that takes
minutes — a whole plugin or vault bootstrap — cannot simply be awaited inside one callback.

`pollInObsidian` moves the waiting to the Node side: an optional `start` closure kicks the work off once,
then a short `poll` closure runs repeatedly — each its own well-under-30 s eval — until the Node-side
`until` predicate accepts a poll result or the timeout (default `120000` ms, polled every `500` ms)
elapses. It replaces the hand-rolled `evalInObsidian` + `sleep` loop, and `contextId` lets `start` stash
non-serializable state for `poll` to read.

## Related

- [The `lib` bag](/obsidian-integration-testing/guides/lib/) — inject your own helpers into callbacks.
- [`evalInObsidian` API reference](/obsidian-integration-testing/api/eval-in-obsidian/evalInObsidian/)
- [`ContextId` API reference](/obsidian-integration-testing/api/context-id/ContextId/)
