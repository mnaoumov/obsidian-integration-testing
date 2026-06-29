# Project: obsidian-integration-testing

A library that provides helpers for integration testing Obsidian plugins against a running Obsidian instance.

## L1. Architecture

The package exports these entry points:

| Entry point                                         | Purpose                                                                      |
|-----------------------------------------------------|------------------------------------------------------------------------------|
| `obsidian-integration-testing`                      | Main — `evalInObsidian`, `ContextId`, `TempVault`, transports, types         |
| `obsidian-integration-testing/vitest-global-setup`  | Vitest global `setup`/`teardown` + `getTempVault()`                          |
| `obsidian-integration-testing/vitest/typings`       | Opt-in Vitest module augmentations (`ProvidedContext`, `EnvironmentOptions`) |
| `obsidian-integration-testing/jest-global-setup`    | Jest global setup (default + named `setup`/`teardown`) + `getTempVault()`    |
| `obsidian-integration-testing/jest-global-teardown` | Jest global teardown (default export) — separate module Jest requires        |

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

## L7. Cross-process run serialization

Two integration-test runs that share the same Obsidian resources corrupt each other — on desktop the single local Obsidian instance, its `obsidian.json` registry and CDP port; on Android the emulator and Appium server. One run's setup/teardown kills or reconfigures the instance the other is mid-eval on (symptoms: `ECONNREFUSED`, "vault not open"), so both fail.

`src/setup-lock.ts` provides a cross-process advisory lock (a PID-stamped sentinel file under `<tmpdir>/obsidian-integration-testing/<scope>.setup.lock`). `coreSetup` acquires it **first** (before creating the transport — transport creation is what starts the emulator/Appium/Obsidian) and **waits** until any competing run releases it; `coreTeardown` and the process cleanup handlers release it. A crashed run that never released is detected as stale (dead PID on the same host, or an age threshold across hosts) and stolen.

Scope groups runs that contend on the same resources: `desktop` for the `obsidian-cli` and `obsidian-cdp` transports, `android` for `obsidian-android-appium`. A desktop run and an Android run use different scopes and may run concurrently. The lock lives entirely in the core, so all three consumption paths (Vitest / Jest / Manual) inherit it with no adapter changes.

## Proposed feature: trusted keyboard input in `evalInObsidian` callbacks

Reliably testing "the user typed into a CodeMirror editor" needs a **trusted** key event (the kind
only the browser/OS produces). Both in-page alternatives give false results:

- `dispatchEvent(new KeyboardEvent(...))` is untrusted (`isTrusted: false`) → CodeMirror's DOM
  observer ignores it and the document never changes, even when everything is wired correctly.
- `execCommand('insertText')` mutates the selection directly → it inserts text **even when the editor
  is not focused**, masking focus bugs (e.g. a modal focus trap) as false-positive passes.

Electron's `webContents.sendInputEvent({ keyCode, type: 'char' })` injects a **trusted** event at the
Chromium level: it is delivered to the window's DOM-focused element and flows through CodeMirror's
real input pipeline, so the text lands **only if the editor genuinely holds focus** — a faithful
end-to-end check. Reach it via `window.electron.remote.getCurrentWebContents()` (the namespace
bootstrap already uses `window.electron.ipcRenderer`, so this is consistent). Use
`getCurrentWebContents()`, **not** `getFocusedWebContents()` — the latter returns `null` when no
Obsidian window holds OS-level focus, which is exactly the headless/CI case.

### Suggested implementation (expose via `CommonArgs`)

Inject the helper into every closure's args, mirroring how `app` / `obsidianModule` are provided:

1. `CommonArgs` (`src/eval-in-obsidian.ts`): add
   `typeIntoEditor(params: { editor: Editor; text: string }): Promise<void>;` (type-only `Editor`
   import from `obsidian`).
2. `namespace-bootstrap.ts`: define the helper on the Obsidian side and add it to the `fullArgs`
   literal (`{ ...params.args, app: this.app, context, obsidianModule }`). Because it is defined in
   the in-process namespace (not serialized per call), it can be a normal function:

   ```ts
   async function typeIntoEditor({ editor, text }) {
     const valueBefore = editor.getValue();
     editor.focus();
     editor.setCursor(editor.lastLine(), editor.getLine(editor.lastLine()).length);
     await sleep(300); // let any focus trap (a setTimeout(0) re-focus) fire before typing
     const webContents = window.electron.remote.getCurrentWebContents();
     for (const char of text) {
       webContents.sendInputEvent({ keyCode: char, type: 'char' });
     }
     // Poll (NOT a fixed delay) until the document reflects the input, or a bounded timeout: a
     // read-only/rejecting editor never changes, and under full-suite load the apply can be slow.
     const startTime = Date.now();
     while (editor.getValue() === valueBefore && Date.now() - startTime < 5000) {
       await sleep(50);
     }
   }
   ```

   Per **L6**, implement it once on the Obsidian side so Vitest / Jest / Manual all inherit it.

### Consumer responsibility: serialize focus-dependent integration files

Trusted input targets the single shared window's **global** focus, so focus-dependent integration
test **files** must not run in parallel against the one shared Obsidian instance: they race for focus,
and a `detachLeavesOfType('markdown')` in one file wipes another's editor. The consuming project must
run its obsidian-integration vitest project serially (`fileParallelism: false`, `maxWorkers: 1`).

### Migration

`obsidian-dev-utils` currently ships a local stopgap `src/test-helpers/type-into-editor.ts` (a
self-contained function passed into closures via `args`). Once this helper is released here, remove
the dev-utils copy and switch its integration tests to the `typeIntoEditor` provided in `CommonArgs`.

## Known Issues

None.

The previously-listed "CLI eval result polluted by in-flight background async" issue was a **stdout-era** bug: until the stdout→result-file migration (shipped in 2.5.0), `DesktopCliTransport.evaluate` read the eval result from `obsidian eval`'s stdout, so a fire-and-forget renderer promise resolving to a stray value (e.g. `"function"`) could interleave on that shared stream and break `JSON.parse`. Since 2.5.0 each result is written to a per-call `<scriptId>.result.json` and read back, removing the shared value channel. Verified resolved against 4.4.0: removing the downstream `afterAll` `detachLeavesOfType('markdown')` workaround in codescript's desktop integration suite and running the full desktop suite produced 114/114 passing (9 test files) with no `non-JSON output` error.
