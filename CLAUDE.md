# Project: obsidian-integration-testing

A library that provides helpers for integration testing Obsidian plugins against an Obsidian instance. On desktop it launches and owns an isolated Obsidian instance by default (it can also attach to a running one); on Android it drives Obsidian Mobile via Appium.

## L1. Architecture

The package exports these entry points:

| Entry point                                         | Purpose                                                                              |
|-----------------------------------------------------|--------------------------------------------------------------------------------------|
| `obsidian-integration-testing`                      | Main — `evalInObsidian`, `connectToCdp`, `ContextId`, `TempVault`, transports, types |
| `obsidian-integration-testing/vitest-global-setup`  | Vitest global `setup`/`teardown` + `getTempVault()`                                  |
| `obsidian-integration-testing/vitest-setup`         | Vitest **per-worker** `setupFiles` entry — registers the context resolvers           |
| `obsidian-integration-testing/vitest/typings`       | Opt-in Vitest module augmentations (`ProvidedContext`, `EnvironmentOptions`)         |
| `obsidian-integration-testing/jest-global-setup`    | Jest global setup (default + named `setup`/`teardown`) + `getTempVault()`            |
| `obsidian-integration-testing/jest-global-teardown` | Jest global teardown (default export) — separate module Jest requires                |
| `obsidian-integration-testing/jest-setup`           | Jest **per-worker** `setupFiles` entry — registers the context resolvers             |

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

### Fix intermittent Android `waitForLayoutReady` 30s timeout (from the @obsidian G10d release loop, 2026-07-10)

**Symptom.** During plugin releases (`npm run version patch` → `test:integration`), the `integration-tests:android` smoke test intermittently fails at setup with `Error: Obsidian layout did not become ready within 30000ms` (`AppiumTransport.waitForLayoutReady`, `src/transport-appium.ts`). Reproduced on `obsidian-smart-rename`'s release; it will flake **every** plugin's release the same way.

**Root cause.** `registerVault` (`transport-appium.ts:325`) pushes the vault marker, `ensureWebViewContext()`, sets localStorage, then `location.reload()` — a **full Obsidian re-init** (reopen vault + reload all plugins, the heaviest startup step) — then `waitForLayoutReady()` polls `app.workspace.layoutReady` for a **hardcoded, non-configurable `LAYOUT_READY_POLL_TIMEOUT_IN_MILLISECONDS = 30000`** (`transport-appium.ts:131`, used at `:447`). On a cold-booted / under-provisioned emulator (see **L13**), that post-reload init intermittently exceeds 30s. Design gap: the *lighter* `ensureWebViewContext` step already has a **configurable** timeout (`webviewTimeoutInMilliseconds`, `@default 60000`, options field ~`:122`, ctor field ~`:179`), but the *heavier* layout step got a shorter, fixed one.

**Fix (mirror `webviewTimeoutInMilliseconds` end-to-end).**
1. Add `layoutReadyTimeoutInMilliseconds?: number` to the Appium transport options interface (next to `webviewTimeoutInMilliseconds`, `@default 90000` — verified by a test per the `@default`-tag rule). Thread it: options type → `AppiumTransportFactory` → `AppiumTransport` constructor → a `private readonly layoutReadyTimeoutInMilliseconds: number` field, and use the field in `waitForLayoutReady` instead of the module constant. Keep the constant as the default value.
2. **Raise the default `30000` → `90000`** (≥ the webview default; the post-reload full init deserves the most headroom).
3. Optional robustness: `log(...)` elapsed time each poll for diagnosis; and after `location.reload()` re-`ensureWebViewContext()` explicitly so WebView re-acquisition time isn't silently charged against the layout budget (currently the swallowed `execute` errors conflate "context not back yet" with "layout not ready").
4. Add a unit test covering the new option + its default (repo requires 100% coverage). The transport module is integration-glue; check whether the option-plumbing is unit-reachable or needs a small extraction.
5. Note in the change: the deeper cause is emulator provisioning (L13) — the timeout raise is headroom, not a substitute for adequate vCPU/RAM/HW-accel or a pre-booted snapshot.

**Release.** This ships in the repo's own release; it can ride the pending `5.0.0` (it is not itself breaking, so a minor would also do). After release, the @obsidian plugins consuming it get the headroom via the version bump (already part of the periodic libs refresh); no per-plugin code change needed.

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

