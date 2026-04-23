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

Add the global setup to your Vitest config. It expects your built plugin in `dist/dev` or `dist/build` (whichever has a newer `main.js`), with a `manifest.json` at the root of the chosen folder. The setup creates a temporary vault, copies the build into it, and enables the plugin.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['obsidian-integration-testing/obsidian-plugin-vitest-setup'],
  },
});
```

By default this uses the **CLI transport** (requires CLI enabled in Obsidian settings). See [Transport modes](#transport-modes) for alternatives.

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

```ts
import { describe, expect, it } from 'vitest';
import { evalInObsidian } from 'obsidian-integration-testing';
import { getTempVault } from 'obsidian-integration-testing/obsidian-plugin-vitest-setup';

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

> [!WARNING]
>
> **Parallelism:**
>
> The Obsidian CLI does not support executing multiple commands concurrently. If your test runner launches tests in parallel, CLI calls may collide and produce flaky failures. Disable file-level parallelism in your Vitest config:
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

The transport determines how the library communicates with Obsidian. Configure it via `environmentOptions.obsidianTransport` in your vitest project config:

| Type                       | Platform | Mechanism                      |
|----------------------------|----------|--------------------------------|
| `obsidian-cli` (default)   | Desktop  | Obsidian CLI (`obsidian eval`) |
| `obsidian-cdp`             | Desktop  | Chrome DevTools Protocol (CDP) |
| `obsidian-android-appium`  | Mobile   | Appium WebView JS injection    |

#### CLI transport (default)

Shells out to the `obsidian` CLI binary for each eval call. This is the default when no `obsidianTransport` is configured.

**Setup:**

1. [Install the Obsidian CLI](https://obsidian.md/help/cli#Install+Obsidian+CLI)
2. Enable CLI in Obsidian: Settings → General → Developer tools → Enable CLI

No vitest configuration needed — CLI is the default transport.

#### CDP transport

Connects via WebSocket to Obsidian's Chrome DevTools Protocol endpoint. No CLI binary needed, no "CLI enabled" setting required, and lower overhead per eval.

**Setup:**

1. Enable remote debugging in Obsidian: Settings → General → Developer tools → Enable CDP
2. Ensure Node.js 22+ (uses built-in `WebSocket` and `fetch` globals)
3. Configure vitest:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ['obsidian-integration-testing/obsidian-plugin-vitest-setup'],
    environmentOptions: {
      obsidianTransport: { type: 'obsidian-cdp' },
    },
  },
});
```

Optional configuration:

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    host: 'localhost',       // default
    port: 8315,              // default
    commandTimeoutMs: 30000, // default
  },
}
```

> [!NOTE]
>
> If Obsidian is not running, the CDP transport attempts to auto-start it via the `obsidian://open` URI protocol.

#### Android transport

Runs tests against Obsidian Mobile on an Android emulator or real device via Appium WebView injection.

**Setup:**

1. Install [Appium](https://appium.io/) and the [UiAutomator2 driver](https://github.com/appium/appium-uiautomator2-driver):

   ```bash
   npm install -g appium
   appium driver install uiautomator2
   ```

2. Start an Android emulator (via Android Studio) or connect a real device

3. Install Obsidian on the device and grant storage permission:

   ```bash
   adb shell appops set md.obsidian MANAGE_EXTERNAL_STORAGE allow
   ```

4. Start the Appium server:

   ```bash
   appium
   ```

5. Find the device ID:

   ```bash
   adb devices
   ```

6. Configure vitest:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ['obsidian-integration-testing/obsidian-plugin-vitest-setup'],
    environmentOptions: {
      obsidianTransport: {
        type: 'obsidian-android-appium',
        appiumUrl: 'http://localhost:4723',
        deviceId: 'emulator-5554',
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
          name: 'integration-desktop',
          globalSetup: ['obsidian-integration-testing/obsidian-plugin-vitest-setup'],
          include: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration-cdp',
          globalSetup: ['obsidian-integration-testing/obsidian-plugin-vitest-setup'],
          include: ['src/**/*.integration.test.ts'],
          environmentOptions: {
            obsidianTransport: { type: 'obsidian-cdp' },
          },
        },
      },
      {
        test: {
          name: 'integration-android',
          globalSetup: ['obsidian-integration-testing/obsidian-plugin-vitest-setup'],
          include: ['src/**/*.integration.test.ts'],
          environmentOptions: {
            obsidianTransport: {
              type: 'obsidian-android-appium',
              appiumUrl: 'http://localhost:4723',
              deviceId: 'emulator-5554',
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
# All platforms
npx vitest run

# Desktop CLI only
npx vitest run --project integration-desktop

# CDP only
npx vitest run --project integration-cdp

# Android only (requires Appium + emulator running)
npx vitest run --project integration-android
```

## Support

<!-- markdownlint-disable MD033 -->

<a href="https://www.buymeacoffee.com/mnaoumov" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60" width="217"></a>

<!-- markdownlint-enable MD033 -->

## My other Obsidian resources

[See my other Obsidian resources](https://github.com/mnaoumov/obsidian-resources).

## License

© [Michael Naumov](https://github.com/mnaoumov/)
