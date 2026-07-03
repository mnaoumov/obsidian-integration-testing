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
|---------------------------|----------|---------------------------------------------|
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

> [!NOTE]
>
> Plugins with `isDesktopOnly: true` in `manifest.json` automatically reject Android tests.

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
          name: 'integration-tests:desktop-cli',
          fileParallelism: false,
          globalSetup: ['obsidian-integration-testing/vitest-global-setup'],
          include: ['src/**/*.integration.test.ts'],
          exclude: ['src/**/*.android.integration.test.ts'],
          // default, can be omitted
          environmentOptions: {
            obsidianTransport: { type: 'obsidian-cdp' },
          },
        },
      },
      {
        test: {
          name: 'integration-tests:desktop-cdp',
          fileParallelism: false,
          globalSetup: ['obsidian-integration-testing/vitest-global-setup'],
          include: ['src/**/*.integration.test.ts'],
          exclude: ['src/**/*.android.integration.test.ts'],
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

# Desktop CLI only
npx vitest run --project integration-tests:desktop-cli

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
- **`port`** — attach to an already-running Obsidian on this `CDP` port instead of owning an instance (as in [Attaching to a running Obsidian](#attaching-to-a-running-obsidian)).
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
