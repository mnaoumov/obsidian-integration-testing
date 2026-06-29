# Project: obsidian-integration-testing

A library that provides helpers for integration testing Obsidian plugins against an Obsidian instance. On desktop it launches and owns an isolated Obsidian instance by default (it can also attach to a running one); on Android it drives Obsidian Mobile via Appium.

## L1. Architecture

The package exports these entry points:

| Entry point                                         | Purpose                                                                      |
|-----------------------------------------------------|------------------------------------------------------------------------------|
| `obsidian-integration-testing`                      | Main — `evalInObsidian`, `ContextId`, `TempVault`, transports, types         |
| `obsidian-integration-testing/vitest-global-setup`  | Vitest global `setup`/`teardown` + `getTempVault()`                          |
| `obsidian-integration-testing/vitest-setup`         | Vitest **per-worker** `setupFiles` entry — registers the context resolvers   |
| `obsidian-integration-testing/vitest/typings`       | Opt-in Vitest module augmentations (`ProvidedContext`, `EnvironmentOptions`) |
| `obsidian-integration-testing/jest-global-setup`    | Jest global setup (default + named `setup`/`teardown`) + `getTempVault()`    |
| `obsidian-integration-testing/jest-global-teardown` | Jest global teardown (default export) — separate module Jest requires        |
| `obsidian-integration-testing/jest-setup`           | Jest **per-worker** `setupFiles` entry — registers the context resolvers     |

Framework-agnostic core logic lives in `src/global-setup-core.ts`. Framework adapters (`src/vitest/`, `src/jest/`) are thin wrappers that delegate to the core and bridge context to test workers using framework-native mechanisms (vitest `inject`/`provide`, jest `globalThis`).

Internal modules (`exec`, `function-expression`, `json-with-functions`, `type-guards`, `obsidian-config`, `obsidian-version`, `obsidian-version-switch`, `obsidian-installer`, `obsidian-instance`, `kill-process-tree`) are not re-exported.

The desktop owned-instance lifecycle lives in `transport-desktop-cdp.ts` (mode: own vs. attach), with `obsidian-instance.ts` (launch + free port + kill), `obsidian-version*.ts` (asar version resolution/download/cache), and `obsidian-installer.ts` (shell version detect/download/extract). `transport-factory.ts` resolves the owned-instance config (shell exe + asar + temp user-data dir) from the version knobs.

## L2. Build

- `npm run build` — clean, type-check, generate `src/index.ts` barrel, build ESM+CJS via esbuild, emit `.d.mts`/`.d.cts` declarations.
- Output lands in `dist/lib/esm/` and `dist/lib/cjs/`.
- `src/index.ts` is the manually maintained barrel file.

## L3. Testing

- Unit tests: `npm run test` (Vitest, `--project unit-tests`).
- Integration tests: `npm run test:integration` (desktop requires Obsidian installed — the harness launches its own isolated instance; no CLI or running instance needed). Runs two projects: `integration-tests` (each suite registers its vault in-worker) and `integration-tests:owned-attach` (the L9 regression suite: the global setup owns the instance and the worker **attaches** — its own `globalSetup` writes a fixture plugin into `dist/dev` and wires `vitest-setup` into `setupFiles`).
- Coverage: `npm run test:coverage` — requires 100% on all metrics.

## L4. Peer dependencies

Consumers must have `obsidian`, `type-fest`, and their test framework (`vitest` or `jest`) installed.

## Current Task

**Hermetic, version-pinned desktop testing — implementation complete on branch
`feat/hermetic-version-pinned-instance`** (owned isolated CDP instance is the new default; CLI
retired; `obsidianVersion`/`obsidianInstallerVersion` pinning with caching). Full gate green;
validated end-to-end on Windows (owned default, asar upgrade pin, installer downgrade pin). PENDING
(user-owned): a **major (`5.0.0`) release** — this is a breaking change (drops `obsidian-cli`,
`DesktopCliTransport`, `ObsidianCliTransportOptions`; default transport changes) — run via the repo's
release flow. Then the **23-plugin migration**: any plugin explicitly setting `type: 'obsidian-cli'`
must switch to `obsidian-cdp` (most rely on the default and need nothing). Not yet validated on
macOS/Linux (the installer-extraction + shell-version-detection paths are platform-specific).

## Pending Questions

None.

## L5. Transport configuration

