# Project: obsidian-integration-testing

A library that provides helpers for integration testing Obsidian plugins against a running Obsidian instance.

## L1. Architecture

The package exports these entry points:

| Entry point                                        | Purpose                                                                      |
|----------------------------------------------------|------------------------------------------------------------------------------|
| `obsidian-integration-testing`                     | Main — `evalInObsidian`, `ContextId`, `TempVault`, transports, types         |
| `obsidian-integration-testing/vitest-global-setup` | Vitest global `setup`/`teardown` + `getTempVault()`                          |
| `obsidian-integration-testing/vitest/typings`      | Opt-in Vitest module augmentations (`ProvidedContext`, `EnvironmentOptions`) |
| `obsidian-integration-testing/jest-global-setup`   | Jest global `setup`/`teardown` + `getTempVault()`                            |

Framework-agnostic core logic lives in `src/global-setup-core.ts`. Framework adapters (`src/vitest/`, `src/jest/`) are thin wrappers that delegate to the core and bridge context to test workers using framework-native mechanisms (vitest `inject`/`provide`, jest `globalThis`).

Internal modules (`exec`, `function-expression`, `json-with-functions`, `type-guards`) are not re-exported.

## L2. Build

- `npm run build` — clean, type-check, generate `src/index.ts` barrel, build ESM+CJS via esbuild, emit `.d.mts`/`.d.cts` declarations.
- Output lands in `dist/lib/esm/` and `dist/lib/cjs/`.
- `src/index.ts` is the manually maintained barrel file.

## L3. Testing

- Unit tests: `npm run test` (Vitest, `--project unit-tests`).
- Integration tests: `npm run test:integration` (requires a running Obsidian instance with CLI enabled).
- Coverage: `npm run test:coverage` — requires 100% on all metrics.

## L4. Peer dependencies

Consumers must have `obsidian`, `type-fest`, and their test framework (`vitest` or `jest`) installed.

## Current Task

Investigate and fix: `evalInObsidian` returns `non-JSON output: function` when a previous test file left an open markdown note in reading/preview mode containing a rendered plugin code block that runs async JavaScript (specifically via Babel-transformed `import` statement with `shouldAutoRun`).

### Background

Discovered while writing integration tests for `obsidian-codescript-toolkit`. The plugin's code-button feature registers a markdown post-processor for `code-button` code blocks. When a note is opened in preview mode, the post-processor renders the block and (if `shouldAutoRun: true`) executes the code via the plugin's `requireStringAsync`, which internally uses `eval()` and returns a Promise.

### Symptoms

- `evalInObsidian` in test file B fails with `Obsidian returned non-JSON output: function` when test file A previously opened a markdown note containing a code-button block with `shouldAutoRun: true` + `import` statement
- Same-file `evalInObsidian` calls work fine — the bug is ONLY cross-file
- Raw `obsidian eval` CLI calls (via `child_process.exec`) work fine in both same-file and cross-file scenarios
- Detaching markdown leaves (`app.workspace.detachLeavesOfType('markdown')`) in `afterAll` fixes the issue

### What we know

1. The Obsidian CLI `eval` command returns the last line starting with `=>` in stdout
2. Concurrent `obsidian eval` commands CAN interfere — the second command's stdout can include the first command's resolved Promise value (confirmed with `obsidian eval 'code=new Promise(r => setTimeout(() => r("STALE"), 2000))' &` + immediate second eval)
3. But the integration test commands run SEQUENTIALLY (each `evalInObsidian` awaits `exec` before the next one)
4. The raw CLI works fine cross-file — the issue is specific to `evalInObsidian`'s expression wrapping
5. The `evalInObsidian` expression is a large async IIFE that includes `getObsidianModule()`, `serializeError()`, and the user's `fn` — all serialized via `toString()`

### Investigation plan

1. **Understand what `evalInObsidian` generates differently than raw CLI** — The expression wraps `fn` in an async IIFE with helper functions. Something in this wrapping may leave a pending Promise that the next CLI eval picks up. Key suspects:
   - `getObsidianModule()` — creates a temp plugin to extract the `obsidian` module. Uses `app.plugins.loadPlugin`/`uninstallPlugin`. Could leave async state.
   - The wrapping expression itself — does it always `return JSON.stringify(...)` or can it exit a code path that returns a function?

2. **Check if the generated expression produces multiple `=>` lines** — The transport takes the LAST `=>` line. If the expression wrapping produces output that Obsidian CLI formats as multiple `=>` lines, the last one might not be the intended result.

3. **Check if `getObsidianModule()` re-runs between test files** — It caches on `app.obsidianModule`. But if the plugin reload (by the code-button auto-run) clears this cache, `getObsidianModule()` might run again, creating temp plugins that produce side effects.

4. **Add logging to `DesktopCliTransport.evaluate`** — Log the full `resultStr` before parsing `=>` lines. This would show exactly what extra output appears when the bug occurs.

5. **Write a minimal repro without any plugins** — Create a test that:
   - File A: uses `evalInObsidian` to schedule an async operation in Obsidian that resolves to a function value AFTER the eval returns
   - File B: uses `evalInObsidian` with a simple `fn() { return { ok: true }; }`
   - This requires finding the exact mechanism by which the async result leaks into the next eval

### Potential fixes

- **In `DesktopCliTransport.evaluate`**: Use the FIRST `=>` line instead of the last, or match a unique marker in the output
- **In `evalInObsidian`**: Add a unique output marker (e.g., `__obsidianEvalResult_<random>__: <json>`) that the transport matches exactly, instead of relying on `=>` prefix
- **In the generated expression**: Ensure the async IIFE is fully self-contained and can't leak results to subsequent CLI calls

## L5. Transport configuration

Transport is configured via the framework adapter's config mechanism. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cli' | 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates. Vitest uses `environmentOptions.obsidianTransport`; Jest uses `globalThis.__obsidianIntegrationTesting.transportOptions`. Other frameworks can register a custom resolver via `setTransportOptionsResolver()`.
