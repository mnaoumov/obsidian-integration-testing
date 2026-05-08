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

1. ~~Refactor `buildScriptFile` to use serialized functions~~ — done
2. ~~NativeDialogMonitor~~ — done, committed
3. Integration tests for 12 CLI transport scenarios — in progress

### Integration test findings (2026-05-07)

B1/B2/B3 pass. C2/C3/A2/A3 pass. Remaining failures:

- **C1**: `transport.registerVault(targetDir)` timing out at 60s.
  Sometimes `window.require` is not a function after Obsidian
  restarts from a previous test run — the vault window context
  may not be fully initialized. Need to investigate vault
  readiness check before evals.
- **D suite**: `beforeAll` times out at 180s. `closeAllOpenVaults`
  tries to eval in each vault window to destroy it, but evals
  may hang if the window is not ready.
- **A1**: Works when run in isolation. Fails after D's cascading
  failures leave Obsidian in a bad state.
- **State leakage**: leftover `cli-test-*` and `temp-vault-*`
  entries in obsidian.json from failed runs pollute subsequent
  runs. Need a cleanup step at test start.

Next steps:

- Add a global `beforeAll` that cleans up stale temp vault entries
- Investigate why `window.require` is unavailable after Obsidian
  restart (may need `pollVaultReady` before first eval)
- Consider running D and A in a separate test file to avoid
  state leakage from B/C failures

## Pending Questions

None.

## L5. Transport configuration

Transport is configured via the framework adapter's config mechanism. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cli' | 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates. Vitest uses `environmentOptions.obsidianTransport`; Jest uses `globalThis.__obsidianIntegrationTesting.transportOptions`. Other frameworks can register a custom resolver via `setTransportOptionsResolver()`.