`typeIntoEditor` focuses the editor (caret to end), then **presses each code point of `text` via
`pressKey`** (see **L14**) — typing is just pressing each character key in turn, so it reuses the same
trusted `keyDown` → `char` → `keyUp` a real user produces rather than duplicating a `sendInputEvent`
call. Each keystroke is delivered to the window's DOM-focused element and flows through CodeMirror's
real input pipeline, so the text lands **only if the editor genuinely holds focus** — a faithful
end-to-end check. (`pressKey` reaches `webContents` via
`window.electron.remote.getCurrentWebContents()` — using `getCurrentWebContents()`, **not**
`getFocusedWebContents()`, which returns `null` in the headless/CI case; see L14.) After pressing the
keys it **polls** (not a fixed delay) until the document reflects the input, or a bounded timeout
elapses (the expected outcome when the editor is read-only/rejecting, or focus was stolen).

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

## L10. `connectToCdp` — standalone CDP debugging helper

`connectToCdp(options?)` (`src/connect-to-cdp.ts`, exported from the main entry) is a thin,
framework-agnostic convenience over `createTransportFromOptions` + `TempVault` + `evalInObsidian`. It
launches (or, with `port`, attaches to) a CDP Obsidian instance, opens a vault, bootstraps the runtime
helper namespace, and returns a disposable `CdpConnection` exposing `port`, `cdpUrl`, `vault`,
`invoke(expr)` (raw), and `evalInObsidian({ fn, args })` (rich). It targets ad-hoc real-app debugging
(the R5 / CDP-debugging workflow) rather than test suites.

**Vault-removal safety.** `TempVault.dispose()` unconditionally `rm`s its directory, so a real vault
passed by path must never be routed through it. `connectToCdp` encodes this: `dispose()` removes the
vault dir only when `shouldRemoveVaultOnDispose` is `true`, which **defaults to `true` for an implicit
temp vault** (no `vault` given) and **`false` when a `vault` path is given** (a real vault is never
auto-deleted). A real vault is only unregistered (window closed), not removed.

The whole module is integration-time glue (spawns Obsidian / CDP), so — like `transport-factory.ts` /
`obsidian-instance.ts` — it is wrapped in a module-level `v8 ignore` and covered by
`src/connect-to-cdp.desktop.integration.test.ts`, not unit tests. A thin CLI (`src/cli.ts` +
`bin/obsidian-integration-testing.mjs`, wired via `package.json` `bin`) wraps it for when an external
tool must attach to a printed port.

## L11. Trusted pointer input (`moveMouse` / `hoverElement` / `unhoverElement`)

Every `evalInObsidian` callback also receives a trusted-pointer trio on its args (alongside
`typeIntoEditor`), exposed via `CommonArgs` (`src/eval-in-obsidian.ts`) and defined in the in-process
namespace (`namespace-bootstrap.ts`, wired into the `fullArgs` literal). Per **L6** they live once on
the Obsidian side, so Vitest / Jest / Manual all inherit them. This is the pointer analog of L8's
trusted keyboard input, and shares its mechanism and caveats.

Some CSS is reachable only through a real pointer **state**. `:hover` is the canonical case: it is not
an event you can synthesize — `dispatchEvent(new MouseEvent('mouseover'))` is untrusted and never sets
`:hover`, so a test that needs to observe a genuine hover (real theme `var()` values, real compositing;
e.g. verifying the `.minimized-modal-bar` box stays opaque on hover) cannot hand-simulate it. The only
faithful trigger is a **trusted** pointer move, injected via Electron's
`webContents.sendInputEvent({ type: 'mouseMove', x, y })` at the Chromium level — the exact analog of
`typeIntoEditor`'s trusted keypress. It reaches `webContents` the same way: via
`window.electron.remote.getCurrentWebContents()` (using `getCurrentWebContents`, **not**
`getFocusedWebContents`, since headless CI has no OS focus), through the same local `sendInputEvent`
interface, widened to also accept a `mouseMove` input.

Three helpers over one shared internal move, so the primitive and the conveniences never diverge:

- **`moveMouse({ x, y })`** — the raw primitive. Injects a single trusted move at the given web-contents
  DIP coordinates and does **not** poll (callers poll their own readiness signal). Use it directly when
  an element-relative target does not fit (e.g. a full-viewport element with no point outside its box).
