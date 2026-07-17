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

Internal modules (`exec`, `function-expression`, `json-with-functions`, `type-guards`, `obsidian-config`, `obsidian-version`, `obsidian-version-switch`, `obsidian-installer`, `installer-asset`, `obsidian-instance`, `kill-process-tree`, `renderer-boot-detection`) are not re-exported. `RendererFailedToInitializeError` (`renderer-failed-to-initialize-error.ts`) **is** exported — see L18.

The desktop owned-instance lifecycle lives in `transport-desktop-cdp.ts` (mode: own vs. attach), with `obsidian-instance.ts` (launch + free port + kill), `obsidian-version*.ts` (asar version resolution/download/cache), and `obsidian-installer.ts` (shell version detect/download/extract — it resolves the installer asset by querying the release's real asset list via the GitHub API and picking the platform-correct name with the pure, unit-tested `installer-asset.ts`, tolerating the historical dot-vs-hyphen separator rename, with a both-separator templated fallback when the API is unavailable). `transport-factory.ts` resolves the owned-instance config (shell exe + asar + temp user-data dir) from the version knobs.

## L2. Build

- `npm run build` — clean, type-check, generate `src/index.ts` barrel, build ESM+CJS via esbuild, emit `.d.mts`/`.d.cts` declarations.
- Output lands in `dist/lib/esm/` and `dist/lib/cjs/`.
- `src/index.ts` is the manually maintained barrel file.

## L3. Testing

- Unit tests: `npm run test` (Vitest, `--project unit-tests`).
- Integration tests: `npm run test:integration` (desktop requires Obsidian installed — the harness launches its own isolated instance; no CLI or running instance needed). Runs two projects: `integration-tests` (each suite registers its vault in-worker) and `integration-tests:owned-attach` (the L9 regression suite: the global setup owns the instance and the worker **attaches** — its own `globalSetup` writes a fixture plugin into `dist/dev` and wires `vitest-setup` into `setupFiles`).
- Coverage: `npm run test:coverage` — requires 100% on all metrics.
- Cross-platform CI validation (manual `workflow_dispatch`, since each run downloads a multi-hundred-MB asset): `.github/workflows/validate-installer-path.yml` validates installer download+extract on ubuntu/macos/windows (opt-in via `OBSIDIAN_TEST_INSTALLER_DOWNLOAD=1`); `.github/workflows/validate-installer-boot.yml` validates the owned-instance **boot** from a pinned installer (`OBSIDIAN_TEST_INSTALLER_BOOT=1`, launches Electron under `xvfb` + `--no-sandbox` on Linux) and, in a Linux-only step, the asar-swap version-pin regression (`OBSIDIAN_TEST_ASAR_SWAP=1` — symlinks a newer cached shell under a versionless dir on `PATH` so shell-version detection returns `undefined`, then asserts an older pinned `obsidianVersion` actually runs). Both pass `GITHUB_TOKEN` so the release-asset API isn't rate-limited to the anonymous quota (which 403s on shared runner IPs → templated-name fallback).

## L4. Peer dependencies

Consumers must have `obsidian`, `type-fest`, and their test framework (`vitest` or `jest`) installed.

## L5. Transport configuration

Transport is configured via the framework adapter's config mechanism. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates; `obsidian-cdp` is the default when omitted. Vitest uses `environmentOptions.obsidianTransport`; Jest uses `globalThis.__obsidianIntegrationTesting.transportOptions`. Other frameworks can register a custom resolver via `setTransportOptionsResolver()`.

Desktop (`obsidian-cdp`) defaults to a **harness-owned, isolated instance** (temp `--user-data-dir` + free CDP port; never touches user-scope Obsidian). Set `port` to **attach** to a running Obsidian instead. `obsidianVersion` (asar) and `obsidianInstallerVersion` (shell) pin the version — each accepts `x.y.z` / `public-latest` / `catalyst-latest`; asar swap is upgrade-only vs. the shell, so older versions auto-use the matching installer (downloads/extracts via 7-Zip on Windows). Version resolution is **install-free when `obsidianInstallerVersion` is pinned** (the shell comes from the pin, so no locally-installed Obsidian is required — e.g. CI); an `obsidianVersion` is applied by **asar-swap only when the shell version is known AND the asar is ≥ it**, otherwise (older asar, or an undetectable shell version — the Linux `detectInstalledShellVersion` path-parse miss) the pinned version's own installer shell is used so the pin is always honored. `shouldDisableSandbox` (default `false`) appends `--no-sandbox` to boot an owned instance on Linux without a configured setuid `chrome-sandbox` helper (CI, or an extracted portable shell); harmless on Windows/macOS. All these knobs ride the existing `transportOptions` channel, so all three consumption paths get them with no adapter change.

**Process visibility (see L15):** owned desktop Obsidian defaults to visible (`isObsidianAppVisible: true`), while integration setup explicitly passes `false` so test runs do not steal focus. Android surfaces remain hidden by default: `isEmulatorVisible` (emulator `-no-window`) and `isAppiumConsoleVisible` (Appium spawn `windowsHide` with discarded output). Like the version knobs they ride the `transportOptions` channel (no adapter change).

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
helper as a **base** member of the injected **`lib`** bag (destructure `fn({ lib: { typeIntoEditor } })`),
typed on `Lib` (`src/eval-in-obsidian.ts`) and seeded into the base `lib` in the in-process namespace
(`namespace-bootstrap.ts`, the bag `evalWrapper` builds). See **L16** for the `lib` mechanism. Per **L6**
it lives once on the Obsidian side, so Vitest / Jest / Manual all inherit it.

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

`obsidian-dev-utils` ships a local `src/test-helpers/type-into-editor.ts`. Under the base-`lib` +
duplication decision (see the Current Task hand-off), dev-utils **keeps** its own copies of the
trusted-input / `waitUntil` helpers (duplication accepted) and exposes them through its `__merged`
surface, so they merge onto the base `lib`; its integration tests destructure them from `lib`
(`async fn({ lib: { typeIntoEditor } }) { … }`) rather than passing them via `args`.

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

Every `evalInObsidian` callback also gets a trusted-pointer trio as **base** members of the injected
**`lib`** bag (alongside `typeIntoEditor`), typed on `Lib` (`src/eval-in-obsidian.ts`) and seeded into
the base `lib` in the in-process namespace (`namespace-bootstrap.ts`); see **L16**. Per **L6** they live
once on the Obsidian side, so Vitest / Jest / Manual all inherit them. This is the pointer analog of L8's
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
minimized-modal-bar opaque-on-hover regression) against `lib.hoverElement` from this helper —
see that repo's `## Current Task — Fix minimized modal bar transparent on hover`, and, per L8's
pending-migration note, it uses the shipped helper rather than any local stopgap.

