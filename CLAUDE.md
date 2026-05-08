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

### Q1: `obsidian eval` returns `Cannot read properties of undefined (reading 'includes')` even when vault is open

**Context**: When running `obsidian eval --allow-focus-steal code=...` with `cwd=f:/dev/ObsidianVaults/Investigate`, the CLI returns exit code 0 with stdout containing `Error: Cannot read properties of undefined (reading 'includes')`. The result file is never written, meaning the script never executes.

**What we verified**:

- Obsidian IS running (process check: yes)
- CLI IS enabled in obsidian.json (yes)
- Vault IS registered (yes)
- Vault IS marked as open: true in obsidian.json
- The Investigate vault window was opened via `obsidian://open` URI

**Root cause**: The error comes from **inside Obsidian's own CLI eval handler**, not from our script. Something in Obsidian's internal code calls `.includes()` on an undefined value when processing the eval command for this vault. Our script's try/catch never executes because the error happens before `module.constructor._load()` runs.

**Options**:

- A: This is an Obsidian CLI bug — report to Obsidian team and work around it
- B: The `--allow-focus-steal` flag may be triggering a code path that has this bug
- C: The vault window may not be fully initialized despite `open: true` in config
- D: There may be a timing issue — the vault window is open but Obsidian's CLI handler hasn't registered it yet

**Auto-selected**: A — this appears to be an Obsidian CLI bug. The library improvements (diagnostics, auto-open) are still valuable.

## L5. Transport configuration

Transport is configured via the framework adapter's config mechanism. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cli' | 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates. Vitest uses `environmentOptions.obsidianTransport`; Jest uses `globalThis.__obsidianIntegrationTesting.transportOptions`. Other frameworks can register a custom resolver via `setTransportOptionsResolver()`.