- **`hoverElement({ element })`** — moves to the element's center, then **polls** (not a fixed delay)
  until `element.matches(':hover')`, so it is robust under shared-instance load.
- **`unhoverElement({ element })`** — moves to a point just outside the element's bounding box, then
  polls until `!element.matches(':hover')`.

### Consumer responsibility: serialize pointer-dependent integration files

A trusted move changes the single shared window's **global** pointer target, so only one element is
hovered at a time. As with L8's trusted keyboard focus, pointer-dependent integration test **files**
must not run in parallel against the one shared Obsidian instance — the consuming project must run its
obsidian-integration vitest project serially (`fileParallelism: false`, `maxWorkers: 1`).

### Pending migration (`obsidian-dev-utils`)

`obsidian-dev-utils` writes its red-first advanced-note-composer #124 integration test (the
minimized-modal-bar opaque-on-hover regression) against `CommonArgs.hoverElement` from this helper —
see that repo's `## Current Task — Fix minimized modal bar transparent on hover`, and, per L8's
pending-migration note, it uses the shipped helper rather than any local stopgap.

## L12. Reusable async wait (`waitUntil`)

Every `evalInObsidian` callback also receives a `waitUntil(params: WaitUntilParams)` helper on its
args (alongside `typeIntoEditor` / the pointer trio), exposed via `CommonArgs`
(`src/eval-in-obsidian.ts`) and defined in the in-process namespace (`namespace-bootstrap.ts`, wired
into the `fullArgs` literal). Per **L6** it lives once on the Obsidian side, so Vitest / Jest / Manual
all inherit it.

Integration-test closures constantly need to wait for an asynchronous effect to settle (a view to
open, a DOM node to appear, a setting to apply). The closure is serialized via `toString()` and
**cannot import modules**, so it can't reuse `obsidian-dev-utils`' `retryWithTimeout` / `runWithTimeout`.
Before this helper, every consumer hand-rolled the same poll loop inside each closure
(`obsidian-codescript-toolkit` defined a local `waitUntil` per test; `obsidian-advanced-note-composer`'s
`modal-instructions.desktop.integration.test.ts` hand-rolled one too). Injecting through `CommonArgs`
is the **only** way to share such a helper into the serialized closure — the same mechanism as
`hoverElement` / `typeIntoEditor` / `moveMouse`.

- **API shape** — a params object `waitUntil({ predicate })`, matching every other `CommonArgs` helper
  (not a positional `waitUntil(() => cond)`), so the injected-helper surface stays uniform.
- **`predicate`** may be **synchronous or asynchronous** — it is `await`ed on every poll. It is checked
  immediately, then re-checked every `intervalInMilliseconds` (default `50`) until it returns truthy or
  `timeoutInMilliseconds` (default `5000`) elapses, at which point the returned `Promise` **rejects**
  with a clear timeout error (`message` is appended when provided). Both the interval and timeout are
  overridable via the params. `WaitUntilParams` is exported from the main entry.

### Pending migration (consumer cleanup)

Replace the hand-rolled per-closure `waitUntil` loops with the injected `waitUntil` from `CommonArgs`
(destructure `async fn({ app, waitUntil }) { … }`). First consumers: `obsidian-advanced-note-composer`
(`modal-instructions.desktop.integration.test.ts`) and `obsidian-codescript-toolkit`. Each needs its
`obsidian-integration-testing` dependency bumped to the version that ships this helper.

## L13. Android boot: suppress crash/ANR dialogs (`hide_error_dialogs`)

A resource-starved emulator can raise a "Process system isn't responding" ANR (an
`ActivityManagerService` timeout) whose dialog overlays the UI. When it appears **before** Appium
attaches, nothing can dismiss it and the run hangs or fails intermittently. In
`transport-factory.ts`, `AppiumTransportFactory.suppressErrorDialogs` runs
`adb -s <deviceId> shell settings put global hide_error_dialogs 1` so `ActivityManagerService` never
draws crash/ANR dialogs. `ensureDeviceConnected` calls it for **both** the newly-started path (after
`waitForNewDevice`, which already waits for `sys.boot_completed`) and the reused-device path — the
earliest safe point, since `system_server` must be up before `settings put` works. It is best-effort
(a failure is logged via the same warn-don't-throw pattern as `sendKeyEvent`, since it only
suppresses a symptom).

