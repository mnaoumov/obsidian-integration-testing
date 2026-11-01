---
title: Driving Obsidian from an agent
description: Let a coding agent see and drive a real, isolated Obsidian — read its state, click and type with trusted input, and save screenshots.
sidebar:
    order: 10
---

A coding agent working on a plugin's UI has the same problem a test does: it cannot see the vault. Without a way in, every check is a person taking a screenshot and pasting it back. The harness gives an agent the way in a test already has — a real Obsidian it can query, click, type into and photograph — without touching the Obsidian you use yourself.

The shape is two steps: keep an isolated instance open, then let the agent's scripts attach to it.

## 1. Keep an instance open

The bundled CLI launches a harness-owned Obsidian in a temporary `--user-data-dir`, opens a vault, prints the `CDP` port and the vault path, and stays alive until `Ctrl+C`:

```bash
npx obsidian-integration-testing --vault ./demo-vault
```

Leave out `--vault` to get an empty temporary vault, removed on exit; the printed path is the one to attach to. Your own Obsidian, its config and its vault list are never touched, so the agent can open, close and break things freely. Add `--obsidian-version` to look at a specific release, for example the catalyst build a user reported a bug against.

## 2. Attach, look and act

Each agent step is a short script that attaches to the printed port with `connectToCdp({ port })`. Attaching to a vault that is already open adopts its window, and disposing the connection leaves that window open, so the instance survives from one step to the next.

```ts
// scripts/agent-step.ts — run with `npx tsx scripts/agent-step.ts`
import { writeFile } from 'node:fs/promises';
import { connectToCdp } from 'obsidian-integration-testing';

await using conn = await connectToCdp({ port: 9222, vault: 'F:/dev/my-plugin/demo-vault' });

// Read state.
const activeFile = await conn.evalInObsidian({
  callback: ({ app }) => app.workspace.getActiveFile()?.path ?? null
});

// Act with trusted input: the same events a human produces, so focus, `:hover`
// and handlers that check `isTrusted` behave as they do for a user.
await conn.evalInObsidian({
  callback: async ({ lib: { clickElement, waitUntil } }) => {
    const button = document.querySelector('.my-plugin-ribbon-button');
    if (!(button instanceof HTMLElement)) {
      throw new Error('The ribbon button is not rendered.');
    }
    await clickElement({ element: button });
    await waitUntil({
      message: 'the plugin view to open',
      predicate: () => document.querySelector('.my-plugin-view') !== null
    });
  }
});

// Look: save a PNG the agent can read back.
await writeFile('dist/agent-step.png', await conn.captureScreenshot({ heightInPixels: 800, widthInPixels: 1200 }));

console.log({ activeFile });
```

Replace `9222` and the vault path with the two values the CLI printed. Everything a callback can use is listed in [Writing tests](/obsidian-integration-testing/guides/writing-tests/) and [Simulating user input](/obsidian-integration-testing/guides/user-input/): `typeIntoEditor`, `pressKey`, `clickElement`, `hoverElement`, `dragMouse`, `waitUntil`, and your own helpers through [the `lib` bag](/obsidian-integration-testing/guides/lib/).

## When the check is worth keeping

A step the agent got right once is a test waiting to be written. The callback above runs unchanged inside a Vitest or Jest test through `evalInObsidian`, against an instance the global setup launches and tears down for each run — see [Getting started](/obsidian-integration-testing/guides/getting-started/). From there, [Version matrix](/obsidian-integration-testing/guides/version-matrix/) runs the same suite on the latest public and catalyst builds, and [Android testing](/obsidian-integration-testing/guides/android/) runs it on Obsidian Mobile.

## Related

- [Ad-hoc debugging](/obsidian-integration-testing/guides/debugging/) — every `connectToCdp` option and CLI flag.
- [Transport modes](/obsidian-integration-testing/guides/transports/) — version pinning and attaching to a running Obsidian.
