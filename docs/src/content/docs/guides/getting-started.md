---
title: Getting started
description: Install `obsidian-integration-testing`, wire up your test runner, and run your first assertion inside a real Obsidian.
sidebar:
    order: 0
---

`obsidian-integration-testing` runs your tests against a **real, running Obsidian**. There is no mock of
the `App`, the vault or the workspace — the assertions execute inside the Obsidian renderer, so what
passes is what the app actually does.

By default the harness **launches and owns an isolated instance** in a temporary `--user-data-dir`, so
your own Obsidian — its config, its vault registry, its open window, its auto-update — is never touched,
and it can keep running while the suite does.

## Installation

```bash
npm install --save-dev obsidian-integration-testing
```

You also need:

- [Obsidian](https://obsidian.md/download) (the desktop app) installed, so the harness has a shell to
  launch.
- [Node.js](https://nodejs.org/) 22+ — the transport uses the built-in `WebSocket` and `fetch` globals.

## Wire up your runner

The global setup expects your built plugin in `dist/dev` or `dist/build` (whichever has the newer
`main.js`), with a `manifest.json` at the root of the chosen folder. It creates a temporary vault, copies
the build into it, and enables the plugin.

### Vitest

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin']
  }
});
```

To get the Vitest module augmentations (`environmentOptions.obsidianTransport`,
`inject('obsidianTransport')`, `inject('temporaryVaultPath')`), add a side-effect import in your test
setup or config:

```ts
import 'obsidian-integration-testing/vitest/typings';
```

Or add it to `compilerOptions.types` in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["obsidian-integration-testing/vitest/typings"]
  }
}
```

### Jest

```ts
// jest.config.ts
export default {
  globalSetup: 'obsidian-integration-testing/jest-global-setup-plugin',
  globalTeardown: 'obsidian-integration-testing/jest-global-teardown-plugin'
};
```

:::note
Jest requires `globalSetup` and `globalTeardown` to be **separate** entry points, each with a
**default-export** function — that is why setup and teardown are imported from two different subpaths.
:::

To configure transport options with Jest, populate `globalThis.__obsidianIntegrationTesting` before the
global setup runs (in a setup file, or via Jest `globals`):

```ts
globalThis.__obsidianIntegrationTesting = {
  transportOptions: { type: 'obsidian-cdp' }
};
```

After setup, `globalThis.__obsidianIntegrationTesting.temporaryVaultPath` is available in test workers.

:::caution[Run test files serially]
A run shares a single Obsidian instance and one temporary vault. Test files running in parallel race on
both, which surfaces as flakiness that moves between tests. Set `fileParallelism: false` (Vitest) or
`maxWorkers: 1` (Jest).
:::

## Your first test

Everything happens through `evalInObsidian`: you hand it a callback, it runs inside Obsidian, and the
return value comes back to your test.

```ts
import { evalInObsidian } from 'obsidian-integration-testing';

const sum = await evalInObsidian({
  input: { a: 2, b: 3 },
  callback: ({ a, b }) => a + b
});
// sum === 5
```

Every callback receives `app` (the Obsidian `App`) and `obsidianModule` (the whole `obsidian` module):

```ts
const configDir = await evalInObsidian({
  callback: ({ app }) => app.vault.configDir
});

const yaml = await evalInObsidian({
  callback: ({ obsidianModule }) => obsidianModule.stringifyYaml({ key: 'value' })
});
```

## Assert against your plugin

`getTemporaryVault()` returns the vault the global setup created, so tests can point at it:

```ts
import { describe, expect, it } from 'vitest';
import { evalInObsidian } from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';

describe('my-plugin', () => {
  const vault = getTemporaryVault();

  it('should be enabled', async () => {
    const isEnabled = await evalInObsidian({
      input: { pluginId: 'my-plugin' },
      callback: ({ app, pluginId }) => app.plugins.enabledPlugins.has(pluginId),
      vaultPath: vault.path
    });
    expect(isEnabled).toBe(true);
  });

  it('should create a file', async () => {
    await evalInObsidian({
      callback: async ({ app }) => {
        await app.vault.create('test.md', '# Hello');
      },
      vaultPath: vault.path
    });

    const content = await evalInObsidian({
      callback: ({ app }) => app.vault.adapter.read('test.md'),
      vaultPath: vault.path
    });
    expect(content).toBe('# Hello');
  });
});
```

The Jest version is identical apart from the import:
`obsidian-integration-testing/jest-global-setup-plugin`.

`vaultPath` is optional and defaults to `process.cwd()`.

## Where to go next

- [Writing tests](/obsidian-integration-testing/guides/writing-tests/) — what a callback may and may not
  do, passing arguments, keeping state between calls, reaching internal APIs.
- [Vaults and fixtures](/obsidian-integration-testing/guides/vaults/) — temporary vaults, pre-populating
  files before Obsidian opens, seeding a plugin's `demo-vault/`.
- [Transport modes](/obsidian-integration-testing/guides/transports/) — pin an Obsidian version, attach
  to a running instance, hide the window.
- [Android testing](/obsidian-integration-testing/guides/android/) — run the same suites on Obsidian
  Mobile.
