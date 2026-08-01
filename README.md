# obsidian-integration-testing

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/mnaoumov)
[![npm version](https://img.shields.io/npm/v/obsidian-integration-testing)](https://www.npmjs.com/package/obsidian-integration-testing)
[![npm downloads](https://img.shields.io/npm/dm/obsidian-integration-testing)](https://www.npmjs.com/package/obsidian-integration-testing)
[![GitHub release](https://img.shields.io/github/v/release/mnaoumov/obsidian-integration-testing)](https://github.com/mnaoumov/obsidian-integration-testing/releases)
[![Coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/mnaoumov/obsidian-integration-testing)

A set of helpers that simplify integration testing of [Obsidian](https://obsidian.md/) plugins against a running Obsidian instance.

## Installation

```bash
npm install --save-dev obsidian-integration-testing
```

## Quick start

The global setup expects your built plugin in `dist/dev` or `dist/build` (whichever has a newer `main.js`), with a `manifest.json` at the root of the chosen folder. The setup creates a temporary vault, copies the build into it, and enables the plugin.

### Vitest

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin'],
  },
});
```

To get Vitest module augmentations (`environmentOptions.obsidianTransport`, `inject('obsidianTransport')`, `inject('tempVaultPath')`), add a side-effect import in your test setup or config:

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
  globalTeardown: 'obsidian-integration-testing/jest-global-teardown-plugin',
};
```

> [!NOTE]
>
> Jest requires the `globalSetup` and `globalTeardown` modules to be **separate** entry points, each with a **default-export** function — that is why setup and teardown are imported from two different subpaths.

To configure transport options with Jest, populate `globalThis.__obsidianIntegrationTesting` before the global setup runs (e.g., in a setup file or via Jest `globals`):

```ts
globalThis.__obsidianIntegrationTesting = {
  transportOptions: { type: 'obsidian-cdp' },
};
```

After setup, `globalThis.__obsidianIntegrationTesting.tempVaultPath` is available in test workers.

By default this launches a **harness-owned, isolated `CDP` instance** (a temporary Obsidian that never touches your real config). See [Transport modes](#transport-modes) for version pinning, attaching to a running Obsidian, and mobile.

### Write integration tests

Use `evalInObsidian()` to run code inside the Obsidian process. The `vaultPath` is optional — it defaults to `process.cwd()`:

```ts
import { evalInObsidian } from 'obsidian-integration-testing';

// Simple expression
const sum = await evalInObsidian({
  args: { a: 2, b: 3 },
  fn: ({ a, b }) => a + b
});
// sum === 5
```

### Access the Obsidian API

Every callback receives `app` (the Obsidian `App` instance) and `obsidianModule` (the full `obsidian` module):

```ts
// Read the vault config directory
const configDir = await evalInObsidian({
  fn: ({ app }) => app.vault.configDir
});

// Use the obsidian module
const yaml = await evalInObsidian({
  fn: ({ obsidianModule }) => obsidianModule.stringifyYaml({ key: 'value' })
});

// Access internal APIs
const title = await evalInObsidian({
  fn: ({ app }) => app.title
});
```

### Simulate real user input (trusted keyboard & pointer)

The callback's `lib` bag provides helpers that inject **trusted** input at the Chromium level
(via Electron's `webContents.sendInputEvent`) — the kind of event only the browser/OS
normally produces. This matters because the in-page alternatives give false results:
`dispatchEvent(new KeyboardEvent(...))` / `new MouseEvent(...)` are untrusted
(`isTrusted: false`), so CodeMirror ignores the keystroke and `:hover` never takes effect;
`execCommand('insertText')` mutates the selection even when the editor is not focused,
masking focus bugs as false passes. The trusted helpers flow through the real input
pipeline, so text lands **only if the editor genuinely holds focus** and `:hover` rules
genuinely apply.

The element/editor arguments are live renderer DOM nodes — the callback runs in the Obsidian
renderer, so no cross-process serialization is needed.

| Helper                             | Purpose                                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typeIntoEditor({ editor, text })` | Focuses `editor` (caret to end), types `text` as trusted key events, then polls until the document reflects it.                                                                                                                  |
| `pressKey({ key, modifiers })`     | Presses `key` with optional `modifiers` as a trusted `keyDown`→`char`→`keyUp` on the DOM-focused element (fires `keydown`/`keypress`/`beforeinput`/`input`/`keyup`). **Synchronous**; does **not** poll — pair with `waitUntil`. |
| `hoverElement({ element })`        | Moves the pointer to `element`'s center, then polls until `element.matches(':hover')`.                                                                                                                                           |
| `unhoverElement({ element })`      | Moves the pointer just outside `element`'s bounding box, then polls until it no longer matches `:hover`.                                                                                                                         |
| `moveMouse({ x, y })`              | Low-level primitive: injects one trusted pointer move at the given web-contents DIP coordinates. **Synchronous**; does **not** poll.                                                                                             |

```ts
// Type into the active editor — only succeeds if the editor truly holds focus.
const typed = await evalInObsidian({
  fn: async ({ app, lib: { typeIntoEditor }, obsidianModule }) => {
    const view = app.workspace.getActiveViewOfType(obsidianModule.MarkdownView);
    const editor = view?.editor;
    if (!editor) {
      return null;
    }

    await typeIntoEditor({ editor, text: 'Hello, world!' });
    return editor.getValue();
  }
});

// Press special keys / shortcuts (Obsidian `Modifier` names; `'Mod'` = Cmd on macOS, Ctrl elsewhere).
// A key press has no universal effect, so pair it with `waitUntil` to await the outcome.
await evalInObsidian({
  fn: async ({ app, lib: { pressKey, waitUntil }, obsidianModule }) => {
    const editor = app.workspace.getActiveViewOfType(obsidianModule.MarkdownView)?.editor;
    editor?.focus();

    pressKey({ key: 'Enter', modifiers: ['Shift'] }); // synchronous; soft line break
    await waitUntil({ predicate: () => (editor?.getValue().includes('\n') ?? false) });
  }
});

// Observe a genuine :hover state (real theme var() values, real compositing).
await evalInObsidian({
  fn: async ({ lib: { hoverElement, unhoverElement } }) => {
    const bar = document.querySelector<HTMLElement>('.minimized-modal-bar');
    if (!bar) {
      return;
    }

    await hoverElement({ element: bar });
    // ...assert the hovered appearance...
    await unhoverElement({ element: bar });
  }
});
```

> **Serialize focus/pointer-dependent test files.** Trusted input targets the single shared
> window's **global** focus and pointer, so test files that depend on either must not run in
> parallel against the one shared Obsidian instance (they race for focus, and a
> `detachLeavesOfType('markdown')` in one file wipes another's editor). Run your
> obsidian-integration Vitest project serially — `fileParallelism: false` and `maxWorkers: 1`.

### Wait for an async condition (`waitUntil`)

The `lib` bag also provides a `waitUntil({ predicate })` helper for polling until an
asynchronous effect settles (a view opens, a DOM node appears, a setting applies). Because
the callback is serialized via `toString()` and **cannot import modules**, it can't reuse a
library poll helper — `waitUntil` is the shared, injected replacement for the loops you would
otherwise hand-roll in every closure.

The `predicate` may be synchronous or asynchronous (it is `await`ed on each poll). It is
checked immediately, then re-checked every `intervalInMilliseconds` until it returns truthy or
`timeoutInMilliseconds` elapses, at which point the returned promise **rejects** (the error
includes `message` when given).

| Option                   | Purpose                                               | Default |
| ------------------------ | ----------------------------------------------------- | ------- |
| `predicate`              | Condition to poll; sync or async, awaited each check. | —       |
| `intervalInMilliseconds` | Delay between polls.                                  | `50`    |
| `timeoutInMilliseconds`  | Max time to wait before rejecting.                    | `5000`  |
| `message`                | Detail appended to the timeout error message.         | —       |

```ts
// Wait until the plugin has opened a Markdown view, then read its editor.
const value = await evalInObsidian({
  fn: async ({ app, lib: { waitUntil }, obsidianModule }) => {
    await waitUntil({
      message: 'no active Markdown view',
      predicate: () => Boolean(app.workspace.getActiveViewOfType(obsidianModule.MarkdownView))
    });
    return app.workspace.getActiveViewOfType(obsidianModule.MarkdownView)?.editor.getValue() ?? null;
  }
});
```

### Create a note that is actually written (`createNote`)

**Use `lib.createNote({ content, path })` instead of `app.vault.create` in any suite that may run
on Android.** The emulator transport loses roughly **0.9 %** of `vault.create` writes — measured at
7 lost in 800 creates, over two runs of a 400-create stress harness.

What a lost write looks like, captured at the moment of failure and before any repair:

| Probe                                 | Value                     |
| ------------------------------------- | ------------------------- |
| `adapter.stat(path).size`             | `0`                       |
| `adapter.stat(path).size` + 500 ms    | `0`                       |
| `vault.read(file).length`             | `0`                       |
| `vault.cachedRead(file).length`       | `0`                       |
| `file.stat.size` (Obsidian's `TFile`) | `38` — the full content   |

So the write is lost **below** Obsidian: `TFile.stat` says it wrote the content, the filesystem
holds zero bytes, and it does not heal on its own. It is not a trash/recreate race — creating a
fresh never-used path fails at the same rate as recreating a just-trashed one.

The consequence for a suite is worse than the rate suggests: at ~34 creates per run there is a
**~26 %** chance of at least one lost write, and whichever test loses that lottery is the one that
fails — on a `waitUntil` for content that was never written. It moves between tests run to run,
which is exactly why it reads as a per-test flake rather than one shared cause.

`createNote` creates the note, **reads it back**, and rewrites it through `vault.modify` (which
lands correctly) until the content matches, up to three repairs. Verification is by read-back and
never by `TFile.stat` — `stat` is precisely the field that lies here. If the content still has not
landed, it throws naming the path and both lengths, so a genuinely broken write fails loudly
instead of being retried forever. On a transport that does not lose writes the first read matches
and nothing is rewritten, so it is safe to use everywhere.

```ts
const heading = await evalInObsidian({
  fn: async ({ app, lib: { createNote, waitUntil }, obsidianModule }) => {
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

Whether `modify` / `process` writes can be lost the same way is **not** measured — only `create`
was stressed — so a content assertion that fails elsewhere may share this cause.

### Inject a shared library (`lib`)

Because a callback is serialized via `toString()` and **cannot import modules**, it can't reuse
your utility library directly. Every callback receives a `lib` argument — a single bag that
**provider packages populate** with their whole (renderer-safe) library, so closures can call
shared helpers instead of hand-rolling them. `lib` is `{}` until a provider registers a resolver.

A provider registers a **renderer-side resolver** with `registerLibResolver` from its per-worker
test setup (a `setupFiles` entry, the same place the context resolvers are registered). The
resolver runs inside Obsidian and returns an object; every registered resolver's result is merged
(`Object.assign`) into the one `lib` bag, so multiple providers compose. The resolver is
serialized, so it must be self-contained — read a value a fixture plugin published on `window`:

```ts
// provider's setup file (registered via setupFiles)
import { registerLibResolver } from 'obsidian-integration-testing';

registerLibResolver(() => window.__myLibraryModule__);
```

Make `lib` type-safe by augmenting the `Lib` interface (multiple augmentations merge, mirroring
the runtime merge):

```ts
declare module 'obsidian-integration-testing' {
  interface Lib {
    getThing(id: string): Thing;
  }
}

const name = await evalInObsidian({
  fn: ({ lib: { getThing } }) => getThing('a').name
});
```

### Pass complex arguments

Arguments are JSON-serialized. You can even pass functions — they are serialized via `toString()`:

```ts
const result = await evalInObsidian({
  args: {
    transform(x: number): number {
      return x * 2;
    },
    value: 5
  },
  fn: ({ transform, value }) => transform(value)
});
// result === 10
```

### Persist non-serializable values across calls

Obsidian objects like `TFile` or `Editor` live in the Obsidian process and can't be returned to the test. Use `ContextId` to create a typed store that persists across calls:

```ts
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextId, evalInObsidian } from 'obsidian-integration-testing';

interface Context {
  file: TFile;
}

const contextId = new ContextId<Context>();

beforeEach(async () => {
  await evalInObsidian({
    contextId,
    fn: async ({ app, context }) => {
      context.file = await app.vault.create('test.md', '# Hello');
    }
  });
});

afterEach(async () => {
  await evalInObsidian({
    contextId,
    fn: async ({ app, context: { file } }) => {
      await app.vault.delete(file);
    }
  });
  await contextId.dispose();
});

it('should read the file path', async () => {
  const path = await evalInObsidian({
    contextId,
    fn: ({ context: { file } }) => file.path
  });
  expect(path).toBe('test.md');
});
```

### Create a temporary vault

Use `TempVault` to create a disposable vault pre-populated with files:

```ts
import type { TFile } from 'obsidian';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContextId, evalInObsidian, TempVault } from 'obsidian-integration-testing';

interface Context {
  file: TFile;
}

const vault = new TempVault();

vault.populate({
  'note.md': '# Hello',
  'folder/nested.md': 'nested content',
});

const contextId = new ContextId<Context>();

beforeAll(async () => {
  await vault.register();

  // Resolve the pre-populated file into a TFile and store it in the context
  await evalInObsidian({
    contextId,
    fn: async ({ app, context }) => {
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
    fn: ({ app }) => app.vault.adapter.read('note.md'),
    vaultPath: vault.path
  });
  expect(content).toBe('# Hello');
});

it('should access the TFile from context', async () => {
  const path = await evalInObsidian({
    contextId,
    fn: ({ context: { file } }) => file.path,
    vaultPath: vault.path
  });
  expect(path).toBe('note.md');
});
```

Both `TempVault` and `ContextId` implement `AsyncDisposable`, so you can use `await using` for automatic cleanup.

Parent directories are created automatically. To create an empty folder, use a path ending with `/` and an empty string as content.

### Test your plugin

Use `getTempVault()` to get the temporary vault created by the global setup:

**Vitest:**

```ts
import { describe, expect, it } from 'vitest';
import { evalInObsidian } from 'obsidian-integration-testing';
import { getTempVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';

describe('my-plugin', () => {
  const vault = getTempVault();

  it('should be enabled', async () => {
    const isEnabled = await evalInObsidian({
      args: { pluginId: 'my-plugin' },
      fn: ({ app, pluginId }) => app.plugins.enabledPlugins.has(pluginId),
      vaultPath: vault.path
    });
    expect(isEnabled).toBe(true);
  });

  it('should create a file', async () => {
    await evalInObsidian({
      fn: async ({ app }) => {
        await app.vault.create('test.md', '# Hello');
      },
      vaultPath: vault.path
    });

    const content = await evalInObsidian({
      fn: ({ app }) => app.vault.adapter.read('test.md'),
      vaultPath: vault.path
    });
    expect(content).toBe('# Hello');
  });
});
```

**Jest:**

```ts
import { evalInObsidian } from 'obsidian-integration-testing';
import { getTempVault } from 'obsidian-integration-testing/jest-global-setup-plugin';

describe('my-plugin', () => {
  const vault = getTempVault();

  it('should be enabled', async () => {
    const isEnabled = await evalInObsidian({
      args: { pluginId: 'my-plugin' },
      fn: ({ app, pluginId }) => app.plugins.enabledPlugins.has(pluginId),
      vaultPath: vault.path
    });
    expect(isEnabled).toBe(true);
  });
});
```

### Pre-populate the vault before Obsidian opens

For large fixtures, write files into the vault **before** Obsidian opens it, so its startup scan indexes them in a single pass. Writing thousands of notes *after* open and forcing a re-scan is far slower and less reliable. The same `populate` map shape is used everywhere (`path` → file content; a path ending with `/` and empty content creates an empty folder; parent directories are created automatically).

This capability reaches all three consumption paths.

**Vitest** — create your own `globalSetup` module with `createSetup({ populate })` and point the config at it. `populate` is a thunk so large fixtures are built lazily, once, in the setup process:

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

**Jest** — same `createSetup({ populate })` factory, but Jest needs `globalSetup` and `globalTeardown` to be separate modules, each with a **default-export** function. Build the `createSetup` pair once in a shared module and re-export each half as a default:

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

Both files share the same `createSetup` instance (via the common module), so `teardown` cleans up exactly what `setup` created.

**Manual** — when wiring `TempVault` yourself (without a framework global setup), call `vault.populate()` before `vault.register()`, as shown in [Create a temporary vault](#create-a-temporary-vault).

### Seed a plugin's `demo-vault/` and enable extra community plugins

A plugin's committed `demo-vault/` often needs more than the plugin-under-test — e.g. **CodeScript Toolkit** (`fix-require-modules`) to run its `code-button` blocks, or the `demo-vault-helper` bootstrap. Two pieces make this a one-liner:

- **`enableCommunityPlugins`** — a `createSetup` option listing community-plugin ids to enable **in addition to** the plugin-under-test, after it is enabled. Each id's built files must already be in the vault (seed them below). This replaces the hand-rolled `beforeAll` that turned off restricted mode and called `enablePlugin(...)` in every demo-vault test.
- **`buildDemoVaultPopulate`** — reads the repo's `demo-vault/` tree, carries over selected `.obsidian/*` config (`app.json`, `appearance.json`, `core-plugins.json` by default), and seeds each injected plugin's binaries (+ optional `data.json`) — returning a `populate` map. It complements the release-time demo-vault archiving in `obsidian-dev-utils`.

```ts
// integration-global-setup.ts
import { buildDemoVaultPopulate } from 'obsidian-integration-testing';
import { createSetup } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import { getRootFolder } from 'obsidian-dev-utils/script-utils/root';
import { join } from 'node:path';

const CST_ID = 'fix-require-modules';

export const { setup, teardown } = createSetup({
  // Turn on the seeded extra plugins (the plugin-under-test is enabled automatically).
  enableCommunityPlugins: [CST_ID],
  populate: () =>
    buildDemoVaultPopulate({
      demoVaultPath: join(getRootFolder() ?? process.cwd(), 'demo-vault'),
      // CST binaries come from the demo vault's local (gitignored) install; `data` writes its data.json.
      injectPlugins: [{ pluginId: CST_ID, data: { modulesRoot: '_assets' } }]
    })
});
```

`buildDemoVaultPopulate` throws an actionable error if an injected plugin's `main.js`/`manifest.json` is missing from the demo vault — open `demo-vault/` in Obsidian once so `demo-vault-helper` installs it, then re-run. `enableCommunityPlugins` also composes with `installPlugin: false` (enable extras into an otherwise plugin-less vault).

### Non-plugin consumers

If your project is **not** a plugin — a tool that only needs a registered, empty vault to `evalInObsidian` against (e.g. a typings crawler) — point `globalSetup` at the **`-no-plugin`** entry point instead of `-plugin`. It still launches one owned, off-screen Obsidian instance and publishes its endpoint to workers so each worker **attaches** to it, but skips reading `dist/manifest.json`, copying a plugin, writing `community-plugins.json`, and enabling a plugin. No wrapper module needed:

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
import { getTempVault } from 'obsidian-integration-testing/vitest-global-setup-no-plugin';
```

For Jest, use `obsidian-integration-testing/jest-global-setup-no-plugin` (`globalSetup`) + `obsidian-integration-testing/jest-global-teardown-no-plugin` (`globalTeardown`). If you also need to pre-populate the empty vault, build the pair yourself with `createSetup({ installPlugin: false, populate })` from the `-plugin` factory and re-export its `setup`/`teardown` (the same wrapper pattern shown above for `populate`).

> [!WARNING]
>
> **Parallelism:**
>
> A test run shares a single Obsidian instance and one temporary vault. Running test files in parallel makes them race on that shared instance and vault, producing flaky failures. Disable file-level parallelism in your Vitest config:
>
> ```ts
> // vitest.config.ts
> export default defineConfig({
>   test: {
>     fileParallelism: false
>   }
> });
> ```

&nbsp;

> [!WARNING]
>
> **`evalInObsidian` limitations:**
>
> - The function is serialized via `toString()` and executed in a separate process. It must be **self-contained** — closures over local variables will not work.
> - Pass any needed values via `args`. Arguments must be **JSON-serializable** (strings, numbers, booleans, arrays, plain objects). Functions in `args` are supported — they are serialized via `toString()` with the same self-contained constraint.
> - The **return value** must also be JSON-serializable. You cannot return functions, class instances, `Map`, `Set`, DOM elements, or other non-serializable values.
> - Imports (`import`/`require`) are not available inside the function. Use `obsidianModule` to access the `obsidian` API, and `app` to access the Obsidian `App` instance.

### Accessing internal APIs

Since `evalInObsidian` runs inside a real Obsidian process, you have access to internal (undocumented) APIs like `app.plugins`, `app.commands`, `app.title`, etc. However, these are not declared in `obsidian.d.ts`, so TypeScript won't compile references to them. Here are the options to make it work, from best to worst:

**1. Use `obsidian-typings`** (recommended) — install [`obsidian-typings`](https://www.npmjs.com/package/obsidian-typings) which declares the full internal API. Everything compiles with no extra work:

```ts
// With obsidian-typings installed — no casts needed
const title = await evalInObsidian({
  fn: ({ app }) => app.title
});
```

**2. Manual module augmentation** — declare only what you need:

```ts
declare module 'obsidian' {
  interface App {
    title: string;
  }
}

const title = await evalInObsidian({
  fn: ({ app }) => app.title
});
```

**3. `as any` / `@ts-expect-error` / `@ts-ignore`** (not recommended) — suppresses all type checking and hides real errors:

```ts
const title = await evalInObsidian({
  // @ts-expect-error -- accessing internal API
  fn: ({ app }) => app.title
});

// or
const title2 = await evalInObsidian({
  fn: ({ app }) => (app as any).title
});
```

### Transport modes

The transport determines how the library communicates with Obsidian. Configure it via transport options in your test framework's config (see [Quick start](#quick-start)):

| Type                      | Platform | Mechanism                                   |
| ------------------------- | -------- | ------------------------------------------- |
| `obsidian-cdp` (default)  | Desktop  | Obsidian `Chrome DevTools Protocol` (`CDP`) |
| `obsidian-android-appium` | Mobile   | Obsidian Android Appium WebView injection   |

#### `CDP` transport (default)

By default the library **launches and owns an isolated Obsidian instance** in a temporary `--user-data-dir` on a free `--remote-debugging-port`, and communicates with it over the Obsidian `Chrome DevTools Protocol` (`CDP`). The owned instance never touches your real Obsidian — your config, vault registry, running window, and auto-update are all left untouched — and it runs in parallel with your everyday Obsidian.

**Setup:**

1. [Install Obsidian](https://obsidian.md/download) (the desktop app) so a shell is available to launch.
2. Ensure [`Node.js`](https://nodejs.org/) 22+ is installed (uses built-in `WebSocket` and `fetch` globals).
3. No transport configuration is required — the owned `CDP` instance is the default:

   ```ts
   // vitest.config.ts
   export default defineConfig({
     test: {
       fileParallelism: false,
       globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin'],
     },
   });
   ```

##### Pinning an Obsidian version

To run the tests against a specific Obsidian version, set `obsidianVersion` and/or `obsidianInstallerVersion`. Each accepts an explicit `'x.y.z'`, `'public-latest'`, or `'catalyst-latest'`. Downloaded asars and installer shells are cached under the system temp dir for reuse.

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    // The Obsidian app version (asar). At or above the installed shell version
    // it is applied as a fast asar swap; an older version transparently
    // downloads the matching installer.
    obsidianVersion: '1.8.10',
  },
}
```

- **`obsidianVersion`** pins the app code (asar). When omitted, the owned instance runs the same version your installed Obsidian currently runs.
- **`obsidianInstallerVersion`** pins the Electron shell (installer build), downloaded and extracted from the matching GitHub release (Windows installers require [7-Zip](https://www.7-zip.org/) on `PATH`). Public releases only — catalyst/beta builds have no public installer, so a catalyst version can only be pinned at the asar level.

##### Running against every supported version (`runObsidianVersionMatrix`)

Obsidian support is a **range** — `[latest public, latest catalyst]` — and both ends are expected to work. The two ends periodically **coincide**: when public catches up to catalyst, `public-latest` and `catalyst-latest` provision the same build, so running the suites twice re-runs the same build and verifies nothing extra. Worse, a project that runs both still reports "green on public **and** catalyst" — a two-end claim it never actually verified.

`runObsidianVersionMatrix` makes that decision once, in the harness:

```ts
// scripts/test-integration-desktop.ts
import { runObsidianVersionMatrix } from 'obsidian-integration-testing';

await runObsidianVersionMatrix({
  // Defaults to ['public-latest', 'catalyst-latest'].
  // Accepts an array or a comma-separated string, so an env var passes straight through.
  versions: process.env.OBSIDIAN_VERSION,
  run: ({ version }) => {
    const result = spawnSync('npx', ['vitest', 'run', '--project=integration-tests:desktop'], {
      env: { ...process.env, OBSIDIAN_VERSION: version },
      shell: true,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`Exit code ${String(result.status)}`);
    }
  },
});
```

Your test config keeps reading the version the same way it always did — the runner just decides how many times to invoke it:

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    obsidianVersion: process.env.OBSIDIAN_VERSION ?? 'public-latest',
  },
}
```

- **De-duplication is keyed on the *resolved* version, never the specifier string.** `['1.13.4', 'catalyst-latest']` collapses to a single run when catalyst *is* `1.13.4`, exactly as `['public-latest', 'catalyst-latest']` does when the channels converge.
- **The decision is always stated in the log**, so one run where you expected two is never ambiguous:

  ```text
  [version-matrix] public-latest -> 1.13.4
  [version-matrix] catalyst-latest -> 1.13.4
  [version-matrix] 2 requested specifiers resolve to 1 distinct version: 1.13.4 (public-latest, catalyst-latest). Running the suites once.
  [version-matrix] Run 1 of 1: 1.13.4 (public-latest, catalyst-latest)
  ```

- **Every version runs before anything is reported.** A failing end never hides the other: the summary names which concrete versions failed and which passed, and the thrown `AggregateError` carries each underlying failure.

  ```text
  AggregateError: Obsidian version matrix failed on 1 of 2 versions: 1.12.7 (public-latest). Passed: 1.13.4 (catalyst-latest).
  ```

- **Only this runner defaults to both ends.** `obsidianVersion` with no explicit pin still means "whatever your installed Obsidian runs", so `connectToCdp()`, the CLI, and any suite not using the runner are unaffected.
- The runner never launches Obsidian itself — your `run` callback does — so it stays framework-agnostic and works for Vitest, Jest, and manual consumers alike.

##### Dead-boot fast-fail

If you pin an app version that cannot run on the launched Electron shell — an `obsidianInstallerVersion` too old for the `obsidianVersion` — Obsidian loads a black screen: the renderer finishes loading but the app never bootstraps (empty `<body>`, no `window.app`). Rather than waiting out the full readiness timeout, the harness detects this terminal state and throws a **`RendererFailedToInitializeError`** as soon as it has held for a short grace window:

```ts
import { RendererFailedToInitializeError } from 'obsidian-integration-testing';

try {
  // ... register a vault against an incompatible version pair
} catch (error) {
  if (error instanceof RendererFailedToInitializeError) {
    // The installer/Electron version is too old for this Obsidian app version.
  }
}
```

- **`deadBootGraceInMilliseconds`** (default `10000`) — how long the renderer must sit in the dead state (document `complete`, empty `<body>`, no `window.app`) before fast-failing. The grace clock starts when the renderer first reports `readyState: 'complete'`, so a slow-but-valid boot is never misjudged. Set `0` to disable the fast-fail and restore the plain wait-out-the-readiness-timeout behavior. Owned mode only (ignored in attach mode).

##### Window visibility

By default the owned Obsidian window is shown. Integration setup explicitly hides its owned window so test runs do not steal focus. `isObsidianAppVisible` controls this:

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    isObsidianAppVisible: false, // hide the window for this run
  },
}
```

- **`isObsidianAppVisible`** (default `true`) — when `false`, the harness launches the owned instance with keep-alive Chromium flags and moves its window **off-screen** once Electron's remote bridge is up. Off-screen (not minimized) keeps the renderer fully live, so `setTimeout`, `requestAnimationFrame`, `:hover`, and trusted keyboard/pointer input behave exactly as they would for a visible window — tests are unaffected. Integration setup sets this to `false`; set it explicitly to `false` in other automated runs that should not show a window. Ignored in attach mode — the harness never moves your own running Obsidian.

> [!NOTE]
>
> There is a brief (~1–2 s) flash while the window appears and is then moved off-screen: Obsidian's own process shows and focuses the window at launch, which the harness cannot prevent from outside. The persistent focus theft is eliminated, not the initial flash.

##### Attaching to a running Obsidian

To attach to an already-running Obsidian instead of owning one, launch Obsidian with `--remote-debugging-port=<port>` and set `port` to that same port (the version-pinning options do not apply in attach mode):

```powershell
# Windows (PowerShell) — uses Obsidian from PATH (e.g. scoop), falling back to the installer location
$obsidian = (Get-Command Obsidian.exe -ErrorAction SilentlyContinue).Source
if (-not $obsidian) { $obsidian = "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe" }
Start-Process $obsidian -ArgumentList '--remote-debugging-port=8315'
```

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    port: 8315, // must match the --remote-debugging-port Obsidian was launched with

    // default values can be omitted
    host: 'localhost',
    commandTimeoutInMilliseconds: 30000,
  },
}
```

#### Obsidian Android Appium transport

Runs tests against Obsidian Mobile on an Android emulator or real device via Appium WebView injection.

**Setup:**

1. Install [Android Studio](https://developer.android.com/studio), which includes the Android SDK and `adb` command-line tools

2. Create an Android Virtual Device (AVD):

   - Open Android Studio → Device Manager → Create Virtual Device
   - Select a phone profile (e.g. Pixel 7) and a system image (e.g. API 34)
   - Give the AVD a name (e.g. `obsidian_test`) — this is the value you pass as `avdName`
   - **Provision it deliberately — Android Studio's defaults are not enough.** See
     [AVD provisioning](#avd-provisioning) below and set these before you start using the device.
   - You do **not** need to start the emulator manually — the test framework auto-starts it

   To list existing AVD names:

   ```bash
   emulator -list-avds
   ```

   #### AVD provisioning

   These are minimums, not suggestions. Following the steps above with Android Studio's defaults
   produces a device that fails — and it fails in ways that look like plugin bugs, so the cost of
   getting this wrong is paid in debugging, not in an obvious error.

   | Setting                    | Minimum | Android Studio's default | Why                                                                        |
   | -------------------------- | ------- | ------------------------ | -------------------------------------------------------------------------- |
   | `disk.dataPartition.size`  | `16G`   | `6G`                     | This is the one that actually bites — see below.                           |
   | `hw.ramSize`               | `4096`  | `2048`                   | The WebView has to become ready inside a fixed budget.                     |
   | `vm.heapSize`              | `512`   | `256`                    | Obsidian is a large WebView app.                                           |
   | `hw.cpu.ncore`             | `4`+    | `4`                      | Raise it if the host has cores to spare; emulator startup is CPU-bound.    |

   Edit them in Device Manager → *Edit* → *Show Advanced Settings*, or directly in the AVD's
   `config.ini` (`~/.android/avd/<name>.avd/config.ini`); a size change needs a wipe of user data.

   **Why disk is the setting that matters.** Every failed run leaks a `temp-vault-*` directory, and
   every leaked vault stays **registered** for Obsidian to enumerate at startup — inside the same
   WebView-readiness budget the run is already straining (see [Leftover cleanup](#leftover-cleanup)).
   A full `/data` then produces failures that look like anything but a full disk:

   - `/data` at 92 % with 103 leftover vaults: runs failed in global setup with `WEBVIEW_md.obsidian`
     timing out at the full 60 s. After a sweep the same context was found in **0.3 s**.
   - `/data` at 91 % with only **8** leftover vaults — the count alone is not the signal. The four
     disk-bound cases (the only ones creating folders and renaming files) timed out at webdriver's
     30 s wall, and the same four passed **6/6 in isolation on the same device**.

   **Prefer a `google_apis` image over `google_apis_playstore`.** A Play-Store image consumes most of a
   default data partition on its own, and it blocks `adb root` (`adbd cannot run as root in production
   builds`) — so when `/data` does fill, you cannot inspect it to find out what is using the space.
   `pm trim-caches 5G` recovers on the order of tens of megabytes and is the only lever left without
   root. `google_apis` is smaller and does allow `adb root`; nothing in this harness needs the Play
   Store.

   **Health check — run this before blaming the plugin:**

   ```bash
   adb shell df -h /data
   adb shell ls -d /sdcard/Documents/temp-vault-* | wc -l
   ```

   And apply the isolation rule: **a suite that fails in the aggregate and passes alone is the device**,
   not the code.

3. Install [Obsidian](https://obsidian.md/download) on the emulator (via Play Store or APK sideload) and grant storage permission — either via the app's permission prompt or via `adb`:

   ```bash
   adb shell appops set md.obsidian MANAGE_EXTERNAL_STORAGE allow
   ```

4. (Optional) Install [Appium](https://appium.io/) and the [UiAutomator2 driver](https://github.com/appium/appium-uiautomator2-driver):

   ```bash
   npm install -g appium
   appium driver install uiautomator2
   ```

   > [!NOTE]
   >
   > This step is optional. You do not need to start the Appium server manually — the test framework auto-starts it if it is not already running, and by default it also **auto-installs** Appium (globally) and the UiAutomator2 driver when they are missing. Set `shouldAutoInstallAppiumDependencies: false` to manage the Appium toolchain yourself and skip the global install.

5. Configure vitest:

   ```ts
   // vitest.config.ts
   export default defineConfig({
     test: {
       fileParallelism: false,
       globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin'],
       environmentOptions: {
         obsidianTransport: {
           type: 'obsidian-android-appium',
           appiumUrl: 'http://localhost:4723',
           avdName: 'obsidian_test',
         },
       },
     },
   });
   ```

Besides the required `appiumUrl` and `avdName`, the transport accepts these optional knobs (all with sensible defaults):

| Option                                        | Purpose                                                                                                                 | Default                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `appId`                                       | App package (Android) or bundle ID (iOS).                                                                               | `'md.obsidian'`        |
| `appiumStartTimeoutInMilliseconds`            | Max wait for the auto-started Appium server to become ready; only when the harness auto-starts it.                      | `180000`               |
| `deviceIdleTimeoutInMilliseconds`             | Max wait after boot for a started emulator to go idle before the session; avoids inflated cold setup. 0 skips.          | `60000`                |
| `isAppiumConsoleVisible`                      | Show the auto-started Appium server console window and live output. Hidden and quiet by default.                        | `false`                |
| `isEmulatorVisible`                           | Show the auto-started emulator window. Hidden (`-no-window`, headless) by default so it never steals focus.             | `false`                |
| `layoutReadyTimeoutInMilliseconds`            | Max wait for `app.workspace.layoutReady` after the vault (re)opens; raise on slow emulators.                            | `90000`                |
| `leftoverMaxAgeInMilliseconds`                | Age gate for the **host** leftover sweep; the device sweep is unconditional. See [Leftover cleanup](#leftover-cleanup). | `7200000`              |
| `sessionConnectionRetryTimeoutInMilliseconds` | Max wait to establish the Appium session (UiAutomator2 install + app launch); the dominant startup cost.                | `180000`               |
| `shouldAutoInstallAppiumDependencies`         | Auto-install missing Appium + the UiAutomator2 driver before auto-starting the server (global `npm install -g`).        | `true`                 |
| `shouldAutoStartAppium`                       | Auto-start the Appium server when it is not already reachable.                                                          | `true`                 |
| `shouldSweepLeftovers`                        | Remove the temp vaults / instance profiles earlier runs leaked. See [Leftover cleanup](#leftover-cleanup).              | `true`                 |
| `vaultBasePath`                               | Base device path where Obsidian stores vaults.                                                                          | `'/sdcard/Documents/'` |
| `webviewTimeoutInMilliseconds`                | Max wait for the WebView context after the Appium session starts.                                                       | `60000`                |

> [!NOTE]
>
> Plugins with `isDesktopOnly: true` in `manifest.json` automatically reject Android tests.

#### Troubleshooting: "Process system isn't responding"

A resource-starved emulator can raise a **"Process system isn't responding"** ANR dialog during boot.
If it appears before Appium attaches, nothing can dismiss it and the run fails intermittently. As soon
as the device reports `sys.boot_completed`, the harness runs
`adb shell settings put global hide_error_dialogs 1` so Android no longer draws crash/ANR dialogs.
This narrows but cannot fully close the race — an ANR that fires between boot completing and that
command still slips through. To eliminate it entirely, boot the AVD once, run the command yourself,
save a snapshot, and always boot from that snapshot. Either way, an ANR signals the emulator is
under-provisioned, so check it against [AVD provisioning](#avd-provisioning) and confirm hardware
acceleration (`emulator -accel-check`).

#### Troubleshooting: "Android AVD ... not found" / "Appium server ... exited during startup"

The Android setup fails fast (rather than spinning out a timeout) when the toolchain cannot be brought
up, naming what is missing:

- **`Android AVD "<name>" not found. Available AVDs: ...`** — the `avdName` you passed does not exist.
  Run `emulator -list-avds`, then either point `avdName` at a listed AVD or create the one you want
  (Android Studio Device Manager, or `avdmanager create avd`). AVD creation is not automated — it needs a
  system-image download, license acceptance, and hardware/API-level choices.
- **`Auto-started Appium server ... during startup` / `... did not become ready ...`** — the harness
  auto-started Appium (`npx --no-install appium`) but it exited or never responded; the message appends
  the captured server output. Usually a missing/broken toolchain: pass `isAppiumConsoleVisible: true` to
  watch the live server log, or manage Appium yourself (`shouldAutoStartAppium: false`, pointing
  `appiumUrl` at your own running server).
- **`Appium was installed ... but is still not resolvable ...`** — the auto-install ran
  `npm install -g appium`, but the npm global bin dir is not on PATH (common with scoop/nvm-managed Node).
  Add it to PATH (see `npm config get prefix`), or set `shouldAutoInstallAppiumDependencies: false` and
  install Appium yourself.

#### Troubleshooting: "Obsidian layout did not become ready"

Registering a vault reloads the page, triggering a full Obsidian re-init (reopen the vault and
reload every plugin — the heaviest startup step). On a cold-booted or under-provisioned emulator
that can exceed the default `90000`ms budget and fail setup with
`Obsidian layout did not become ready within 90000ms`. Run the health check in
[AVD provisioning](#avd-provisioning) first — a full `/data` presents exactly like this — then bring the
AVD up to the minimums there and, if still needed, raise the budget via
`layoutReadyTimeoutInMilliseconds` in the transport options. It is headroom, not a substitute for
adequate provisioning.

### Leftover cleanup

A run that dies mid-flight cannot clean up after itself. On Android that is the normal case, not the
exception: teardown removes the vault through the WebView, and a dead WebView is exactly what most
failures are (`Vault cleanup error (non-fatal): no such window`). So every failure leaves a
`temp-vault-*` directory behind — and, worse, leaves it **registered**, which is work Obsidian has to
redo at every startup, inside the same WebView-readiness budget the run is already straining. Failures
therefore make the next failure likelier. One real emulator had accumulated **103 leftover vaults**.

Every run now sweeps at **both ends**, and the start sweep is the one that matters, because it runs
before anything that can die:

- **On the device (Android)** — before the Appium session launches Obsidian, every `temp-vault-*`
  directory under `vaultBasePath` is removed over `adb`, and their stale entries are pruned from
  Obsidian Mobile's `localStorage` vault registry when the run registers its own vault. Unregistering
  a vault now removes its device directory over `adb` **whether or not the WebView answered**.
- **On the host** — leftover `temp-vault-*` staging directories and owned `userdata-*` instance
  profiles in the system temp directory are removed.

The two halves gate differently, on purpose:

| Sweep      | Gate                                           | Why                                                                                                                                                      |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device** | Unconditional                                  | Android runs hold an exclusive lock, so no concurrent run can own a device vault — and an age gate would let a vault leaked minutes ago poison a rerun.  |
| **Host**   | Only older than `leftoverMaxAgeInMilliseconds` | Desktop runs are deliberately not serialized, and every project on the machine shares one temp directory, so a young directory may belong to a live run. |

Both knobs are available on either transport:

- **`shouldSweepLeftovers`** (default `true`) — set `false` to disable both sweeps entirely.
- **`leftoverMaxAgeInMilliseconds`** (default `7200000`, i.e. two hours) — the host age gate. Raise it
  if a run of yours can outlive the default; `0` removes every host match regardless of age.

Sweeping is best-effort throughout: a directory another process still holds is skipped, never thrown.

**One directory at a time, and the result is measured.** The device sweep removes each vault with its own
`rm -rf` and then re-lists what is left, so the count it reports is what actually went away rather than
what it asked for. Both halves of that matter, and both come from the same measured failure:

- An Android emulator can end up holding a directory whose name the FUSE layer cannot express — `rm -rf`,
  `find -delete` and force-stopping Obsidian first all answer `Operation not permitted`, and it is
  permanent. Removing the whole set in one command let that single entry decide the fate of every other:
  one device was found carrying **26** leftover vaults that the sweep had been "removing" every run.
  Per-directory, it costs one warning per run instead of the whole sweep.
- A removal that leaves the directory behind is otherwise invisible, because `rm -rf` runs with its exit
  code ignored. A run that passed end to end was still leaking a vault apiece, silently. Anything that
  survives is now named in the log, at both ends — the start-of-run sweep and the teardown — and is
  retried by the next run's sweep.

### Running multiple platforms

Use vitest projects to run the same tests on multiple platforms:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'integration-tests:desktop-cdp',
          fileParallelism: false,
          globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin'],
          include: ['src/**/*.integration.test.ts'],
          exclude: ['src/**/*.android.integration.test.ts'],
          // default transport, can be omitted
          environmentOptions: {
            obsidianTransport: { type: 'obsidian-cdp' },
          },
        },
      },
      {
        test: {
          name: 'integration-tests:android-appium',
          fileParallelism: false,
          globalSetup: ['obsidian-integration-testing/vitest-global-setup-plugin'],
          include: ['src/**/*.android.integration.test.ts'],
          environmentOptions: {
            obsidianTransport: {
              type: 'obsidian-android-appium',
              appiumUrl: 'http://localhost:4723',
              avdName: 'obsidian_test',
            },
          },
        },
      },
    ],
  },
});
```

Run specific platforms:

```bash
# All tests
npx vitest run

# Desktop CDP only
npx vitest run --project integration-tests:desktop-cdp

# Android only (requires Appium + emulator running)
npx vitest run --project integration-tests:android-appium

# All platforms
npx vitest run --project integration-tests:*
```

## Ad-hoc debugging (`connectToCdp` and the CLI)

Outside of a test framework, `connectToCdp()` launches (or attaches to) a `CDP` Obsidian instance, opens a vault, bootstraps the runtime helpers, and returns a disposable connection — handy for reproducing behavior in a real Obsidian from a throwaway script or the REPL.

```ts
import { connectToCdp } from 'obsidian-integration-testing';

// Owns an isolated instance + an empty temp vault (both cleaned up on dispose).
await using conn = await connectToCdp();

console.log(conn.port, conn.cdpUrl); // the free CDP port the instance was launched on

// Raw expression → normalized string result:
await conn.invoke('app.vault.getName()');

// Rich, typed path — `fn` runs in the Obsidian renderer with { app, obsidianModule, typeIntoEditor, context }:
await conn.evalInObsidian({ fn: ({ app }) => app.workspace.getActiveFile()?.path ?? null });
```

`connectToCdp` accepts the same version knobs as the transport (`obsidianVersion`, `obsidianInstallerVersion`, `host`, `commandTimeoutInMilliseconds`, both defaulting to your installed Obsidian), plus:

- **`vault`** — path to an existing vault to open. When omitted, an empty temporary vault is created.
- **`isObsidianAppVisible`** — whether the window is shown (default `true`). Set `false` to launch it off-screen.
- **`port`** — attach to an already-running Obsidian on this `CDP` port instead of owning an instance (as in [Attaching to a running Obsidian](#attaching-to-a-running-obsidian)).
- **`deadBootGraceInMilliseconds`** (default `10000`) — fast-fail with a `RendererFailedToInitializeError` when a pinned version pair produces a [dead boot](#dead-boot-fast-fail); `0` disables it.
- **`shouldRemoveVaultOnDispose`** — whether `dispose()` removes the vault directory. Defaults to `true` for an implicit temp vault and `false` when a `vault` path is given, so a **real vault is never auto-deleted**. Set it explicitly to override.

> [!WARNING]
>
> Opening a **real** vault in the owned instance may write to that vault's `.obsidian` config (normal Obsidian behavior). The vault directory itself is never deleted unless `shouldRemoveVaultOnDispose` is `true`.

### CLI

The package ships an `obsidian-integration-testing` bin that wraps `connectToCdp`, prints the chosen port/URL, and stays alive until `Ctrl+C` — useful when an external tool (raw `CDP` `ws`, DevTools) needs to attach to a printed port:

```bash
npx obsidian-integration-testing --vault F:/path/to/vault --obsidian-version 1.8.10
```

Flags mirror the options above: `--vault`, `--obsidian-version`, `--obsidian-installer-version`, `--port`, `--host`, `--command-timeout`, and `--no-remove-vault` (keep the temp vault on exit).

## Support

<!-- markdownlint-disable MD033 -->

<a href="https://www.buymeacoffee.com/mnaoumov" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60" width="217"></a>

<!-- markdownlint-enable MD033 -->

## My other Obsidian resources

[See my other Obsidian resources](https://github.com/mnaoumov/obsidian-resources).

## License

© [Michael Naumov](https://github.com/mnaoumov/)