## L12. Reusable async wait (`waitUntil`)

Every `evalInObsidian` callback also gets a `waitUntil(params: WaitUntilParams)` helper as a **base**
member of the injected **`lib`** bag (alongside `typeIntoEditor` / the pointer trio), typed on `Lib`
(`src/eval-in-obsidian.ts`) and seeded into the base `lib` in the in-process namespace
(`namespace-bootstrap.ts`); see **L16**. Per **L6** it lives once on the Obsidian side, so Vitest / Jest / Manual
all inherit it.

Integration-test closures constantly need to wait for an asynchronous effect to settle (a view to
open, a DOM node to appear, a setting to apply). The closure is serialized via `toString()` and
**cannot import modules**, so it can't reuse `obsidian-dev-utils`' `retryWithTimeout` / `runWithTimeout`.
Before this helper, every consumer hand-rolled the same poll loop inside each closure
(`obsidian-codescript-toolkit` defined a local `waitUntil` per test; `obsidian-advanced-note-composer`'s
`modal-instructions.desktop.integration.test.ts` hand-rolled one too). Injecting through `CommonArgs`
is the **only** way to share such a helper into the serialized closure — the same mechanism as
`hoverElement` / `typeIntoEditor` / `moveMouse`.

- **API shape** — a params object `waitUntil({ predicate })`, matching every other `lib` helper
  (not a positional `waitUntil(() => cond)`), so the injected-helper surface stays uniform.
- **`predicate`** may be **synchronous or asynchronous** — it is `await`ed on every poll. It is checked
  immediately, then re-checked every `intervalInMilliseconds` (default `50`) until it returns truthy or
  `timeoutInMilliseconds` (default `5000`) elapses, at which point the returned `Promise` **rejects**
  with a clear timeout error (`message` is appended when provided). Both the interval and timeout are
  overridable via the params. `WaitUntilParams` is exported from the main entry.

### Pending migration (consumer cleanup)

Replace the hand-rolled per-closure `waitUntil` loops with the injected `waitUntil` from the `lib` bag
(destructure `async fn({ app, lib: { waitUntil } }) { … }`). First consumers: `obsidian-advanced-note-composer`
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

Every `evalInObsidian` callback also gets a `pressKey(params: PressKeyParams)` helper as a **base**
member of the injected **`lib`** bag (alongside `typeIntoEditor` / the pointer trio / `waitUntil`),
typed on `Lib` (`src/eval-in-obsidian.ts`) and seeded into the base `lib` in the in-process namespace
(`namespace-bootstrap.ts`); see **L16**. Per **L6** it lives once on the Obsidian side, so Vitest / Jest / Manual
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

