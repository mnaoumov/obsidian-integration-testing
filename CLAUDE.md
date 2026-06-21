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

None.

## Pending Questions

None.

## L5. Transport configuration

Transport is configured via the framework adapter's config mechanism. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cli' | 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates. Vitest uses `environmentOptions.obsidianTransport`; Jest uses `globalThis.__obsidianIntegrationTesting.transportOptions`. Other frameworks can register a custom resolver via `setTransportOptionsResolver()`.

## L6. Framework parity (Vitest / Jest / Manual)

Every setup capability must reach **all three** consumption paths, never just one:

- **Core (`src/global-setup-core.ts`)** — the framework-agnostic primitive. New setup behavior is implemented here first, exposed via `CoreSetupParams` / `CoreSetupResult`, so the **Manual** path (consumers wiring `TempVault` / the core directly) gets it for free.
- **Vitest adapter (`src/vitest/global-setup.ts`)** — threads the capability through `createSetup(options)` and keeps the plain `setup` / `teardown` exports as the default (`createSetup()`) case.
- **Jest adapter (`src/jest/global-setup.ts`)** — mirrors the Vitest adapter exactly: same `createSetup(options)` factory shape, same `CreateSetupOptions` fields (including thunk-vs-value conventions), same default `setup` / `teardown` exports.

When adding or changing any adapter-facing option, update the core and **both** adapters in the same change. A capability that lands in only one framework is incomplete. Both adapter files are excluded from unit-test coverage (`v8 ignore`) because they are integration-time glue; keep them as thin as possible so the shared logic stays in the core.
