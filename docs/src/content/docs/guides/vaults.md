---
title: Vaults and fixtures
description: Temporary vaults, fixture files written before Obsidian opens, demo-vault seeding, and non-plugin consumers.
sidebar:
    order: 4
---

Every run works against a temporary vault. The global setup creates one for you; `TemporaryVault` lets you
create more, and `populate` puts fixture files in either.

The same `populate` map shape is used everywhere: `path` → file content, a path ending with `/` and empty
content creates an empty folder, and parent directories are created automatically.

## A disposable vault of your own

```ts
import type { TFile } from 'obsidian';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ContextId, evalInObsidian, TemporaryVault } from 'obsidian-integration-testing';

interface Context {
  file: TFile;
}

const vault = new TemporaryVault();

vault.populate({
  'note.md': '# Hello',
  'folder/nested.md': 'nested content'
});

const contextId = new ContextId<Context>();

beforeAll(async () => {
  await vault.register();

  // Resolve the pre-populated file into a TFile and store it in the context
  await evalInObsidian({
    contextId,
    callback: async ({ app, context }) => {
      const file = app.vault.getFileByPath('note.md');
      if (!file) {
        throw new Error('File not found');
      }
      context.file = file;
    },
    vaultPath: vault.path
  });
});

afterAll(async () => {
  await contextId.dispose(vault.path);
  await vault.dispose();
});

it('should read a pre-populated file', async () => {
  const content = await evalInObsidian({
    callback: ({ app }) => app.vault.adapter.read('note.md'),
    vaultPath: vault.path
  });
  expect(content).toBe('# Hello');
});
```

Both `TemporaryVault` and `ContextId` implement `AsyncDisposable`, so `await using` handles cleanup.

## Pre-populate before Obsidian opens

For large fixtures, write the files **before** Obsidian opens the vault, so its startup scan indexes them
in a single pass. Writing thousands of notes *after* open and forcing a re-scan is far slower and less
reliable.

### Vitest

Create your own `globalSetup` module with `createSetup({ populate })` and point the config at it.
`populate` is a thunk, so a large fixture is built lazily, once, in the setup process:

```ts
// integration-global-setup.ts
import { createSetup } from 'obsidian-integration-testing/vitest-global-setup-plugin';

export const { setup, teardown } = createSetup({
  populate: () => ({
    'note.md': '# Hello',
    'folder/nested.md': 'nested content'
  })
});
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./integration-global-setup.ts']
  }
});
```

### Jest

The same `createSetup({ populate })` factory, but Jest needs `globalSetup` and `globalTeardown` to be
separate modules, each with a **default-export** function. Build the pair once in a shared module and
re-export each half as a default:

```ts
// integration-global-setup.ts — shared createSetup pair
import { createSetup } from 'obsidian-integration-testing/jest-global-setup-plugin';

export const { setup, teardown } = createSetup({
  populate: () => ({
    'note.md': '# Hello',
    'folder/nested.md': 'nested content'
  })
});

export default setup;
```

```ts
// integration-global-teardown.ts
import { teardown } from './integration-global-setup.ts';

export default teardown;
```

```ts
// jest.config.ts
export default {
  globalSetup: '<rootDir>/integration-global-setup.ts',
  globalTeardown: '<rootDir>/integration-global-teardown.ts'
};
```

Both files share the same `createSetup` instance through the common module, so `teardown` cleans up
exactly what `setup` created.

### Manual

When wiring `TemporaryVault` yourself, without a framework global setup, call `vault.populate()` before
`vault.register()`, as shown above.

## Seed a plugin's `demo-vault/`

A plugin's committed `demo-vault/` often needs more than the plugin under test — **CodeScript Toolkit**
(`fix-require-modules`) to run its `code-button` blocks, say, or the `demo-vault-helper` bootstrap. Two
pieces make that a one-liner:

- **`enableCommunityPlugins`** — a `createSetup` option listing community-plugin ids to enable **in
  addition to** the plugin under test, after it is enabled. Each id's built files must already be in the
  vault (seed them below). It replaces the hand-rolled `beforeAll` that turned off restricted mode and
  called `enablePlugin(...)` in every demo-vault test.
- **`buildDemoVaultPopulate`** — reads the repo's `demo-vault/` tree, carries over selected `.obsidian/*`
  config (`app.json`, `appearance.json`, `core-plugins.json` by default), and seeds each injected plugin's
  binaries (plus an optional `data.json`), returning a `populate` map.

```ts
// integration-global-setup.ts
import { join } from 'node:path';
import { buildDemoVaultPopulate } from 'obsidian-integration-testing';
import { createSetup } from 'obsidian-integration-testing/vitest-global-setup-plugin';

const CST_ID = 'fix-require-modules';

export const { setup, teardown } = createSetup({
  // Turn on the seeded extra plugins (the plugin under test is enabled automatically).
  enableCommunityPlugins: [CST_ID],
  populate: () =>
    buildDemoVaultPopulate({
      demoVaultPath: join(process.cwd(), 'demo-vault'),
      // CST binaries come from the demo vault's local (gitignored) install; `data` writes its data.json.
      injectPlugins: [{ pluginId: CST_ID, data: { modulesRoot: '_assets' } }]
    })
});
```

`buildDemoVaultPopulate` throws an actionable error if an injected plugin's `main.js` / `manifest.json` is
missing from the demo vault — open `demo-vault/` in Obsidian once so `demo-vault-helper` installs it, then
re-run. `enableCommunityPlugins` also composes with `installPlugin: false`, enabling extras into an
otherwise plugin-less vault.

## Non-plugin consumers

If your project is **not** a plugin — a tool that only needs a registered, empty vault to `evalInObsidian`
against, such as a typings crawler — point `globalSetup` at the **`-no-plugin`** entry point instead of
`-plugin`. It still launches one owned, off-screen Obsidian instance and publishes its endpoint to workers
so each worker attaches to it, but it skips reading `dist/manifest.json`, copying a plugin, writing
`community-plugins.json`, and enabling a plugin. No wrapper module is needed:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['obsidian-integration-testing/vitest-global-setup-no-plugin']
  }
});
```

```ts
// your.integration.test.ts — read the empty registered vault's path
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-no-plugin';
```

For Jest, use `obsidian-integration-testing/jest-global-setup-no-plugin` (`globalSetup`) plus
`obsidian-integration-testing/jest-global-teardown-no-plugin` (`globalTeardown`). If you also need to
pre-populate that empty vault, build the pair yourself with `createSetup({ installPlugin: false, populate })`
from the `-plugin` factory and re-export its `setup` / `teardown`, following the wrapper pattern above.

## Related

- [`TemporaryVault` API reference](/obsidian-integration-testing/api/temporary-vault/TemporaryVault/)
- [`buildDemoVaultPopulate` API reference](/obsidian-integration-testing/api/demo-vault-populate/buildDemoVaultPopulate/)
- [Leftover cleanup](/obsidian-integration-testing/guides/leftover-cleanup/) — what happens to vaults a
  dead run left behind.