- **API shape** — `pressKey({ key, modifiers? })`, matching every other `lib` helper (params
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

## L15. Process visibility — integration tests hidden; off-screen, never minimize

Three granular booleans live on the transport options and are resolved by the pure, unit-tested `src/visibility.ts` (the
launchers themselves — factory / CDP transport / `obsidian-instance` — are `v8 ignore` integration
glue, so the `@default false` resolution is extracted there to stay testable, mirroring
`appium-session-config.ts`):

- **`isObsidianAppVisible`** (`obsidian-cdp`, owned mode only; default `true`). Integration setup explicitly sets it to `false`. When hidden, the owned instance is
  launched with `OWNED_HIDDEN_LAUNCH_FLAGS` and, once Electron's remote bridge is up (~4.4s),
  `DesktopCdpTransport.moveOwnedWindowOffscreen` moves the window beyond all displays via
  `window.electron.remote.getCurrentWindow().setPosition(...)`. Best-effort (warn, don't throw).
  Attach mode never moves the user's window.
- **`isEmulatorVisible`** → `buildEmulatorArgs({ isHidden })` appends `-no-window` (headless emulator).
- **`isAppiumConsoleVisible`** → `startAppiumServer` spawns with `windowsHide` and discards output; set it to `true` to surface both the console and live logs for debugging.

**Off-screen, NOT minimize — this is the crux (empirically established, see the auto-memory
`reference_obsidian_background_window_throttling`).** A *minimized* Chromium renderer freezes
`requestAnimationFrame` (0/s) regardless of any flag (no surface to composite) and inflates CDP command
latency ~3×; the keep-alive flags rescue `setTimeout` but cannot rescue rAF. An **off-screen** window
stays `visibilityState: 'visible'` to Chromium, so timers, rAF, `:hover`, and trusted input all behave
exactly as when visible. Hence hide = move off-screen (+ `--disable-features=CalculateNativeWinOcclusion`
and the backgrounding-disable flags so a covered/long-running off-screen window is never throttled),
never `win.minimize()` / `win.hide()`. Confirmed via the real transport: hidden → `screenX` beyond the
display, `visibility: visible`, rAF ~60/s; regression-tested in `connect-to-cdp.integration.test.ts`.

**Honest limit (not solvable from outside):** Obsidian's own process shows and focuses the window at
launch, so there is a brief (~1–2 s) flash before it is moved off-screen. The persistent focus theft is
eliminated; the initial flash is not. Zero-flash would need Obsidian to launch hidden (a main-process
option the harness does not control) or a separate Win32/virtual desktop. Also: Electron's CDP does
**not** implement `Browser.getWindowForTarget`/`setWindowBounds`, and `--window-position`/`--window-size`
are ignored — window control must go through Electron remote (available only in a loaded vault window)
or OS-level Win32, which is why the move uses Electron remote.

## L16. Extensible, type-safe `lib` injection (register a whole library into every closure)

Every `evalInObsidian` callback receives a **`lib`** arg (on `CommonArgs`, `src/eval-in-obsidian.ts`)
— a single flat bag of shared closure helpers, so a serialized closure can call them
(`lib.typeIntoEditor({ editor, text })`, `lib.getFileOrNull({ app, … })`) instead of hand-rolling them
or reaching a `window` global. Two layers compose into it:

- a **base** the harness itself seeds — the renderer-driving helpers of L8/L11/L12/L14
  (`typeIntoEditor` / `pressKey` / `moveMouse` / `hoverElement` / `unhoverElement` / `waitUntil`), so
  `lib` is never empty and the harness stays self-contained (no dev-utils dependency; it tests them
  itself); and
- **provider additions** — a provider package `Object.assign`s its **whole real** renderer-safe library
  on top, so its functions (and any override of a base helper) win. Nothing dev-utils-owned is
  reimplemented here.

**Mechanism.**

- **Register (worker-side).** A provider calls `registerLibResolver(resolver)` (`src/lib-registry.ts`)
  from its per-worker test setup (`setupFiles`) — same worker-registration constraint as the context
  resolvers (**L9**), because the namespace bootstrap is generated per-worker. A `LibResolver` is a
  self-contained `(this: void) => object` that runs **in the renderer** and returns an object to merge;
  it is serialized via `toString()`, so it must not close over module scope — it reads a renderer global
  a fixture plugin published (e.g. `() => window.__obsidianDevUtilsModule__.__merged`). Registration is
  deduped by source text.
- **Bake + merge.** `ensureNamespaceBootstrapped` threads the registered resolvers into
  `bootstrapNamespace` (serialized as real function literals by the existing `json-with-functions`
  path). `evalWrapper` runs each resolver and `Object.assign`s the results into one `lib` bag added to
  `fullArgs`. The bag starts from the harness base helpers, then each provider merges on top (later
  wins); with no provider it is exactly the base. **Multiple providers compose** (runtime `Object.assign`).
- **Version gate.** `getBootstrapVersion` / `computeBootstrapVersion` fold the resolver sources into the
  `window.__obsidianIntegrationTesting.version` used for the bootstrap-skip check, so a changed resolver
  set (e.g. different test files sharing one owned instance) forces a re-bootstrap instead of leaking a
  stale `lib`.

**Type-safety (declaration merging, the `i18next` `CustomTypeOptions` idiom).** `interface Lib` declares
the base helpers and is **augmentable**: a provider does
`declare module 'obsidian-integration-testing' { interface Lib extends (typeof import('…')) {} }`.
Multiple augmentations merge (like the multiple `Object.assign`s at runtime). Cycle-safe: `lib` is a
live renderer object injected into `fullArgs` (never JSON-serialized — only `fn`'s return value is),
exactly like `app`, so a back-reference such as `lib.__namespaces` cannot cause a serialization cycle.

Per **L6** the mechanism reaches Vitest / Jest / Manual (it lives in the core namespace bootstrap +
registry). The intended first provider is `obsidian-dev-utils` exposing its whole library via a flat
`obsidian-dev-utils/__merged` barrel (see the Current Task hand-off).

## L17. Helpers Duplicated in `obsidian-dev-utils` — Keep In Sync By Hand

A set of harness helpers in `namespace-bootstrap.ts` are **intentionally copy-pasted** into
`obsidian-dev-utils`, which re-exposes them through its `__merged` surface so a closure's `lib` picks
up dev-utils' copies (they `Object.assign` over the harness base when the provider resolver is
registered) and so non-closure/production code can `import` them. The synced set (with its dev-utils
mirror module):

| Harness member (`namespace-bootstrap.ts`)                                        | dev-utils mirror module     |
|----------------------------------------------------------------------------------|-----------------------------|
| `typeIntoEditor`, `pressKey`, `moveMouse`, `hoverElement`, `unhoverElement`      | `desktop-trusted-input.ts`  |
| `ensureLayoutReady`                                                              | `workspace.ts`              |
| `errorToString`                                                                  | `error.ts`                  |

Notes on the set:

- **`pressKey` / `moveMouse` are synchronous (`void`)** — their bodies only inject trusted
  `sendInputEvent` calls, so both copies must keep the `void` signature (a `Promise<void>` on one side
  would break the `interface Lib extends typeof import('obsidian-dev-utils/__merged')` augmentation).
- **`moveMouseTo` was folded into `moveMouse`** (rounding + `sendInputEvent` inlined); `hoverElement` /
  `unhoverElement` call `moveMouse({ x, y })` directly. There is no separate `moveMouseTo` to sync.
- **`waitUntil` is NOT synced** — dev-utils reuses its own `retryWithTimeout` instead of duplicating a
  poll loop, and the harness keeps `waitUntil` as its own self-contained base helper (its integration
  suite depends on it).
- **`destroyCurrentWindow` / `ipcSendSync` are NOT synced** — they are transport/Electron-only harness
  primitives (see their `// intentionally not migrated` TSDoc in `namespace-bootstrap.ts`), not
  general-purpose utilities.

This deliberately reimplements logic that lives here rather than sharing one source — normally the
workspace never duplicates cross-library code — and is accepted for one reason: **dependency hygiene**.
Sharing a single source would force either the harness to depend on `obsidian-dev-utils`, or
`obsidian-dev-utils` to take a **runtime** dependency on this test harness (a utility library depending
on a test harness — backwards). Since dev-utils re-exports these as **values** through its shipped
`__merged` surface, that runtime edge is unavoidable under the shared-source approach; duplication keeps
both dependency graphs clean, at the cost of manual sync.

**Rule:** the implementations in `namespace-bootstrap.ts` (and `error-to-string.ts` for `errorToString`)
are the **canonical** copy. Any change to the behavior of a synced helper here MUST be mirrored in
`obsidian-dev-utils` in the same coordinated change, and vice versa. There is **no automated drift
check** — a deliberately accepted risk (the alternative `.toString()`-equality test was declined); sync
is by discipline alone. `obsidian-dev-utils` carries the mirror-image local rule (its own L18) pointing
back here. When you touch any synced helper, update both copies. (Honest note: for serialized closures this
duplication yields no functional gain — the harness base already injects the trusted-input helpers; the
dev-utils copy exists so non-closure/production code can `import` them.)

## L18. Dead-boot fast-fail (`RendererFailedToInitializeError`)

When a pinned app version cannot run on the launched Electron shell (an `obsidianInstallerVersion` too old
for the `obsidianVersion` — e.g. the 1.12.7 asar on the 0.14.5 / Electron 18.0.3 shell), the owned
renderer loads `index.html` (`document.readyState` reaches `complete`) but the app never bootstraps:
`document.body` stays empty and `window.app` remains `undefined` (a black screen). Without detection,
`waitForOwnedVaultReady` cannot tell this terminal state from "still loading" and burns the whole readiness
timeout before throwing a generic error.

- **Pure detector** — `src/renderer-boot-detection.ts` (unit-tested, not re-exported):
  `checkRendererBootState({ bodyChildElementCount, hasGraceElapsed, hasWindowApp, isDocumentComplete }) →
  'dead' | 'pending'`. Dead ⇔ the grace has elapsed AND `window.app` is undefined AND the document is
  `complete` AND `<body>` is empty. This is exactly the confirmed incompatible-shell state and is
  **unreachable by a healthy boot** (`window.app` is defined early; a slow boot renders a non-empty
  loading shell), so there is no false-positive path. `resolveDeadBootGraceInMilliseconds` resolves the
  option (`@default 10000`, `0` disables).
- **Deliberately DOM-only.** The plan floated an `Runtime.exceptionThrown` heuristic; it was **dropped** —
  the DOM grace-window signal is deterministic and matches the repro, whereas a live exception monitor
  risks false-positives (a benign startup exception on a genuinely slow boot) and would ship a
  perpetually-`false` wired input. Recorded here so the omission is not mistaken for an oversight.
- **Distinct error** — `RendererFailedToInitializeError` (`renderer-failed-to-initialize-error.ts`, **is**
  exported from the barrel) so callers can `instanceof`-match this specific failure vs a generic readiness
  timeout.
- **Largely superseded proactively (see L21).** For a *table-known* below-floor combo, L21's proactive
  compatibility check now throws `IncompatibleInstallerVersionError` from `resolveOwnedInstanceConfig`
  **before** launch, so this reactive dead-boot fast-fail remains only the **safety net** for combos the
  table cannot preempt (an undetectable Linux shell version → `'unknown'`, or an app version absent from
  `metadata.json`). Its pure `checkRendererBootState` keeps its unit coverage; there is no longer a
  dead-boot *integration* test (no clean out-of-table combo triggers it without the proactive throw firing
  first).
- **Wiring** — `DesktopCdpTransport.waitForOwnedVaultReady` (owned path only) probes
  `probeRendererBootState()` each poll iteration; the grace clock starts when the renderer first reports
  `complete` (a loop-local `documentCompleteSince`), and it throws `RendererFailedToInitializeError` on a
  `dead` verdict. The knob rides the existing options channel:
  `ObsidianCdpTransportOptions.deadBootGraceInMilliseconds` → factory
  `resolveDeadBootGraceInMilliseconds` → transport config field; also on `ConnectToCdpOptions`. Attach mode
  is unaffected (it targets an already-alive instance).
- **Not covered by this fast-fail:** on a *hidden* owned dead boot, `moveOwnedWindowOffscreen` still burns
  its full ~20s poll because the Electron remote bridge never comes up — a separate, smaller waste. And
  see L15's honest limit: the launch-time flash is unrelated.

## L19. Android integration performance — cold-cost breakdown & optimization levers (reference)

Durable performance knowledge, **not** a task (migrated 2026-07-12 from a central task entry that was
really a bundle of profiling findings + future ideas). All the *code* levers here already shipped; the
remaining levers are provisioning options the user may enable, not pending code work.

### Where the 140–200s cold Android cost goes (profiled 2026-07-11 on the real WHPX emulator)

Measured breakdown (see also the auto-memory `reference_android_appium_cold_cost_breakdown`):

- **Emulator cold boot ≈ 112s** — ~32s start→device-online + ~80s device-online→`sys.boot_completed`.
  Pure boot cost, entirely avoided by a warm/snapshotted guest.
- **Session `remote()` — the headline "140–200s" is session-DURING-post-boot-churn, not the session
  itself.** `sys.boot_completed=1` fires **before** the guest is idle (package optimization / services
  still churning), so UiAutomator2's ~40 serialized `adb`/instrumentation round-trips each contend and
  inflate ~25–50× (an `adb cmd package list packages` at boot-complete took ~50s vs ~1–2s idle). Let the
  guest settle and cold `remote()` drops to ~27–53s (vs ~29s fully warm). The ~40 round-trips live inside
  the driver and are not harness-controllable per-call — the win is to stop paying the cold/contended
  multiplier.
- **Appium server cold-start — real but secondary.** `/status` ready ~13.5s warm, of which ~8.7s is
  loading the UiAutomator2 driver's node modules; cold disk + release-time memory pressure pushed it past
  the old 60s cliff. (`npx appium` re-install was **ruled out** — it resolves to the global install, no
  redownload.)
- **Per-step (cold, idle):** `registerVault` marker push originally 9–21s for a 2-byte file;
  `getContexts` / `switchContext` ~17s each; `waitForLayoutReady` ~1s (never the real bottleneck — even
  under 12-core + disk + memory stress it only reached ~8.4s).

### Landed code mitigations (all shipped)

- **Boot-idle gate** — `src/device-readiness.ts` (`checkDeviceIdle`: idle ⇔ `init.svc.bootanim==stopped`
  **and** `cmd package list packages` lists ≥1 package; `resolveDeviceIdleTimeoutInMilliseconds`,
  `@default 60000`). After `sys.boot_completed`, `waitForNewDevice` waits for idle before `remote()` runs,
  so the session executes against an idle guest. Best-effort (warns + proceeds on timeout; `0` skips).
  Option `deviceIdleTimeoutInMilliseconds`. Probes return `''` on adb timeout so a slow/partial
  `package list` can't falsely read as idle.
- **Configurable timeouts** (all raised/threaded with per-poll elapsed logging, resolved via the testable
  `appium-session-config.ts`): `appiumStartTimeoutInMilliseconds` (`@default 180000`),
  `sessionConnectionRetryTimeoutInMilliseconds` (`@default 180000`), `layoutReadyTimeoutInMilliseconds`
  (`@default 90000`). Headroom for the starved/CI regime — not root causes.
- **`registerVault` marker push via `adb`** instead of `browser.pushFile` — measured cold marker 9–21s →
  ~2.5s, total `registerVault` ~10–24s → ~5.6–7.8s (3–4×). The one measured, unconditional win.
- **Crash/ANR dialog suppression** — see **L13**. **Process visibility (off-screen, never minimize)** —
  see **L15**.

### Remaining optimization levers (provisioning, user-owned — NOT code)

In descending value:

1. **Warm/snapshot emulator reuse** (biggest single chunk — eliminates the ~112s boot). `emulator-args.ts`
   passes `-no-snapshot-save`, so a fresh CI AVD full-cold-boots every run. Making snapshot load+save an
   opt-in option would let a persistent runner warm-boot — but it changes test-isolation/hermeticity, so
   the default must stay cold; this is a deliberate user tradeoff, not a default change.
2. **Persistent Appium server across runs** — already reused if reachable; just don't kill it per run in
   the release environment.
3. **Pre-provision chromedriver + uiautomator2 driver** in the CI image (already present locally).

### Honest limit

The residual cold cost is dominated by emulator provisioning / host contention (**L13**), which code can
only be made **resilient** to (the idle-gate), not eliminate. On this fast WHPX host the without-gate
session isn't as slow as a starved release env sees, so the gate's headline speedup is confidence-based
for the slow/CI regime; the round-trip-inflation mechanism it fixes is directly measured. The exact
`30000ms`→`90000ms` layout trip was never reproduced here — to close it definitively, capture a real
failing trace during an actual release (the per-poll elapsed logging pinpoints layout-slowdown vs
command-latency burst vs session establishment).

## L20. `metadata.json` — per-version installer-floor table (`minRunnableInstallerVersion`)

Repo-root `metadata.json` is a per-Obsidian-desktop-version data table (one `"x.y.z"` key per release):
`channel`, optional `available`, `changelogUrl`, and installer/Electron compatibility knobs. It is a
**data table** consumed by `src/obsidian-metadata.ts` (the sole reader; see L21): the whole table is
injected as the `OBSIDIAN_METADATA` global — esbuild's `define` inlines it into the build (the built
library stays self-contained, no runtime file read), the unit-test project uses Vitest's `define`, and the
integration-test projects set it via the `scripts/vitest-metadata-setup.ts` setup-file global. The usual
format/lint/spellcheck gates apply. Two installer-floor fields:

- **`minRunnableInstallerVersion`** — the tier-1 **boot floor**: the oldest installer (Electron shell) on
  which that app version's asar actually runs (renders a real UI — a loaded vault, or the first-run vault
  picker when old Obsidian ignores the pre-seeded `obsidian.json` auto-open); below it the renderer
  dead-boots (see L18) **or silently falls back to the installer's bundled asar** (see the caveat below).
  It is **empirically measured** (boot the (asar, installer) pairs and detect boot-vs-dead) and is much
  lower than the recommended min — e.g. `1.13.1` runs on the `1.1.9` shell (Electron 18), far below its
  recommended `1.6.5`. Distinct floors: `0.6.4` for apps `0.6.4`–`1.2.8`, `0.14.5` for `1.3.0`–`1.5.2`,
  `1.1.9` for `1.5.3`–`1.12.7` **and** `1.13.1`, but **`1.6.5` for `1.13.0`** (a genuine non-monotonic
  exception — see the caveat); apps older than `0.6.4` are left unset (no older installer exists to run
  them — asar-swap is upgrade-only, so an app needs an installer ≤ itself).