This narrows but cannot fully close the race: an ANR that fires between boot completing and the
`settings put` still slips through. Fully eliminating it needs a pre-baked snapshot with the flag
already set (the flag persists across reboot but not `wipe-data`). The ANR itself signals an
under-provisioned emulator (too few vCPUs/RAM, or missing hardware acceleration), so treat the
suppression as symptom relief, not a root-cause fix.

## L14. Trusted key press (`pressKey`)

Every `evalInObsidian` callback also receives a `pressKey(params: PressKeyParams)` helper on its args
(alongside `typeIntoEditor` / the pointer trio / `waitUntil`), exposed via `CommonArgs`
(`src/eval-in-obsidian.ts`) and defined in the in-process namespace (`namespace-bootstrap.ts`, wired
into the `fullArgs` literal). Per **L6** it lives once on the Obsidian side, so Vitest / Jest / Manual
all inherit it. This is the key-press analog of L8's `typeIntoEditor`, and shares its trusted-input
mechanism and caveats.

`pressKey` is the shared primitive for **all** trusted keyboard input: `typeIntoEditor` **builds on
it**, pressing each code point of its `text` via `pressKey` (typing is pressing each character key in
turn), so the two paths are identical and there is a single `sendInputEvent` keyboard call site.
`typeIntoEditor` adds the editor-typing wrapper (focus + caret-to-end + poll until the document
settles); `pressKey` on its own presses a **single key** (optionally with modifiers) on whatever
element currently holds DOM focus — for special keys (`Enter`, `Escape`, `Tab`, arrows) and modifier
combos (`Shift+Enter`, `Mod+A`) that plain typing does not cover.
It injects a trusted `keyDown` → `char` → `keyUp` sequence via
`webContents.sendInputEvent`, firing the **full real pipeline**: `keydown` → `keypress` →
`beforeinput` → `input` → `keyup`, all with `isTrusted: true` (untrusted `dispatchEvent(new
KeyboardEvent(...))` is ignored by CodeMirror and most key handlers). Confirmed end-to-end on Windows
(Obsidian 1.13.1): all five events fire trusted, and a trusted `Enter` inserts a newline in a live
CodeMirror editor.

- **API shape** — `pressKey({ key, modifiers? })`, matching every other `CommonArgs` helper (params
  object). `key` is an **Electron Accelerator key name** (`'Enter'`, `'Escape'`, `'Up'`, `'a'`, …).
  `modifiers` reuses Obsidian's own `Modifier` type (`'Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt'`) — the
  same values as an Obsidian `Hotkey` — rather than a bespoke type. `'Mod'` resolves per-platform (Cmd
  on macOS, Ctrl elsewhere) via **`Platform.isMacOS`** read off the resolved obsidian module
  (`ns.obsidianModule`, always populated because `evalWrapper` resolves the module before any callback
  runs); the others map to Electron's lowercase `sendInputEvent` names (`'Ctrl'` → `'control'`, the rest
  lowercase directly). `PressKeyParams` is exported from the main entry.
- **No polling** (like `moveMouse`, unlike `typeIntoEditor`): a key press has **no universal
  observable effect** (`Enter` edits the doc, `Escape` closes a modal, `ArrowDown` moves selection), so
  it injects and returns; the caller focuses the target first, then awaits the expected effect via
  `waitUntil`.
- **Produced character is the literal `key`.** Electron's `char` event inserts the raw `keyCode`
  (`pressKey({ key: 'a', modifiers: ['Shift'] })` inserts `'a'`, though `keydown.key` reflects Shift as
  `'A'`). Case-correct text is `typeIntoEditor`'s job, not a key-press primitive's.

### Consumer responsibility: serialize focus-dependent integration files

Identical to L8: a trusted key press targets the single shared window's **global** focus, so
focus-dependent integration test **files** must not run in parallel against the one shared Obsidian
instance (`fileParallelism: false`, `maxWorkers: 1`).

## Known Issues

None.

(The historical "CLI eval result polluted by in-flight background async" note was removed: the `DesktopCliTransport` it described has been retired in favour of the owned-instance CDP transport.)