Transport is configured via the framework adapter's config mechanism. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates; `obsidian-cdp` is the default when omitted. Vitest uses `environmentOptions.obsidianTransport`; Jest uses `globalThis.__obsidianIntegrationTesting.transportOptions`. Other frameworks can register a custom resolver via `setTransportOptionsResolver()`.

Desktop (`obsidian-cdp`) defaults to a **harness-owned, isolated instance** (temp `--user-data-dir` + free CDP port; never touches user-scope Obsidian). Set `port` to **attach** to a running Obsidian instead. `obsidianVersion` (asar) and `obsidianInstallerVersion` (shell) pin the version — each accepts `x.y.z` / `public-latest` / `catalyst-latest`; asar swap is upgrade-only vs. the shell, so older versions auto-use the matching installer (downloads/extracts via 7-Zip on Windows). Both version knobs ride the existing `transportOptions` channel, so all three consumption paths get them with no adapter change.

## L6. Framework parity (Vitest / Jest / Manual)

Every setup capability must reach **all three** consumption paths, never just one:

- **Core (`src/global-setup-core.ts`)** — the framework-agnostic primitive. New setup behavior is implemented here first, exposed via `CoreSetupParams` / `CoreSetupResult`, so the **Manual** path (consumers wiring `TempVault` / the core directly) gets it for free.
- **Vitest adapter (`src/vitest/global-setup.ts`)** — threads the capability through `createSetup(options)` and keeps the plain `setup` / `teardown` exports as the default (`createSetup()`) case.
- **Jest adapter (`src/jest/global-setup.ts`)** — mirrors the Vitest adapter exactly: same `createSetup(options)` factory shape, same `CreateSetupOptions` fields (including thunk-vs-value conventions), same default `setup` / `teardown` exports.

When adding or changing any adapter-facing option, update the core and **both** adapters in the same change. A capability that lands in only one framework is incomplete. Both adapter files are excluded from unit-test coverage (`v8 ignore`) because they are integration-time glue; keep them as thin as possible so the shared logic stays in the core.

## L7. Cross-process run serialization