- **`minRecommendedInstallerVersion`** — the tier-2 recommended min (Obsidian's own guidance); equals
  `wdio-obsidian-service`'s `minInstallerVersion` (52/52 agreement).

**Silent-fallback caveat (`1.13.0`; corrected 2026-07-13 via CDP —
[wdio-obsidian-service#78](https://github.com/jesse-r-s-hines/wdio-obsidian-service/issues/78)).** The
boot-floor measurement detects only *"a UI rendered"*, **not** *"the requested asar version is running"* —
and on an installer below the floor, some app versions **silently fall back to the installer's own bundled
asar** (Obsidian loads the newer asar, it fails to run, and it reverts to the bundled one) instead of
dead-booting. That renders a healthy UI of the *older* app, which the detector reads as a false-positive
"runnable". `1.13.0` on installer `1.1.9` does exactly this — verified over CDP that `obsidianModule.apiVersion`
reports `1.1.9`, not `1.13.0` (whereas on installer `1.6.5` it reports `1.13.0`), so `1.13.0`'s real floor is
`1.6.5`, not the `1.1.9` first recorded (now fixed in `metadata.json`). `1.13.1` genuinely runs on `1.1.9`
(`apiVersion` `1.13.1`) — a real non-monotonic breakpoint, which the maintainer's independent bisect also
found. **Discriminators:** `obsidianModule.apiVersion` = the running asar (app) version;
`window.electron.remote.app.getVersion()` = the installer/shell version. Hardening the boot-floor measurement
to assert the running `apiVersion` matches the requested version (so silent fallbacks are caught, not just
dead boots) is a tracked follow-up.

Range summary (per-version data in `metadata.json` is the source of truth; the recommended column is
filled from `obsidian-versions.json` for completeness — it matches our recorded values 52/52). `—` = not
determined (no asar in the source folder, or not recorded upstream):

| App-version range | `minRunnableInstallerVersion` | `minRecommendedInstallerVersion` |
| --- | --- | --- |
| `0.0.1`–`0.6.3` | — | — |
| `0.6.4`–`0.7.3` | `0.6.4` | `0.6.4` |
| `0.7.4`–`0.13.3` | `0.6.4` | `0.7.4` |
| `0.13.4`–`0.15.6` | `0.6.4` | `0.11.0` |
| `0.15.7`–`1.2.8` | `0.6.4` | `0.14.5` |
| `1.3.0`–`1.4.12` | `0.14.5` | `1.1.9` |
| `1.4.13`–`1.4.14` | `0.14.5` | `1.4.5` |
| `1.4.15`–`1.5.2` | `0.14.5` | `1.4.13` |
| `1.5.3`–`1.8.1` | `1.1.9` | `1.4.13` |
| `1.8.2`–`1.12.7` | `1.1.9` | `1.5.8` |
| `1.13.0` | `1.6.5` | `1.6.5` |
| `1.13.1` | `1.1.9` | `1.6.5` |

## L21. Proactive installer↔app compatibility (`IncompatibleInstallerVersionError` + verdict-as-data)

`resolveOwnedInstanceConfig` (`transport-factory.ts`, owned path only) resolves the concrete (app asar,
installer shell) version pair and runs a **proactive** compatibility check from `metadata.json` (L20)
*before* any download or launch — an actionable error for an unrunnable pin, a warning for a
below-recommended one, and a machine-readable verdict on the result. It supersedes L18's reactive
dead-boot for table-known combos (see the L18 cross-reference).

- **Pure verdict** — `src/installer-compatibility.ts` (unit-tested; mirrors the `renderer-boot-detection`
  pure/glue split): `checkInstallerCompatibility({ appVersion, installerVersion, metadata }) →
  InstallerCompatibility` with `tier: 'ok' | 'nagged' | 'unrunnable' | 'unknown'`. `unrunnable` ⇔ installer
  `<` `minRunnableInstallerVersion`; `nagged` ⇔ `≥` run floor but `<` `minRecommendedInstallerVersion` (old
  versions only); `unknown` ⇔ installer version undefined (undetectable Linux shell) or app absent from the
  table. Pure `x.y.z` compares (reuses `compareVersions`) — no I/O.
- **Distinct error** — `IncompatibleInstallerVersionError`
  (`incompatible-installer-version-error.ts`, exported from the barrel) carries `appVersion` /
  `installerVersion` / `minRunnableInstallerVersion` and a message naming the installer that would work.
  Thrown from `resolveOwnedInstanceConfig` via the `checkAndReportCompatibility` helper on `'unrunnable'`;
  `'nagged'` logs a warning via the warn-don't-throw `log()` channel; `'ok'`/`'unknown'` are silent.
- **Fail-fast ordering** — the check runs only for the asar-swap-onto-shell case (the only dead-boot risk;
  the downgrade / own-installer paths run the app's own installer, so they always boot and are not checked).
  Concrete versions are resolved and the pinned shell's installed-shell detection is **deferred** so an
  `'unrunnable'` pin throws before `ensureShellCached`/`ensureAsarCached` — no download, no launch (the
  `installer-compatibility.integration.test.ts` proactive test asserts exactly this, in milliseconds).
- **Verdict as data** — a non-throwing verdict rides on `OwnedInstanceConfig.compatibility`, surfaced by
  `DesktopCdpTransport.getCompatibility()` and on `CdpConnection.compatibility` (populated in
  `connectToCdp`). An `'unrunnable'` verdict never reaches the data surface — it throws first.
- **Table access** — `src/obsidian-metadata.ts` is the sole reader of `metadata.json` (see L20 for how the
  `OBSIDIAN_METADATA` global is injected), exposing `getVersionMetadata(version)` / `ObsidianVersionMetadata`.
- **Deferred (follow-up tasks):** (a) the tier-2 **runtime** nag — reading live `process.versions.electron`
  post-boot vs `minRecommendedElectronVersion` — **now landed, see L23**; (b) an **option knob** to
  silence/tune the warnings (and optionally disable the proactive throw, which would let L18's dead-boot path
  be integration-tested again).

## L22. Auto-install Appium dependencies before auto-starting the server

The harness auto-starts the Appium server via `npx appium`, which assumes both Appium **and** the
`uiautomator2` driver are already installed — a missing driver was a common first-run failure (the exact
scenario that motivated this: `npx --no-install appium --version` exits non-zero on a machine with no
global Appium). `startAppiumAndEmulator` now closes that gap: when it is about to auto-start the server
(`needsAppiumStart`) **and** `shouldAutoInstallAppiumDependencies` (`@default true`) is set, it runs
`AppiumTransportFactory.ensureAppiumDependencies` first — check-then-install for each of Appium
(`npm install -g appium`, global, matching the `npx appium` resolution — see the auto-memory
`reference_android_appium_cold_cost_breakdown`) and the driver (`appium driver install uiautomator2`).

- **Gated on auto-start only.** If the server is already reachable, or `shouldAutoStartAppium: false`
  (user manages their own server), nothing is checked or installed — the machine-mutating global install
  never fires behind the user's back. `shouldAutoInstallAppiumDependencies: false` is the explicit opt-out
  even when the harness does auto-start.
- **Check-then-install, so a provisioned machine pays only two fast probes** — `npx --no-install appium
  --version` and `npx --no-install appium driver list --installed --json`. `--no-install` prevents the
  detection probes from themselves triggering an npx download.
- **Pure/testable split** mirrors `device-readiness.ts` / `appium-session-config.ts`: `src/appium-dependencies.ts`
  holds `checkIsAppiumDriverInstalled` (parses the `--json` driver list; key-presence ⇔ installed, malformed
  output ⇒ not-installed so the caller installs) and `resolveShouldAutoInstallAppiumDependencies`
  (`@default true`), both unit-tested in `appium-dependencies.test.ts`. The `exec` orchestration stays in the
  `v8 ignore` factory.
- **Windows:** the install/probe commands are passed to `exec` as **strings**, not arrays, so `exec` routes
  them through the shell — required to resolve the `npm`/`npx` `.cmd` shims (the array path spawns without a
  shell and would `ENOENT`). This differs from the `adb`/`tar` calls, which are real `.exe` on PATH.
- Supersedes L19 lever #3 ("pre-provision … driver") for the local/first-run case — provisioning it into a
  CI image is still the faster path when you control the image, but the harness no longer *requires* it.

## L23. Tier-2 runtime Electron nag (`checkElectronCompatibility` + verdict-as-data)

The runtime companion to L21's offline installer check — deferred item (a) from that section (the parent task
that shipped L20/L21). L21 compares the resolved **installer** version against installer-version thresholds
entirely offline. But the app's real requirement is a **minimum Electron version** hardcoded inside `app.js`
(e.g. `1.13.1` needs Electron `28.2.3`), and the installer's bundled Electron is not derivable offline (see
`ObsidianVersionMetadata.minRecommendedElectronVersion`, L20). So this tier reads the **live** Electron the
owned instance is actually running, post-boot, and warns when it is below the app's recommended minimum. It
never blocks (an old Electron runs but nags) — there is no error tier here, unlike L21's `'unrunnable'`.

- **Pure verdict** — `src/electron-compatibility.ts` (unit-tested; mirrors `installer-compatibility.ts`):
  `checkElectronCompatibility({ appVersion, actualElectronVersion, metadata }) → ElectronCompatibility` with
  `tier: 'nagged' | 'ok' | 'unknown'`. `nagged` ⇔ `actualElectronVersion < minRecommendedElectronVersion`;
  `unknown` ⇔ the live version was unreadable or the app version carries no recommended Electron in the table.
  Pure `x.y.z` compares (reuses `compareVersions`) — no I/O. `minRecommendedElectronVersion` is keyed by **app**
  version and is already fully populated in `metadata.json` (L20); this tier consumes it, nothing new is added.
- **Post-boot glue** — `DesktopCdpTransport.checkRuntimeElectronCompatibility` runs in the success branch of
  `waitForOwnedVaultReady` (**owned path only** — attach mode targets the user's own live instance). It reads
  two values from the booted renderer via raw `evaluate`: the running **app** version from the main process via
  `window.electron.ipcRenderer.sendSync('version')` (the same IPC channel `namespace-bootstrap`'s `ipcSendSync`
  uses), and the live Electron via `process.versions.electron`. Both are top-level reads. **Do NOT use
  `require('obsidian').apiVersion`** (only resolves inside a plugin-load context — needs CodeScript Toolkit)
  **nor `getObsidianModule()`** (its plugin-load `require('obsidian')` trick returns "Failed to load obsidian
  module" in a plain owned instance) — both were confirmed to fail there; `ipcRenderer.sendSync('version')`
  returns the correct app version (and tracks the swapped asar version, not the shell — verified: local asar
  `1.13.2` on shell `1.12.7` returns `1.13.2`). The read is **best-effort** (own try/catch, warn-don't-throw):
  a failure logs and leaves the verdict `undefined`, never breaking an otherwise-ready boot. On `'nagged'` it
  logs via the same `log()` channel as L21's installer nag.
- **Verdict as data** (mirrors L21 item D) — the verdict rides on `DesktopCdpTransport.getElectronCompatibility()`
  and `CdpConnection.electronCompatibility` (populated in `connectToCdp`), so a consumer / integration test can
  assert on it rather than spying on `console.warn` (the repo has no warn-spy precedent). It is a **separate**
  accessor from L21's `getCompatibility()` because it is only known post-boot, whereas the installer verdict is
  resolved pre-launch and rides on the immutable `OwnedInstanceConfig`.
- **Barrel** — `checkElectronCompatibility` + `CheckElectronCompatibilityParams` / `ElectronCompatibility` /
  `ElectronCompatibilityTier` are exported from the main entry.
- **No option knob here** — silencing/tuning the warning is L21's deferred item (b), a separate task; like the
  installer `'nagged'` warning, this one always warns until that lands.
- **Integration test** — `src/electron-compatibility.integration.test.ts` boots a real nag-band pair
  (app `1.13.1` on the `1.1.9` installer shell → live Electron 18 `< 28.2.3` → `'nagged'`) and asserts the
  surfaced `electronCompatibility`. Like the other download-and-boot suites it is opt-in via
  `OBSIDIAN_TEST_ELECTRON_NAG=1`.
