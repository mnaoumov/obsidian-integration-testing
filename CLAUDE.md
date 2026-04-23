# Project: obsidian-integration-testing

A library that provides helpers for integration testing Obsidian plugins against a running Obsidian instance via the Obsidian CLI.

## L1. Architecture

The package exports three entry points:

| Entry point                                                       | Purpose                                                                 |
|-------------------------------------------------------------------|-------------------------------------------------------------------------|
| `obsidian-integration-testing`                               | Main — `evalInObsidian`, `ContextId`, `TempVault`, transports, types |
| `obsidian-integration-testing/obsidian-plugin-vitest-setup`  | Vitest global `setup`/`teardown` + `getTempVault()`                  |
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

Consumers must have `obsidian`, `type-fest`, and `vitest` installed.

## L5. Transport configuration

Transport is configured via `environmentOptions.obsidianTransport` in vitest project config. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cli' | 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates. No global mutable state — transport options are provided via vitest `inject()`, and each worker caches its own transport instance.
