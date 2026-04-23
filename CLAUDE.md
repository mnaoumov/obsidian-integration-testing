# Project: obsidian-integration-testing

A library that provides helpers for integration testing Obsidian plugins against a running Obsidian instance via the Obsidian CLI.

## L1. Architecture

The package exports three entry points:

| Entry point                                                       | Purpose                                                                 |
|-------------------------------------------------------------------|-------------------------------------------------------------------------|
| `obsidian-integration-testing`                                    | Main — `evalInObsidian`, `ContextId`, `TempVault`, transports, types    |
| `obsidian-integration-testing/obsidian-plugin-vitest-setup`       | Vitest global `setup`/`teardown` + `getTempVaultPath()`                 |
| `obsidian-integration-testing/obsidian-plugin-android-setup`      | Android Appium global `setup`/`teardown` (env-var configured)           |

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

## Current Task

Redesign transport configuration to be vitest-config driven instead of env-var driven. See "Pending Questions" and "Transport Config Redesign Research" below.

## Pending Questions

### Q1: Transport config mechanism — which vitest config approach?

**Context:** Currently transport selection uses env vars (`OBSIDIAN_DESKTOP_TRANSPORT`, `OBSIDIAN_APPIUM_URL`, `OBSIDIAN_APPIUM_DEVICE_ID`). User wants transport config to be vitest-config driven so plugin projects have trivially easy setup.

**Options investigated:**

**A. `environmentOptions`** — Pass transport config as `environmentOptions` in vitest project config. globalSetup reads it from `project.config.environmentOptions`.
- Pro: Standard vitest mechanism, per-project, type-safe via declaration merging.
- Con: Semantically meant for test runtime environments (jsdom etc.), not infrastructure setup.

**B. `provide`** — Use `provide` in vitest project config for static values, globalSetup reads from `project.config.provide` or merges with `getProvidedContext()`.
- Pro: Already used for `tempVaultPath`. Natural fit for passing config to tests.
- Con: `provide` is designed for setup→test flow, not config→setup flow. The config `provide` is static values; globalSetup would read them from config before tests run.

**C. `env`** — Set transport config as vitest project-level `env` values. globalSetup reads from `process.env`.
- Pro: Simple, per-project, already how Android setup works.
- Con: Pollutes process.env, not type-safe, stringly-typed.

**D. Custom vitest environment** — Define `vitest-environment-obsidian-cli`, `vitest-environment-obsidian-cdp`, `vitest-environment-obsidian-android` packages/entry points. Consumer sets `environment: 'obsidian-cli'` and `environmentOptions: { cdpPort: 8315 }`.
- Pro: Cleanest consumer DX, per-project, `environmentOptions` is the standard way to configure environments.
- Con: Environments run per-worker (not once globally), so transport init would happen per-worker instead of once. Would need coordination with globalSetup for one-time vault setup. Environments primarily control the test runtime (globals/DOM), not infrastructure.

**E. Single unified globalSetup** — One globalSetup entry point that reads transport mode from `env` or `environmentOptions` in the project config, and creates the right transport.
- Pro: Simplest consumer API — one globalSetup for all modes, config drives behavior.
- Con: Need to decide which config field carries the transport options.

**Auto-selected: E (unified globalSetup) + C (env for transport config)** — because:
1. globalSetup already receives `TestProject` with access to `project.config.env`
2. `env` is per-project in vitest, so different projects can have different transports
3. The android setup already uses env vars, so this is consistent
4. Consumer DX is simple: set `env` values in vitest project config

### Q2: Should we keep separate globalSetup entry points?

**Options:**
- **A. Single entry point** — `obsidian-integration-testing/obsidian-plugin-vitest-setup` handles all modes based on config.
- **B. Keep separate** — `obsidian-plugin-vitest-setup` (desktop) + `obsidian-plugin-android-setup` (android), with desktop reading `OBSIDIAN_DESKTOP_TRANSPORT` from project env.

**Auto-selected: A** — Single entry point is simpler for consumers. The globalSetup reads transport mode from project-level `env` and creates the right transport.

## Transport Config Redesign Research

### Current Architecture

```
Consumer's vitest.config.ts
  ├─ project "desktop" → globalSetup: obsidian-plugin-vitest-setup
  │   └─ reads process.env.OBSIDIAN_DESKTOP_TRANSPORT (cli|cdp)
  │   └─ creates DesktopCliTransport or DesktopCdpTransport
  │
  └─ project "android" → globalSetup: obsidian-plugin-android-setup
      └─ reads process.env.OBSIDIAN_APPIUM_URL, OBSIDIAN_APPIUM_DEVICE_ID
      └─ creates AppiumTransport via webdriverio remote()
      └─ calls setTransport(), then delegates to base setup
```

### Proposed Architecture

```
Consumer's vitest.config.ts
  ├─ project "desktop-cli"
  │   globalSetup: obsidian-integration-testing/obsidian-plugin-vitest-setup
  │   env: {} (no extra env needed, CLI is default)
  │
  ├─ project "desktop-cdp"
  │   globalSetup: obsidian-integration-testing/obsidian-plugin-vitest-setup
  │   env: { OBSIDIAN_DESKTOP_TRANSPORT: 'cdp' }
  │   # optional: OBSIDIAN_CDP_PORT, OBSIDIAN_CDP_HOST
  │
  └─ project "android"
      globalSetup: obsidian-integration-testing/obsidian-plugin-vitest-setup
      env: {
        OBSIDIAN_APPIUM_URL: 'http://localhost:4723',
        OBSIDIAN_APPIUM_DEVICE_ID: 'emulator-5554'
      }
```

**Key insight:** If `OBSIDIAN_APPIUM_URL` is set, the unified setup creates an Appium transport. If `OBSIDIAN_DESKTOP_TRANSPORT=cdp`, it creates CDP. Otherwise CLI. All from one globalSetup entry point.

### Vitest Config Mechanisms Available

| Mechanism            | Per-project? | Accessible in globalSetup?         | Type-safe? | Best for                           |
|----------------------|--------------|------------------------------------|------------|------------------------------------|
| `env`                | Yes          | Yes (`project.config.env`)         | No         | Transport selection (stringly)     |
| `environmentOptions` | Yes          | Yes (`project.config.envOptions`)  | Partial    | Environment-specific options       |
| `provide`            | Yes          | Yes (static in config)             | Yes        | Passing values from setup to tests |
| `define`             | Yes          | Yes (`project.config.defines`)     | No         | Compile-time constants             |
| `mode`               | Yes          | Yes (`project.config.mode`)        | No         | test vs benchmark (not our use)    |

### TestProject API (available in globalSetup)

- `project.config` — Full `ResolvedConfig` including `env`, `environmentOptions`, `provide`
- `project.provide(key, value)` — Inject values for tests to `inject(key)`
- `project.name` — Project name string
- `project.vitest` — Global Vitest instance
- `project.config.env` — Project-level env vars (merged with root)
