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
    globalSetup: ['obsidian-integration-testing/vitest-global-setup'],
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
  globalSetup: 'obsidian-integration-testing/jest-global-setup',
  globalTeardown: 'obsidian-integration-testing/jest-global-teardown',
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
import { getTempVault } from 'obsidian-integration-testing/vitest-global-setup';

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
import { getTempVault } from 'obsidian-integration-testing/jest-global-setup';

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
import { createSetup } from 'obsidian-integration-testing/vitest-global-setup';

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
import { createSetup } from 'obsidian-integration-testing/jest-global-setup';

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
       globalSetup: ['obsidian-integration-testing/vitest-global-setup'],
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

By default the owned Obsidian window is **hidden** — it never steals focus or pops in front of your other apps. `isObsidianAppVisible` controls this:

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    isObsidianAppVisible: true, // show the window (default: false)
  },
}
```

- **`isObsidianAppVisible`** (default `false`) — when hidden, the harness launches the owned instance with keep-alive Chromium flags and moves its window **off-screen** once Electron's remote bridge is up. Off-screen (not minimized) keeps the renderer fully live, so `setTimeout`, `requestAnimationFrame`, `:hover`, and trusted keyboard/pointer input behave exactly as they would for a visible window — tests are unaffected. Set `true` to watch the window (e.g. when debugging). Ignored in attach mode — the harness never moves your own running Obsidian.

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
   - You do **not** need to start the emulator manually — the test framework auto-starts it

   To list existing AVD names:

   ```bash
   emulator -list-avds
   ```

3. Install [Obsidian](https://obsidian.md/download) on the emulator (via Play Store or APK sideload) and grant storage permission — either via the app's permission prompt or via `adb`:

   ```bash
   adb shell appops set md.obsidian MANAGE_EXTERNAL_STORAGE allow
   ```

4. Install [Appium](https://appium.io/) and the [UiAutomator2 driver](https://github.com/appium/appium-uiautomator2-driver):

   ```bash
   npm install -g appium
   appium driver install uiautomator2
   ```

   > [!NOTE]
   >
   > You do not need to start the Appium server manually — the test framework auto-starts it if it is not already running.

5. Configure vitest:

   ```ts
   // vitest.config.ts
   export default defineConfig({
     test: {
       fileParallelism: false,
       globalSetup: ['obsidian-integration-testing/vitest-global-setup'],
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

| Option                                        | Purpose                                                                                                         | Default                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `appId`                                       | App package (Android) or bundle ID (iOS).                                                                       | `'md.obsidian'`        |
| `appiumStartTimeoutInMilliseconds`            | Max wait for the auto-started Appium server to become ready; only when the harness auto-starts it.              | `180000`               |
| `deviceIdleTimeoutInMilliseconds`             | Max wait after boot for a started emulator to go idle before the session; avoids inflated cold setup. 0 skips.  | `60000`                |
| `isAppiumConsoleVisible`                      | Show the auto-started Appium server console window. Hidden (`windowsHide`) by default so it never steals focus. | `false`                |
| `isEmulatorVisible`                           | Show the auto-started emulator window. Hidden (`-no-window`, headless) by default so it never steals focus.     | `false`                |
| `layoutReadyTimeoutInMilliseconds`            | Max wait for `app.workspace.layoutReady` after the vault (re)opens; raise on slow emulators.                    | `90000`                |
| `sessionConnectionRetryTimeoutInMilliseconds` | Max wait to establish the Appium session (UiAutomator2 install + app launch); the dominant startup cost.        | `180000`               |
| `shouldAutoStartAppium`                       | Auto-start the Appium server when it is not already reachable.                                                  | `true`                 |
| `vaultBasePath`                               | Base device path where Obsidian stores vaults.                                                                  | `'/sdcard/Documents/'` |
| `webviewTimeoutInMilliseconds`                | Max wait for the WebView context after the Appium session starts.                                               | `60000`                |

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
under-provisioned, so also give the AVD more vCPUs/RAM and confirm hardware acceleration
(`emulator -accel-check`).

#### Troubleshooting: "Obsidian layout did not become ready"

Registering a vault reloads the page, triggering a full Obsidian re-init (reopen the vault and
reload every plugin — the heaviest startup step). On a cold-booted or under-provisioned emulator
that can exceed the default `90000`ms budget and fail setup with
`Obsidian layout did not become ready within 90000ms`. Give the AVD more resources (see above) and,
if needed, raise the budget via `layoutReadyTimeoutInMilliseconds` in the transport options. It is
headroom, not a substitute for adequate provisioning.

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
          globalSetup: ['obsidian-integration-testing/vitest-global-setup'],
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
          globalSetup: ['obsidian-integration-testing/vitest-global-setup'],
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
- **`isObsidianAppVisible`** — whether the window is shown. Unlike the test transport (hidden by default), `connectToCdp` **defaults to `true`** since it is meant for watching/debugging a real Obsidian. Set `false` to launch it off-screen.
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
