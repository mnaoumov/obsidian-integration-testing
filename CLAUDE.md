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

**9/12 pass**: B1/B2/B3, C1/C2/C3, A1/A2/A3.

Remaining: D suite (D1/D2/D3) fails in `beforeAll`/`afterAll`
hooks due to vault chooser state management complexity.
All D test assertions pass when setup succeeds — the issue
is infrastructure (closing all windows, then restarting
Obsidian for cleanup takes too long or the CLI becomes
unresponsive). D tests passed on attempt 9 and 10 but
`afterAll` cleanup timed out.

Known fixes applied:

- `waitForCliReady` polls before IPC calls after vault destroy
- `closeVaultWindow` uses explicit 10s timeout (no default)
- `setVaultOpenFlag` patches obsidian.json after window destroy
- `startObsidianAndWaitForCli` opens vault via URI for CLI
- Named timeout constants for readability

## Pending Questions

None.

## L5. Transport configuration

Transport is configured via the framework adapter's config mechanism. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cli' | 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates. Vitest uses `environmentOptions.obsidianTransport`; Jest uses `globalThis.__obsidianIntegrationTesting.transportOptions`. Other frameworks can register a custom resolver via `setTransportOptionsResolver()`.
