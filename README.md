# obsidian-integration-testing

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/mnaoumov)
[![npm version](https://img.shields.io/npm/v/obsidian-integration-testing)](https://www.npmjs.com/package/obsidian-integration-testing)
[![npm downloads](https://img.shields.io/npm/dm/obsidian-integration-testing)](https://www.npmjs.com/package/obsidian-integration-testing)
[![GitHub release](https://img.shields.io/github/v/release/mnaoumov/obsidian-integration-testing)](https://github.com/mnaoumov/obsidian-integration-testing/releases)
[![Coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/mnaoumov/obsidian-integration-testing)

A set of helpers that simplify integration testing of [Obsidian](https://obsidian.md/) plugins against a running Obsidian instance.

Your tests run inside a **real Obsidian** — the real `App`, the real vault, the real workspace, internal APIs included. By default the harness launches and owns an isolated instance in a temporary `--user-data-dir`, so your own Obsidian (its config, vault registry, open window, auto-update) is never touched. The same test code runs on the desktop app over `CDP` and on Obsidian Mobile over Appium.

## Documentation

Full documentation lives at **[mnaoumov.dev/obsidian-integration-testing](https://mnaoumov.dev/obsidian-integration-testing/)**.

- [Getting started](https://mnaoumov.dev/obsidian-integration-testing/guides/getting-started/) — install, wire up Vitest or Jest, first assertion.
- [Writing tests](https://mnaoumov.dev/obsidian-integration-testing/guides/writing-tests/) — how `evalInObsidian` executes a callback, arguments, results, `ContextId`, internal APIs.
- [Simulating user input](https://mnaoumov.dev/obsidian-integration-testing/guides/user-input/) — trusted keyboard and pointer events, and `waitUntil`.
- [The `lib` bag](https://mnaoumov.dev/obsidian-integration-testing/guides/lib/) — inject your own helpers into callbacks; `createNote`.
- [Vaults and fixtures](https://mnaoumov.dev/obsidian-integration-testing/guides/vaults/) — temporary vaults, pre-populating files, seeding a plugin's `demo-vault/`, non-plugin consumers.
- [Transport modes](https://mnaoumov.dev/obsidian-integration-testing/guides/transports/) — version pinning, window visibility, attaching to a running Obsidian, multi-platform runs.
- [Android testing](https://mnaoumov.dev/obsidian-integration-testing/guides/android/) — Appium setup, AVD provisioning, troubleshooting.
- [Version matrix](https://mnaoumov.dev/obsidian-integration-testing/guides/version-matrix/) — run the suites across the supported Obsidian range.
- [Leftover cleanup](https://mnaoumov.dev/obsidian-integration-testing/guides/leftover-cleanup/) — what a dead run leaks, and how the sweeps handle it.
- [Ad-hoc debugging](https://mnaoumov.dev/obsidian-integration-testing/guides/debugging/) — `connectToCdp` and the CLI.
- [API reference](https://mnaoumov.dev/obsidian-integration-testing/api/) — every exported function, class and type, generated from the TSDoc.

## Installation

```bash
npm install --save-dev obsidian-integration-testing
```

You also need [Obsidian](https://obsidian.md/download) (the desktop app) installed, and [Node.js](https://nodejs.org/) 22+.

## Quick start

The global setup expects your built plugin in `dist/dev` or `dist/build` (whichever has a newer `main.js`), with a `manifest.json` at the root of the chosen folder. The setup creates a temporary vault, copies the build into it, and enables the plugin.

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

### Jest

```ts
// jest.config.ts
export default {
  globalSetup: 'obsidian-integration-testing/jest-global-setup-plugin',
  globalTeardown: 'obsidian-integration-testing/jest-global-teardown-plugin'
};
```

### Write a test

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
});
```

The callback is serialized and executed inside Obsidian, so it must be self-contained, and both its arguments and its return value must be JSON-serializable. See [Writing tests](https://mnaoumov.dev/obsidian-integration-testing/guides/writing-tests/) for the full rules, and [Getting started](https://mnaoumov.dev/obsidian-integration-testing/guides/getting-started/) for the Jest equivalents and the transport options.

## Support

<!-- markdownlint-disable MD033 -->

<a href="https://www.buymeacoffee.com/mnaoumov" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60" width="217"></a>

<!-- markdownlint-enable MD033 -->

## My other Obsidian resources

[See my other Obsidian resources](https://github.com/mnaoumov/obsidian-resources).

## License

© [Michael Naumov](https://github.com/mnaoumov/)