Two integration-test runs that share the same Obsidian resources corrupt each other. On **Android** the emulator and Appium server are shared, so concurrent runs collide (symptoms: `ECONNREFUSED`, "vault not open"). On **desktop** this no longer applies: each run owns an isolated instance (its own temp `--user-data-dir` and free CDP port; Electron's single-instance lock is per-userData), so desktop runs are independent and need no lock.

`src/setup-lock.ts` provides a cross-process advisory lock (a PID-stamped sentinel file under `<tmpdir>/obsidian-integration-testing/<scope>.setup.lock`). `coreSetup` acquires it **first** (before creating the transport — transport creation is what starts the emulator/Appium) and **waits** until any competing run releases it; `coreTeardown` and the process cleanup handlers release it. A crashed run that never released is detected as stale (dead PID on the same host, or an age threshold across hosts) and stolen.

Only the **`android`** scope (`obsidian-android-appium`) takes the lock now; `getLockScope` returns `undefined` for desktop, so no lock is acquired. The lock lives entirely in the core, so all three consumption paths (Vitest / Jest / Manual) inherit this with no adapter changes. (Note: the **attach** desktop mode shares the user's running Obsidian, but attaching is an explicit advanced opt-in and is the user's responsibility to serialize.)

## L8. Trusted keyboard input (`typeIntoEditor`)

Every `evalInObsidian` callback receives a `typeIntoEditor(params: { editor: Editor; text: string })`
helper on its args (alongside `app` / `obsidianModule`), exposed via `CommonArgs`
(`src/eval-in-obsidian.ts`) and defined in the in-process namespace (`namespace-bootstrap.ts`,
wired into the `fullArgs` literal). Per **L6** it lives once on the Obsidian side, so Vitest / Jest /
Manual all inherit it.

Reliably testing "the user typed into a CodeMirror editor" needs a **trusted** key event (the kind
only the browser/OS produces). Both in-page alternatives give false results:

- `dispatchEvent(new KeyboardEvent(...))` is untrusted (`isTrusted: false`) → CodeMirror's DOM
  observer ignores it and the document never changes, even when everything is wired correctly.
- `execCommand('insertText')` mutates the selection directly → it inserts text **even when the editor
  is not focused**, masking focus bugs (e.g. a modal focus trap) as false-positive passes.

`typeIntoEditor` injects a **trusted** event via Electron's
`webContents.sendInputEvent({ keyCode, type: 'char' })` at the Chromium level: it is delivered to the
window's DOM-focused element and flows through CodeMirror's real input pipeline, so the text lands
**only if the editor genuinely holds focus** — a faithful end-to-end check. It reaches `webContents`
via `window.electron.remote.getCurrentWebContents()` (consistent with the bootstrap's existing
`window.electron.ipcRenderer` use), and uses `getCurrentWebContents()`, **not**
`getFocusedWebContents()` — the latter returns `null` when no Obsidian window holds OS-level focus,
which is exactly the headless/CI case. `obsidian-typings`' `ElectronWebContents` omits
`sendInputEvent`, so the helper casts to a local interface that adds it. After injecting the
keystrokes it **polls** (not a fixed delay) until the document reflects the input, or a bounded
timeout elapses (the expected outcome when the editor is read-only/rejecting, or focus was stolen).

### Consumer responsibility: serialize focus-dependent integration files

Trusted input targets the single shared window's **global** focus, so focus-dependent integration
test **files** must not run in parallel against the one shared Obsidian instance: they race for focus,
and a `detachLeavesOfType('markdown')` in one file wipes another's editor. The consuming project must
run its obsidian-integration vitest project serially (`fileParallelism: false`, `maxWorkers: 1`).

### Pending migration (`obsidian-dev-utils`)

`obsidian-dev-utils` still ships a local stopgap `src/test-helpers/type-into-editor.ts` (a
self-contained function passed into closures via `args`). Now that the helper is shipped here, remove
the dev-utils copy and switch its integration tests to the `typeIntoEditor` provided in `CommonArgs`.

## L9. Test workers must register the context resolvers (`vitest-setup` / `jest-setup`)

`getTransportOptions()` / `getVaultPath()` are resolved through resolvers registered by
`setTransportOptionsResolver` / `setVaultPathResolver`. Those registrations live in the framework
**global-setup** modules, which run **only in the main process** — not in the test workers that
actually call `evalInObsidian`. Under the retired CLI default this was invisible: with no resolver,
`getTransportOptions()` returned `undefined`, and the CLI transport needs no port. The owned-CDP
default **does** need a port (the free port the owned instance was launched on), so a worker with no
resolver silently rebuilds an owned transport that never launches → its `cdpUrl` is empty →
`fetch('/json')` throws `Failed to parse URL from /json` on the first eval.

Fix (this is the mechanism — keep it in mind whenever a capability must reach workers):

1. **Propagate the endpoint.** `coreSetup` runs `augmentTransportOptions`, which for an owned
   `DesktopCdpTransport` injects the launched `host`/`port` plus the internal
   `isHarnessOwnedInstance` flag into the options handed to workers (mirroring the Appium
   `sessionId`/`deviceId` reuse path). The factory's `port` branch then builds an **attach**
   transport; `isHarnessOwnedInstance` makes `preflightCheck` skip the user-scope vault-registration
   check (the owned vault lives in an isolated user-data config, not the user-scope registry).
2. **Register the resolver in the worker.** Consumers MUST add the per-worker setup file to their
   integration vitest project's `setupFiles`: `setupFiles: ['obsidian-integration-testing/vitest-setup']`
   (Jest: add `obsidian-integration-testing/jest-setup` to `setupFiles`). It registers
   `setTransportOptionsResolver(() => inject('obsidianTransport'))` and the vault-path resolver, so
   the worker reads what the global setup published via `provide`.

Per L6 the mechanism reaches both frameworks. Caveat: Vitest's `provide`/`inject` carries the
**dynamically** chosen owned port to workers; Jest has no `globalSetup`→worker channel for dynamic
values (its `globals` are static config), so under Jest the owned-CDP default cannot hand workers the
auto-chosen port — attach to a fixed `port` via the transport options in `globals`.

**23-plugin migration impact:** the pending migration is no longer just "switch `type:
'obsidian-cli'` → `obsidian-cdp`". Every plugin running desktop integration tests with the owned-CDP
default must also add `obsidian-integration-testing/vitest-setup` to its integration project's
`setupFiles` (best done once in the shared `obsidian-dev-utils` vitest config so the fleet inherits
it).

## Known Issues

None.

(The historical "CLI eval result polluted by in-flight background async" note was removed: the `DesktopCliTransport` it described has been retired in favour of the owned-instance CDP transport.)
