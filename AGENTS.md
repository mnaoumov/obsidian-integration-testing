# Project: obsidian-integration-testing

A library that provides helpers for integration testing Obsidian plugins against an Obsidian instance. On desktop it launches and owns an isolated Obsidian instance by default (it can also attach to a running one); on Android it drives Obsidian Mobile via Appium.

## L1. Architecture

The package exports these entry points:

All entry points are under the `obsidian-integration-testing` package; `…/` below abbreviates that prefix.

| Entry point | Purpose |
| --- | --- |
| `obsidian-integration-testing` | Main — `evalInObsidian`, `connectToCdp`, `ContextId`, `TemporaryVault`, transports, types |
| `…/vitest-global-setup-plugin` | Vitest global `setup`/`teardown` + `getTemporaryVault()` — **installs & enables** the built plugin |
| `…/vitest-global-setup-no-plugin` | Vitest global `setup`/`teardown` + `getTemporaryVault()` — **empty vault**, for non-plugin consumers |
| `…/vitest-setup` | Vitest **per-worker** `setupFiles` entry — registers the context resolvers |
| `…/vitest/typings` | Opt-in Vitest module augmentations (`ProvidedContext`, `EnvironmentOptions`) |
| `…/jest-global-setup-plugin` | Jest global setup (default + named) — **installs & enables** the built plugin |
| `…/jest-global-setup-no-plugin` | Jest global setup (default + named) — **empty vault**, for non-plugin consumers |
| `…/jest-global-teardown-plugin` | Jest global teardown (default export) for the plugin setup — separate module Jest requires |
| `…/jest-global-teardown-no-plugin` | Jest global teardown (default export) for the no-plugin setup — separate module Jest requires |
| `…/jest-setup` | Jest **per-worker** `setupFiles` entry — registers the context resolvers |

Framework-agnostic core logic lives in `src/global-setup-core.ts`. Framework adapters (`src/vitest/`, `src/jest/`) are thin wrappers that delegate to the core and bridge context to test workers using framework-native mechanisms (vitest `inject`/`provide`, jest `globalThis`).

Internal modules (`exec`, `function-expression`, `json-with-functions`, `type-guards`, `obsidian-config`, `obsidian-version`, `obsidian-version-switch`, `obsidian-installer`, `installer-asset`, `obsidian-instance`, `kill-process-tree`, `renderer-boot-detection`, `compatibility-options`, `leftover-cleanup`) are not re-exported. `RendererFailedToInitializeError` (`renderer-failed-to-initialize-error.ts`) **is** exported — see L18.

The desktop owned-instance lifecycle lives in `transport-desktop-cdp.ts` (mode: own vs. attach), with `obsidian-instance.ts` (launch + free port + kill), `obsidian-version*.ts` (asar version resolution/download/cache), and `obsidian-installer.ts` (shell version detect/download/extract — it resolves the installer asset by querying the release's real asset list via the GitHub API and picking the platform-correct name with the pure, unit-tested `installer-asset.ts`, tolerating the historical dot-vs-hyphen separator rename, with a both-separator templated fallback when the API is unavailable). `transport-factory.ts` resolves the owned-instance config (shell exe + asar + temp user-data dir) from the version knobs.

## L2. Build

- `npm run build` — clean, type-check, build ESM+CJS via esbuild, emit `.d.mts`/`.d.cts` declarations.
- Output lands in `dist/lib/esm/` and `dist/lib/cjs/`.
- `src/index.ts` is the manually maintained barrel file — **nothing generates it**, so adding a public name means editing it **in the same change**. It is also the definition of "public" for the API reference (**L35**): a name is documented iff it is re-exported there. A name left out therefore ships both undocumented and unnameable by consumers, even when the signature that uses it is public — which is exactly what happened to `ClickElementParams` / `ClickMouseParams` (added in `0877618`, exported only later). `src/public-api-barrel.test.ts` guards this in **both** directions: outward, every type a re-exported signature mentions must itself be re-exported; inward, every `src/` module must be reachable from something the package actually ships — the barrel, an `exports` subpath, a `bin` shim, or a test file. Its roots are derived from `package.json`, never listed in the test, so a new subpath is covered by construction rather than by remembering. The inward half was added by T812 and was red on two modules the moment it existed: `obsidian-namespace.ts`, a hand-written mirror of the `__obsidianIntegrationTesting` shape that was **never once** re-exported (`git log -S` on the barrel returns nothing) and had already drifted from the object it mirrored, and `native-dialog-monitor.ts`, orphaned when `d65aa6a` retired its only caller. Both were deleted. **There is deliberately no exported mirror of the namespace shape:** every site that touches it declares its own local holder interface (`src/context-id.ts`, `src/enable-plugin.ts`, `src/namespace-bootstrap.ts`) — which is what their *"intentionally kept local (not declared globally) to avoid leaking into consumer types"* disables say — and `obsidian-dev-utils` declares the `trustedInput` shape locally for the same reason (**L39**). Re-adding a public mirror would recreate a type nothing type-checks against, which is precisely how the deleted one drifted unnoticed.
- `npm run docs:build` — the Astro + Starlight documentation site under `docs/` (**L35**), built and deployed separately from the library.

## L3. Testing

- Unit tests: `npm run test` (Vitest, `--project unit-tests --project unit-tests:scripts` — the first covers `src/**`, the second everything under `scripts/**` plus the docs site: the vendored docs generator (**L35**), the custom ESLint rules (**L34**), and the release-script helpers (**L37**)). The second project's include was `scripts/docs-gen/**/*.test.ts` until T813-P2 widened it to `scripts/**/*.test.ts`; the narrow glob had left `scripts/helpers/eslint-rules/*.test.ts` — four real suites, 87 tests, all green the moment they were picked up — run by no project at all, and left the release script with nowhere to put a regression test at all. A test file under `scripts/` is now picked up by construction rather than by remembering to widen a glob.
- Integration tests: `npm run test:integration` (desktop requires Obsidian installed — the harness launches its own isolated instance; no CLI or running instance needed). Runs five projects: `integration-tests` (each suite registers its vault in-worker); `integration-tests:owned-attach` (the L9 regression suite: the global setup owns the instance and the worker **attaches** — its own `globalSetup` writes a fixture plugin into `dist/dev` and wires `vitest-setup` into `setupFiles`); `integration-tests:bare-attach` (the plugin-less counterpart — it points straight at `src/vitest/global-setup-no-plugin.ts`, the same subpath a non-plugin consumer uses, so `createSetup({ installPlugin: false })` is exercised end-to-end); `integration-tests:enable-community-plugins` (its global setup seeds a demo vault with two dummy plugins via `buildDemoVaultPopulate`, enables them through `createSetup({ enableCommunityPlugins })`, and the worker asserts both loaded); and `integration-tests:failed-setup` (the T726 regression suite — its global setup is wired to FAIL by attaching to a CDP port nothing serves, and the worker asserts it fails with that cause rather than falling back to a transport nobody asked for; hermetic, launches nothing, ~3 s).
- Coverage: `npm run test:coverage` — requires 100% on all metrics. It runs **`unit-tests` alone** (`scripts/test-coverage.ts` passes `--project unit-tests`), so anything wrong with that one project's configuration is a release-gate failure: the gate is a step of `updateVersion`'s preflight (**L37**) and P2 publishes only through Trusted Publisher, with no manual route around a red run.
- **Every Vitest project takes its `testTimeout` from the shared `SHARED_TEST_DEFAULTS` spread** in `scripts/vitest-config.ts`, not from its own line. Vitest 4 projects do **not** inherit the root-level `test` options, so a project that omits `testTimeout` silently runs on the built-in 5000 ms default — and that is exactly what `unit-tests` did until T765, making it the tightest budget in the repo on the one project gating a release. Spreading the default makes the omission impossible rather than merely unlikely; add a project and it is budgeted by construction. The 30 s budget absorbs two costs no per-suite number can predict: v8 coverage instrumentation, **measured at ~2.2x** on this project (whole run 4.8–5.9 s plain vs 9.6–11.0 s instrumented — *not* the ~10x the T765 report first assumed), and the CPU contention of a box running many concurrent sessions. Only two deliberate overrides sit on top of it: `src/public-api-barrel.test.ts`'s own 120 s (its ts-morph `Project` over the whole `tsconfig.json` measures ~9.5 s instrumented, too close to 30 s under load), and the Android project's 300 s (an emulator run is 140–200 s cold, **L19**).
- Cross-platform CI validation (manual `workflow_dispatch`, since each run downloads a multi-hundred-MB asset): `.github/workflows/validate-installer-path.yml` validates installer download+extract on ubuntu/macos/windows (opt-in via `OBSIDIAN_TEST_INSTALLER_DOWNLOAD=1`); `.github/workflows/validate-installer-boot.yml` validates the owned-instance **boot** from a pinned installer (`OBSIDIAN_TEST_INSTALLER_BOOT=1`, launches Electron under `xvfb` + `--no-sandbox` on Linux) and, in a Linux-only step, the asar-swap version-pin regression (`OBSIDIAN_TEST_ASAR_SWAP=1` — symlinks a newer cached shell under a versionless dir on `PATH` so shell-version detection returns `undefined`, then asserts an older pinned `obsidianVersion` actually runs). Both pass `GITHUB_TOKEN` so the release-asset API isn't rate-limited to the anonymous quota (which 403s on shared runner IPs → templated-name fallback). A third workflow, `.github/workflows/collect-runtime-versions.yml`, runs the same boot path on a **schedule** rather than on demand — it is the automation that keeps `metadata.json`'s `runtimeVersions` current (see **L20**), and unlike the two validators it commits its result.

## L4. Peer dependencies

Consumers must have `obsidian`, `type-fest`, and their test framework (`vitest` or `jest`) installed.

## L5. Transport configuration

Transport is configured via the framework adapter's config mechanism. The discriminated union `ObsidianTransportOptions` (`type: 'obsidian-cdp' | 'obsidian-android-appium'`) drives which transport the globalSetup creates; `obsidian-cdp` is the default when omitted. Vitest uses `environmentOptions.obsidianTransport`; Jest uses `globalThis.__obsidianIntegrationTesting.transportOptions`. Other frameworks can register a custom resolver via `setTransportOptionsResolver()`.

Desktop (`obsidian-cdp`) defaults to a **harness-owned, isolated instance** (temp `--user-data-dir` + free CDP port; never touches user-scope Obsidian). Set `port` to **attach** to a running Obsidian instead. `obsidianVersion` (asar) and `obsidianInstallerVersion` (shell) pin the version — each accepts `x.y.z` / `public-latest` / `catalyst-latest`; asar swap is upgrade-only vs. the shell, so older versions auto-use the matching installer (downloads/extracts via 7-Zip on Windows). Version resolution is **install-free when `obsidianInstallerVersion` is pinned** (the shell comes from the pin, so no locally-installed Obsidian is required — e.g. CI); an `obsidianVersion` is applied by **asar-swap only when the shell version is known AND the asar is ≥ it**, otherwise (older asar, or an undetectable shell version — the Linux `detectInstalledShellVersion` path-parse miss) the pinned version's own installer shell is used so the pin is always honored. `shouldDisableSandbox` (default `false`) appends `--no-sandbox` to boot an owned instance on Linux without a configured setuid `chrome-sandbox` helper (CI, or an extracted portable shell); harmless on Windows/macOS. All these knobs ride the existing `transportOptions` channel, so all three consumption paths get them with no adapter change.

**Config folder override:** `configDirectory` (default `undefined` = Obsidian's `.obsidian`) opens a vault whose settings live elsewhere, e.g. `.obsidian-desktop`. Obsidian stores that override as the `<vaultId>-config` **`localStorage`** entry and reads it once, in the vault's own renderer, during `Vault.setup` — so it cannot be written into the vault's window, and it is scoped to a user-data dir, which means an owned instance's fresh temp one inherits nothing from the user's Obsidian. Setting it therefore changes the owned boot: `buildOwnedObsidianJson` withholds **both** auto-open markers (`shouldAutoOpenVault: false`), the instance comes up on the **starter screen** — which has `localStorage` and `window.electron.ipcRenderer` but no `app`, hence raw CDP rather than the namespace helpers — the key is written there, and the vault is then opened over the `vault-open` IPC, which reuses the harness-generated id rather than minting a new one (so the key name is knowable before launch). The name is validated up front (`assertValidConfigDirectory`: dot-prefixed, not the bare dot, no path separator), and after boot the live `app.vault.configDir` is read back; a mismatch throws `ConfigDirectoryFallbackError` with **no** opt-out knob, because `setConfigDir` substitutes `.obsidian` silently and a vault opened against the wrong config folder is silently the wrong vault. Ignored in attach mode. Rides `transportOptions` like the other knobs.

**Process visibility (see L15):** owned desktop Obsidian defaults to visible (`isObsidianAppVisible: true`), while integration setup explicitly passes `false` so test runs do not steal focus. Android surfaces remain hidden by default: `isEmulatorVisible` (emulator `-no-window`) and `isAppiumConsoleVisible` (Appium spawn `windowsHide` with discarded output). Like the version knobs they ride the `transportOptions` channel (no adapter change).

## L6. Framework parity (Vitest / Jest / Manual)

Every setup capability must reach **all three** consumption paths, never just one:

- **Core (`src/global-setup-core.ts`)** — the framework-agnostic primitive. New setup behavior is implemented here first, exposed via `CoreSetupParams` / `CoreSetupResult`, so the **Manual** path (consumers wiring `TemporaryVault` / the core directly) gets it for free.
- **Vitest adapter (`src/vitest/global-setup.ts`)** — threads the capability through `createSetup(options)` and keeps the plain `setup` / `teardown` exports as the default (`createSetup()`) case.
- **Jest adapter (`src/jest/global-setup.ts`)** — mirrors the Vitest adapter exactly: same `createSetup(options)` factory shape, same `CreateSetupOptions` fields (including thunk-vs-value conventions), same default `setup` / `teardown` exports.

When adding or changing any adapter-facing option, update the core and **both** adapters in the same change. A capability that lands in only one framework is incomplete. Both adapter files are excluded from unit-test coverage (`v8 ignore`) because they are integration-time glue; keep them as thin as possible so the shared logic stays in the core.

**Parity also covers the runtime environment, not just the API.** The harness chain reads the `OBSIDIAN_METADATA` global at module scope (L20), so every runtime that loads it must supply it — including Jest, which has no `define`. Both runners load the same framework-neutral `scripts/metadata-global-setup.ts` through their `setupFiles` (`scripts/jest-config.ts` / the integration projects in `scripts/vitest-config.ts`); without it a Jest suite dies at import with `ReferenceError: OBSIDIAN_METADATA is not defined` before a single test runs (T241). Any future build-time injection needs the same treatment on both sides.

## L7. Cross-process run serialization

Two integration-test runs that share the same Obsidian resources corrupt each other. On **Android** the emulator and Appium server are shared, so concurrent runs collide (symptoms: `ECONNREFUSED`, "vault not open"). On **desktop** this no longer applies: each run owns an isolated instance (its own temp `--user-data-dir` and free CDP port; Electron's single-instance lock is per-userData), so desktop runs are independent and need no lock.

`src/setup-lock.ts` provides a cross-process advisory lock (a sentinel file under `<tmpdir>/obsidian-integration-testing/<scope>.setup.lock`). `coreSetup` acquires it **first** (before creating the transport — transport creation is what starts the emulator/Appium) and **waits** until any competing run releases it; `coreTeardown` and the process cleanup handlers release it.

A crashed run that never released is detected as stale and stolen. The holder proves it is still there by **refreshing a heartbeat timestamp inside the lock file every 5 s** (an `unref`ed interval, so it can never hold the process open); a lock silent for 24 missed beats (2 min) is stale. The heartbeat — not the recorded PID — is the identity signal, because `process.kill(pid, 0)` only answers "does *a* process with this PID exist", which a **recycled PID** satisfies long after the holder died: before the heartbeat existed, that made every later run block for the full 60-min timeout with no fallback (T232). A dead PID on the same host is still an instant give-away, so it is kept as a fast path; across hosts the PID cannot be probed and the clocks may disagree, so the much wider 30-min silence threshold applies there. A holder whose lock was stolen anyway stops beating and will not delete its successor's lock on release. While waiting, the run re-logs its progress every 30 s (elapsed, holder, remaining timeout) so a legitimate multi-minute wait is distinguishable from a hang.

Only the **`android`** scope (`obsidian-android-appium`) takes the lock now; `getLockScope` returns `undefined` for desktop, so no lock is acquired. The lock lives entirely in the core, so all three consumption paths (Vitest / Jest / Manual) inherit this with no adapter changes. (Note: the **attach** desktop mode shares the user's running Obsidian, but attaching is an explicit advanced opt-in and is the user's responsibility to serialize.)

## L8. Trusted keyboard input (`typeIntoEditor`)

> **Not desktop-only.** Everything below describes the Electron path. The same helper is trusted on Android
> too, through a CDP channel to the WebView — see **L39** for the mechanism and its consequences (the
> helpers are `Promise<void>`, and the `await` matters).

Every `evalInObsidian` callback receives a `typeIntoEditor(params: { editor: Editor; text: string })`
helper as a **base** member of the injected **`lib`** bag (destructure `callback({ lib: { typeIntoEditor } })`),
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
(`async callback({ lib: { typeIntoEditor } }) { … }`) rather than passing them via `input`.

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

### A FAILED global setup rides the same channel — and used to wear the same mask (T726)

`fetch('/json')` has a second cause, and it is not a misconfiguration: the resolvers are registered
correctly, but the global setup **failed**, so it published nothing for them to read. The adapter
caught the failure (deliberately — other projects must still run), logged it, and stored it in
`provide('setupError')` — which **only `getTemporaryVault()` read**. A test going straight to
`evalInObsidian` never touched it, so `getTransportOptions()` returned `undefined`, and `undefined`
means the owned **desktop** CDP default. Observed 2026-08-30 in `obsidian-link-picker`: an Appium setup
failure (the device was not found) produced nine `Failed to parse URL from /json` failures in an
`integration-tests:android` project, each one a **desktop** transport, while the real cause sat once,
far above, in the setup log. The `[1/9]` headline named neither Appium, nor the device, nor the setup.

The failure now travels the same worker channel as everything else:

1. **Publish it.** On failure the Vitest adapter provides `setupError` as
   `{ errorName, message, transportLabel }` — the transport the project was configured for, plus the
   original error's `name` and message (the error object itself does not survive the trip to a worker).
2. **Register the resolver.** `setSetupErrorResolver` sits beside the other two in `vitest/setup.ts`
   (the per-worker file — the registration that matters) and `vitest/global-setup.ts`.
3. **Throw before building anything.** `getOrCreateTransport` — the single ambient-transport entry all
   four worker-side callers share — throws `IntegrationSetupFailedError` ahead of the cache check, so no
   transport of the wrong platform is ever constructed. `coreSetup` is unaffected: it builds its own
   transport through `createTransportFromOptions` with explicit options and passes an explicit
   `transportOverride` into every `TemporaryVault` call.
4. **Refuse the nonsense fetch.** `getPageTargets` now throws "No CDP endpoint configured …" when
   `cdpUrl` is still empty, instead of `fetch`ing a bare path. Not a fix for either cause — a guard so
   the mask can never be the reported error again.

Consequences worth knowing:

- **Tests FAIL, they do not skip.** A skip turns a dead emulator into a green run. The failure carries
  the original message, so all nine reports name the real cause.
- **This changes the `DesktopOnlyPluginSkipError` path too** — that error's own docstring calls a failing
  global setup "the test runner's only way to skip a project's tests", but it never skipped: it fell
  through to desktop and re-ran the mobile suite there. It now fails, carrying its own already-explicit
  message. `errorName` keeps the two distinguishable in a worker.
- Jest needs no counterpart: `jest/global-setup.ts` does not catch, and a throwing Jest `globalSetup`
  aborts the run before a worker starts.

**Regression suite:** `integration-tests:failed-setup` (`src/failed-setup-fail-fast.integration.test.ts`).
Its global setup is wired to fail — the standard plugin-less setup attaching to CDP port `1`, which `fetch`
refuses outright, so the failure is instant, offline, and takes no setup lock (only Appium transports do,
and taking the shared `android` lock in the default aggregate would serialize against every other repo's
Android run). Against the pre-fix code all three of its tests fail with `Failed to parse URL from /json` —
which is the point: it reproduces the reported symptom, not just the fix.

## L10. `connectToCdp` — standalone CDP debugging helper

`connectToCdp(options?)` (`src/connect-to-cdp.ts`, exported from the main entry) is a thin,
framework-agnostic convenience over `createTransportFromOptions` + `TemporaryVault` + `evalInObsidian`. It
launches (or, with `port`, attaches to) a CDP Obsidian instance, opens a vault, bootstraps the runtime
helper namespace, and returns a disposable `CdpConnection` exposing `port`, `cdpUrl`, `vault`,
`invoke(expr)` (raw), and `evalInObsidian({ callback, input })` (rich). It targets ad-hoc real-app debugging
(the R5 / CDP-debugging workflow) rather than test suites.

**Vault-removal safety.** `TemporaryVault.dispose()` unconditionally `rm`s its directory, so a real vault
passed by path must never be routed through it. `connectToCdp` encodes this: `dispose()` removes the
vault dir only when `shouldRemoveVaultOnDispose` is `true`, which **defaults to `true` for an implicit
temp vault** (no `vault` given) and **`false` when a `vault` path is given** (a real vault is never
auto-deleted). A real vault is only unregistered (window closed), not removed.

The whole module is integration-time glue (spawns Obsidian / CDP), so — like `transport-factory.ts` /
`obsidian-instance.ts` — it is wrapped in a module-level `v8 ignore` and covered by
`src/connect-to-cdp.desktop.integration.test.ts`, not unit tests. A thin CLI (`src/cli.ts` +
`bin/obsidian-integration-testing.mjs`, wired via `package.json` `bin`) wraps it for when an external
tool must attach to a printed port.

## L11. Trusted pointer input (`moveMouse` / `clickMouse` / `hoverElement` / `unhoverElement` / `clickElement`)

> **Not desktop-only, but not uniform either.** `clickMouse` / `clickElement` are trusted on Android too
> (**L39**): the default and `'left'` become a tap, `'right'` a long-press, `'middle'` throws. The three
> pointer-*move* helpers — `moveMouse`, `hoverElement`, `unhoverElement` — **throw** on mobile, because
> touch has no hover state. All of them are `Promise<void>`; the `await` matters.

Every `evalInObsidian` callback also gets a trusted-pointer set as **base** members of the injected
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

The same reasoning applies to a **click**, and for a harder reason than `:hover`: Obsidian's own
listeners routinely gate on `e.isTrusted`, so a dispatched `MouseEvent` does not merely render
differently — it does **nothing at all**, while the test still passes whatever weaker assertion it
makes. Obsidian 1.13.7's markdown viewport (margin) menu is the worked example: its `cm.scrollDOM`
`contextmenu` listener is `if (!e.defaultPrevented && e.isTrusted && …)`, so a dispatched `contextmenu`
leaves the handler count at 0 and the test looks "untestable" rather than wrong. A trusted
`mouseMove` → `mouseDown` → `mouseUp` at the same point makes Chromium synthesize the real `click` /
`contextmenu`; verified against a live Obsidian 1.13.7 on 2026-08-24.

Five helpers over one shared internal move, so the primitives and the conveniences never diverge:

- **`moveMouse({ x, y })`** — the raw primitive. Injects a single trusted move at the given web-contents
  DIP coordinates and does **not** poll (callers poll their own readiness signal). Use it directly when
  an element-relative target does not fit (e.g. a full-viewport element with no point outside its box).
- **`clickMouse({ x, y, button?, modifiers? })`** — the raw click primitive: trusted `mouseMove` →
  `mouseDown` → `mouseUp` at one point, no polling. Coordinate-based because the point to click is often
  **not** any element's center — the editor margin lies inside `cm.scrollDOM` but outside `.cm-sizer`,
  so it is reachable only by coordinates (with `readableLineLength` on, aim at
  `(scrollRect.left + sizerRect.left) / 2`). `modifiers` takes Obsidian's `Modifier` names and shares
  `pressKey`'s mapping, so `'Mod'` cannot mean two different things.
- **`hoverElement({ element })`** — moves to the element's center, then **polls** (not a fixed delay)
  until `element.matches(':hover')`, so it is robust under shared-instance load.
- **`unhoverElement({ element })`** — moves to a point just outside the element's bounding box, then
  polls until `!element.matches(':hover')`.
- **`clickElement({ element, button?, modifiers? })`** — clicks the element's center via `clickMouse`.

A right click opens a **real** menu, so a suite that drives one must close it (`menu.hide()` in the
handler, and/or remove leftover `.menu` elements) or it leaks into the next test.

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
member of the injected **`lib`** bag (alongside `typeIntoEditor` / the L11 pointer set), typed on `Lib`
(`src/eval-in-obsidian.ts`) and seeded into the base `lib` in the in-process namespace
(`namespace-bootstrap.ts`); see **L16**. Per **L6** it lives once on the Obsidian side, so Vitest / Jest / Manual
all inherit it.

Integration-test closures constantly need to wait for an asynchronous effect to settle (a view to
open, a DOM node to appear, a setting to apply). The closure is serialized via `toString()` and
**cannot import modules**, so it can't reuse `obsidian-dev-utils`' `retryWithTimeout` / `runWithTimeout`.
Before this helper, every consumer hand-rolled the same poll loop inside each closure
(`obsidian-codescript-toolkit` defined a local `waitUntil` per test; `obsidian-advanced-note-composer`'s
`modal-instructions.desktop.integration.test.ts` hand-rolled one too). Injecting through `CommonArguments`
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
(destructure `async callback({ app, lib: { waitUntil } }) { … }`). First consumers: `obsidian-advanced-note-composer`
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

> **Not desktop-only.** On Android the same `rawKeyDown` → `char` → `keyUp` sequence is injected through the
> WebView's debugger (**L39**), equally trusted. Named keys (`Enter`, `Escape`, `Tab`, `Backspace`,
> `Delete`, the arrows) and single printable characters are supported; any other multi-character name
> throws rather than pressing nothing. It is `Promise<void>`; the `await` matters.

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

Every `evalInObsidian` callback receives a **`lib`** arg (on `CommonArguments`, `src/eval-in-obsidian.ts`)
— a single flat bag of shared closure helpers, so a serialized closure can call them
(`lib.typeIntoEditor({ editor, text })`, `lib.getFileOrNull({ app, … })`) instead of hand-rolling them
or reaching a `window` global. Two layers compose into it:

- a **base** the harness itself seeds — the renderer-driving helpers of L8/L11/L12/L14
  (`typeIntoEditor` / `pressKey` / `moveMouse` / `clickMouse` / `hoverElement` / `unhoverElement` /
  `clickElement` / `waitUntil` / `createNote` / `openSettingsTab`), so
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
  `fullArguments`. The bag starts from the harness base helpers, then each provider merges on top (later
  wins); with no provider it is exactly the base. **Multiple providers compose** (runtime `Object.assign`).
- **Version gate.** `getBootstrapVersion` / `computeBootstrapVersion` fold the resolver sources into the
  `window.__obsidianIntegrationTesting.version` used for the bootstrap-skip check, so a changed resolver
  set (e.g. different test files sharing one owned instance) forces a re-bootstrap instead of leaking a
  stale `lib`.

**Type-safety (declaration merging, the `i18next` `CustomTypeOptions` idiom).** `interface Lib` declares
the base helpers and is **augmentable**: a provider does
`declare module 'obsidian-integration-testing' { interface Lib extends (typeof import('…')) {} }`.
Multiple augmentations merge (like the multiple `Object.assign`s at runtime). Cycle-safe: `lib` is a
live renderer object injected into `fullArguments` (never JSON-serialized — only `callback`'s return value is),
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

| Harness member (`namespace-bootstrap.ts`)                                                                 | dev-utils mirror module    |
|-----------------------------------------------------------------------------------------------------------|----------------------------|
| `typeIntoEditor`, `pressKey`, `moveMouse`, `clickMouse`, `hoverElement`, `unhoverElement`, `clickElement` | `desktop-trusted-input.ts` |
| `ensureLayoutReady`                                                                                       | `workspace.ts`             |
| `errorToString`                                                                                           | `error.ts`                 |

Notes on the set:

- **`pressKey` / `moveMouse` / `clickMouse` / `clickElement` are `Promise<void>`** — superseding the former
  "must stay synchronous (`void`)" rule, which held only while the helpers were Electron-only. The mobile
  path (**L39**) injects from the Node side, so the renderer must await a round-trip; the declared `Lib`
  type is what makes `no-floating-promises` force the `await` at call sites instead of letting a missing one
  race the assertion. The `interface Lib extends typeof import('obsidian-dev-utils/__merged')` augmentation
  is unaffected either way — `() => Promise<void>` is assignable to `() => void`. `clickElement` still does
  no *polling* of its own, unlike its element-relative sibling `hoverElement`: `hoverElement` polls
  `:hover`, and a click has no equivalent state to poll. Deliberately it does **not** hover first — an
  element that never matches `:hover` (covered by an overlay, say) would then cost the full 5 s timeout on
  every click.
- **`moveMouse` / `hoverElement` / `unhoverElement` throw on mobile; `clickMouse({ button: 'middle' })`
  throws too** — touch has no hover state and no middle button, and a silent no-op would recreate the
  false-confidence failure these helpers exist to end. `button: 'right'` maps to a long-press. See **L39**.
- **The Obsidian-`Modifier` → Electron-modifier mapping lives in ONE `toElectronModifiers` helper per
  copy**, shared by `pressKey` and `clickMouse`, so a key press and a click cannot disagree on what
  `'Mod'` resolves to. Added 2026-08-26 with the click helpers (T599-P21).
- **`moveMouseTo` was folded into `moveMouse`** (rounding + `sendInputEvent` inlined); `hoverElement` /
  `unhoverElement` call `moveMouse({ x, y })` directly. There is no separate `moveMouseTo` to sync.
- **`waitUntil` is NOT synced** — dev-utils reuses its own `retryWithTimeout` instead of duplicating a
  poll loop, and the harness keeps `waitUntil` as its own self-contained base helper (its integration
  suite depends on it).
- **`openSettingsTab` is NOT synced** (added 2026-08-29 with **L38**, T664-P2) — same reasoning as
  `waitUntil`. It drives a modal purely to make it *observable to a test*; no production code has a reason
  to `import` it, which is the only thing the dev-utils copies buy.
- **`destroyCurrentWindow` / `ipcSendSync` are NOT synced** — they are transport/Electron-only harness
  primitives (see their `// intentionally not migrated` TSDoc in `namespace-bootstrap.ts`), not
  general-purpose utilities.
- **The seven synced input helpers are ALSO published as `ns.trustedInput`** (added 2026-08-31, T792-P2) —
  the one namespace member that exists *for* dev-utils rather than for the harness. Duplication is enough
  on desktop, where dev-utils' own copy reaches a trusted event unaided; it is **not** enough on mobile,
  where the injection must come from the Node side over the harness's CDP channel (**L39**) and dev-utils
  may not import this package at runtime (ODU **L4**). So dev-utils' mobile mirror reads the helpers off
  `window.__obsidianIntegrationTesting.trustedInput`, declaring the shape locally. The member exposes the
  **same function objects** `evalWrapper` puts in a closure's `lib` bag — not wrappers — so the mobile
  branch stays in exactly one place and the seam cannot drift from the `lib` bag it mirrors.

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
  `resolveRendererBootState({ bodyChildElementCount, hasGraceElapsed, hasWindowApp, isDocumentComplete }) →
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
  `metadata.json`). Its pure `resolveRendererBootState` keeps its unit coverage. There was no dead-boot
  *integration* test because the proactive throw always fired first — but **T68 unblocked one**: setting
  `shouldThrowOnIncompatibleInstaller: false` (see L21/L24) makes an `'unrunnable'` pin proceed to launch
  instead of throwing, so a dead-boot integration test can now drive this reactive path and assert
  `RendererFailedToInitializeError` (still a heavy download-and-boot suite, so opt-in-gated like the others).
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
  `package list` can't falsely read as idle. **Since T794 this covers a REUSED device too** — the branch
  that found an AVD already running used to skip the gate entirely, which is the hole T794 fell into; see
  **L43**.
- **Configurable timeouts** (all raised/threaded with per-poll elapsed logging, resolved via the testable
  `appium-session-config.ts`): `appiumStartTimeoutInMilliseconds` (`@default 180000`),
  `sessionConnectionRetryTimeoutInMilliseconds` (`@default 180000`), `appStartTimeoutInMilliseconds`
  (`@default 180000`), `layoutReadyTimeoutInMilliseconds` (`@default 90000`). Headroom for the starved/CI
  regime — not root causes. The last two are the two halves T794 split the old single post-reload clock
  into (**L43**).
- **`registerVault` marker push via `adb`** instead of `browser.pushFile` — measured cold marker 9–21s →
  ~2.5s, total `registerVault` ~10–24s → ~5.6–7.8s (3–4×). The one measured, unconditional win.
- **Crash/ANR dialog suppression** — see **L13**. **Process visibility (off-screen, never minimize)** —
  see **L15**.

### Remaining optimization levers (provisioning, user-owned — NOT code)

In descending value:

1. **Warm/snapshot emulator reuse** (biggest single chunk — eliminates the ~112s boot). `emulator-arguments.ts`
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
for the slow/CI regime; the round-trip-inflation mechanism it fixes is directly measured.

**The open question here — capture a real failing layout trip during an actual release, and tell
layout-slowdown from command-latency burst — was answered by T794 (2026-08-31).** A release preflight
blew the 90 s budget with `adb devices` reporting `device` throughout, and the answer was
command-latency burst: the run had **reused** an emulator, so the boot-idle gate above never ran, and
~2–4 probes against the churning guest consumed the whole budget while `waitForLayoutReady`'s own
measured cost is ~1 s. Both halves of the fix, and the timeout message that now discriminates the two
readings without a second trace, are in **L43**.

## L20. `metadata.json` — per-version installer-floor table (`minRunnableInstallerVersion`)

Repo-root `metadata.json` is a per-Obsidian-desktop-version data table (one `"x.y.z"` key per release):
`channel`, optional `available`, `changelogUrl` (per-target changelog pages — see below), per-version
`downloads` (baked asset URLs — see below),
per-version `runtimeVersions` + `ecmaScriptVersion` (empirically-collected shell runtime — see below), and
installer/Electron compatibility knobs. It is a
**data table** consumed by `src/obsidian-metadata.ts` (the sole reader; see L21): the whole table is
injected as the `OBSIDIAN_METADATA` global — esbuild's `define` inlines it into the build (the built
library stays self-contained, no runtime file read), the unit-test project uses Vitest's `define`, and the
runtimes with no `define` (the Vitest main process, the Vitest integration projects, and every Jest worker
— see L6) publish it via the shared `scripts/metadata-global-setup.ts` setup file. Every one of those
paths — plus the byte-stable catalog read/write — sources the table from
`scripts/helpers/metadata-global.ts` (`METADATA_JSON_PATH` resolved from `import.meta.dirname`, so the read
does not depend on the invocation directory; `readMetadataJsonText` for the `define` callers,
`defineObsidianMetadataGlobal` for the global). The usual format/lint/spellcheck gates apply.

**`changelogUrl` — one page per publication target, from Obsidian's own changelog feed.** Obsidian
publishes a *separate* changelog page per platform (desktop / mobile) and per channel (public / catalyst
"early access"), each at its own dated slug, so `changelogUrl` is an object with four optional keys —
`desktop`, `desktopCatalyst`, `mobile`, `mobileCatalyst` — carrying only the pages the feed actually
published for that version (the catalyst page typically predates the public one by about a day). It
replaces the single string plus the `changelogUrl_catalyst` sibling that preceded it: that string silently
mixed channels (105 of the 322 stored values were the public page, 210 the catalyst one, depending only on
which channel the version happened to be scraped from) and never represented mobile at all.

The source is `https://obsidian.md/changelog.xml` — one Atom feed, no pagination, covering every release
from `desktop-v0.0.1` on. Derivation rule, established empirically: **version and platform come from the
link slug (`/changelog/<date>-<desktop|mobile>-v<version>/`), channel from the title's trailing
`(Public)` / `(Early access)`.** Two entries carry a typo'd version in their title (`Obsidian 1.0.4
Mobile` links `…-mobile-v0.1.4/`; `Obsidian 0.6.0 Desktop` links `…-desktop-v0.6.1/`), so trusting the
title collapses those onto the wrong key; the slug rule yields zero collisions. Entries with no
`-v<version>` slug (the Publish and Sync changelogs) are skipped.

**Caveat — a pre-1.4.8 `mobile` page is a different release than the `desktop` page beside it.** Until
**1.4.8** (2023-09-05) the mobile app ran its own version line, so same-keyed pages document unrelated
releases (mobile `1.4.5` shipped 2023-05-23, desktop `1.4.5` 2023-08-31; gaps across `1.0.0`–`1.4.6` run
93–471 days). From 1.4.8 on the two lines track within days. The table is keyed by *desktop* app version,
so read an old `mobile` value as "the mobile changelog that happens to carry this version number", not as
"the mobile notes for this release". Two entries (`1.4`, `1.5`) have no feed page of their own and retain
a hand-entered `desktop` URL that actually points at `v1.4.5` / `v1.5.3`; three (`1.1.8-E21`, `1.2.4`,
`1.6.3-e30`) carry no `changelogUrl` at all.

**`downloads` — baked asset URLs, resolved from Obsidian's own release assets.** Each version carries
an optional `downloads` object with the *exact* published URLs for the assets this harness downloads:
`asar` (the `obsidian-<ver>.asar.gz`), the x64 desktop installers `exe` (Windows) / `dmg` (macOS
universal) / `tar` (Linux), and the Android `apk`. `asar` is present for every catalogued version; the
installer keys are present only for versions that ship a public desktop installer (catalyst builds are
`asar`-only). `apk` is the *public* Android build, published as a GitHub release asset named uniformly
`Obsidian-<ver>.apk` — it first appears at **1.5.8** and is hyphenated from the start, so unlike the
desktop installers it has no dot-separator era to guess around. **Nothing consumes `apk` yet** (the Appium
transport runs an already-installed APK and takes no `obsidianVersion`), so it is deliberate groundwork;
`selectInstallerDownloadUrl` stays desktop-only and is not extended for it.

**There is deliberately no catalyst APK key, because there is no catalyst APK URL.** Unlike the desktop
catalyst asar (`releases.obsidian.md/release/obsidian-<ver>.asar.gz`), the mobile catalyst build is not
published at a URL at all — Obsidian distributes it through a Discord-gated channel: join their Discord,
claim the badge, and `#insider-welcome` carries the per-device download instructions
([Early access versions](https://obsidian.md/help/early-access)). That is why every sibling path probed on
`releases.obsidian.md` returns the non-existence signature and why the public Android build contains no
update endpoint to reveal a pattern. So what the table carries for a catalyst mobile build is its
**changelog** (`changelogUrl.mobileCatalyst`); for the build itself, follow the link above. The asar and
installer download paths (`obsidian-version-switch.ts` `getAsarDownloadUrls`, `obsidian-installer.ts`
`resolveInstallerAssetUrls`) try the baked URL **first**, so the common path needs no GitHub release-API
call and no dot-vs-hyphen asset-name guessing — the hand-rolled URL guesses (`installer-asset.ts`) remain
the fallback for versions absent from the catalog. `src/installer-asset.ts` `selectInstallerDownloadUrl`
picks the platform-correct URL (pure, unit-tested).

**The catalog depends on NO third-party source — it reads Obsidian's own endpoints.** We publish
`metadata.json` as a public runtime feed, so a stalled upstream must not be able to freeze it; it
previously tracked `jesse-r-s-hines/wdio-obsidian-service`'s `obsidian-versions.json`, and that
dependency was removed by T717. `scripts/refresh-metadata.ts` (`npm run refresh:metadata`, daily
via `.github/workflows/refresh-metadata.yml`) reads three sources, each authoritative for one part of an
entry, then writes the table back byte-stably (rerun ⇒ no diff — verified). Commit the result.

- **`obsidianmd/obsidian-releases` GitHub Releases API → `downloads`.** Two paginated requests cover all
  172 releases, assets inline. The release's *real* asset list is matched by `src/release-catalog.ts`
  `selectReleaseDownloads`, which reuses `selectInstallerAssetName` so the dot-vs-hyphen era needs no
  guessing and the 32-bit / arm64 / AppImage / deb / snap siblings are left behind. Verified to reproduce
  all 168 previously-catalogued GitHub URLs byte-for-byte. Two tags — `v1.1.8-E21` and `v1.6.3-e30` —
  publish assets carrying the *base* version (`Obsidian.1.1.8.exe`), so they deliberately match nothing.
- **`obsidian.md/changelog.xml` → `changelogUrl` and `channel`.** The feed is the authoritative publisher
  of every changelog page, so each version it knows has its whole `changelogUrl` object rewritten from it.
- **`desktop-releases.json` → `minRecommendedInstallerVersion`,** captured for the current public and
  catalyst releases. **Additive only** — the manifest reports only the *latest* release's floor, so this
  captures each new one as it ships and never overwrites a historical value measured here.

**Catalyst asars are probed, and a `200` is not enough.** They are served from `releases.obsidian.md`,
which publishes no listing, so a feed-known version with no GitHub release gets its URL constructed
(`buildCatalystAsarUrl`) and probed. For a version it does not host the CDN answers **`200` with
`content-length: 0`** — measured 2026-08-30 on `0.0.3` / `0.1.0` / `0.3.0` — so the probe requires a
non-empty body, exactly as `downloadAndDecompressAsar` already rejects an "empty response body". A
status-only check invents download URLs for versions that have none, and the CDN's intermittent `502`
(seen on `1.2`) made two consecutive runs disagree. Only versions with no `downloads` are probed, so a
steady-state run makes no requests.

**`channel` is derived from PUBLICATION, not from the feed's title marker.** The feed tags each entry
`(Public)` or `(Early access)`, but through the pre-1.0 era it tagged *everything* early-access — the whole
app was — so 61 versions that shipped as ordinary GitHub releases carry only a catalyst page. Trusting the
marker relabels a large slice of public history as catalyst. A GitHub release is unambiguous the other way
round: catalyst builds are served only from the CDN, never as release assets. So `resolveReleaseChannel`
reads a GitHub release as public, and records `public+catalyst` only when the feed carries **both** desktop
pages — the shape all ten pre-existing `public+catalyst` entries have. Against the 325 recorded values this
rule reproduces every one except **12 genuine drifts** it corrects: eight `public` and three `catalyst`
entries that carry both pages became `public+catalyst` (incl. `1.13.4` / `1.13.6` / `1.13.7`, stale because
`channel` was previously written only for *new* versions and never revisited), and `0.12.16` — a GitHub
release with **zero assets**, `prerelease: true` and no downloads anywhere — became `catalyst`.

The download merge is **additive**: it never overwrites our own empirically-measured `min*` /
`available` / `runtimeVersions` fields. The byte-stable read/write
(`readMetadataTable` / `writeMetadataTable` / `serializeTable`, sorted via `compareVersions`, 2-space,
trailing newline) lives in `scripts/helpers/metadata-io.ts`, shared by both catalog scripts so their
output stays byte-identical.

**`runtimeVersions` + `ecmaScriptVersion` — empirically-collected shell runtime (per installer version).**
Each version carries an optional `runtimeVersions` object — the **entire** `process.versions` its Electron
shell ships (the four well-known `node` / `chrome` / `v8` / `electron` plus every other key that build
exposes: `uv` / `zlib` / `brotli` / `openssl` / `icu` / `modules` / `napi` / `llhttp` / … — the exact set
varies by Electron version) — read from a real `process.versions` by booting that version's own installer,
plus a derived `ecmaScriptVersion` string (e.g. `'ES2022'`). Unlike `minRecommendedElectronVersion` (the
app's hardcoded *minimum*, not the bundled version), these are the *actual* bundled versions, so a consumer
pinning an installer knows offline which ES level a serialized `evalInObsidian` closure may safely use.
Collected by `scripts/collect-runtime-versions.ts` (`npm run collect:runtime-versions`), which boots each
version pinning both the asar and the installer to that version (matched pair → clean boot), reads
`JSON.stringify(process.versions)`, and derives the ES edition from the Chromium major via the pure,
unit-tested `src/ecmascript-version.ts` `deriveEcmaScriptVersion` (a curated Chromium-major → ES-year
breakpoint table). It is **incremental** — only versions with no `runtimeVersions` are collected, which in
steady state is none — and **additive** (never overwrites `channel` / `downloads` / `min*`; writes after
each version so a long run is resumable). Versions that dead-boot (an installer too old to render) are
logged and skipped. It runs under jiti, which lacks the `OBSIDIAN_METADATA` `define` global, so the script
calls the shared `defineObsidianMetadataGlobal()` (the same shim the test runners get via
`metadata-global-setup.ts`) before dynamically importing `connectToCdp`. `--out` writes a per-platform
fragment instead of the catalog, and `--disable-sandbox` is what lets it boot on Linux CI.

**The field is only ever populated for versions that ship a desktop installer, which is 106 of the 325 —
not a coverage gap.** A catalyst asar-only release has no Electron shell to boot, so `runtimeVersions` is
structurally inapplicable to it. Reading "103 of 325" as a broken pipeline is the mistake T717 was
opened on; the real gap was three versions.

**CORRECTION (2026-08-30): the Electron version is a property of the INSTALLER, not of the release.** This
section previously claimed "Electron bundles the same Node/V8/Chromium on every OS for a given Electron
version, so a single-platform run is authoritative for all platforms — no per-OS matrix." The first half is
true; the conclusion is not, because two installers of the *same* Obsidian version can bundle *different
Electron builds*: **`1.12.4` shipped Electron `39.6.0` in its `.exe` and `39.7.0` in every other
installer**, and **`1.8.10` shipped `34.2.0` vs `34.5.2`** (2 of 106). The table keeps **one flat
`runtimeVersions`**, measured on **Windows (`.exe`)** — the reference platform, because `exe`/`dmg` are
published for all 106 installer-bearing releases while `tar` covers only 92 (0.6.4–0.8.15 shipped AppImage
and snap instead), and because all 103 pre-existing values were measured there. So our `1.12.4` reads
`39.6.0` and deliberately differs from any source that flattens to `39.7.0`.

**`.github/workflows/collect-runtime-versions.yml` is what keeps the field current.** Before it, the field
was only ever filled by someone remembering to run the script by hand on a desktop — which is exactly why
it stalled three releases behind. The workflow boots each not-yet-collected installer on a runner matrix
and `scripts/merge-runtime-versions.ts` (`npm run merge:runtime-versions`) folds the per-platform fragments
into the catalog: the Windows value wins the flat field, and **every cross-platform disagreement is logged
by version and platform** — that report is the entire reason the matrix boots three platforms rather than
one, since the flat field cannot represent the divergence. Because divergence is rare, the **daily**
schedule runs Windows alone and the **full matrix runs weekly** and on `workflow_dispatch`. It reuses the
setup `validate-installer-boot.yml` already proves works on all three runners (xvfb + `libnss3` /
`libgbm1` / `libgtk-3-0` on Linux, `GITHUB_TOKEN` against the anonymous release-API 403).

Two installer-floor fields:

- **`minRunnableInstallerVersion`** — the tier-1 **boot floor**: the oldest installer (Electron shell) on
  which that app version's asar actually runs (renders a real UI — a loaded vault, or the first-run vault
  picker when old Obsidian ignores the pre-seeded `obsidian.json` auto-open — now forced open via the
  dual-marker seed, see L26); below it the renderer
  dead-boots (see L18) **or silently falls back to the installer's bundled asar** (see the caveat below).
  It is **empirically measured** (boot the (asar, installer) pairs and detect boot-vs-dead) and is much
  lower than the recommended min — e.g. `1.13.1` runs on the `1.1.9` shell (Electron 18), far below its
  recommended `1.6.5`. Distinct floors: `0.6.4` for apps `0.6.4`–`1.2.8`, `0.14.5` for `1.3.0`–`1.5.2`,
  `1.1.9` for `1.5.3`–`1.12.7` **and** `1.13.1`, but **`1.6.5` for `1.13.0`** (a genuine non-monotonic
  exception — see the caveat); apps older than `0.6.4` are left unset (no older installer exists to run
  them — asar-swap is upgrade-only, so an app needs an installer ≤ itself).
- **`minRecommendedInstallerVersion`** — the tier-2 recommended min (Obsidian's own guidance); equals
  `wdio-obsidian-service`'s `minInstallerVersion` (52/52 agreement, checked while that catalog was still
  a source — see the independence note above). New values now come from `desktop-releases.json`.

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
`window.electron.remote.app.getVersion()` = the installer/shell version. Hardening the harness to assert the
running `apiVersion` matches the requested version (so silent fallbacks are caught, not just dead boots) is
**now done** as a post-boot runtime verify — see **L25** (`resolveAsarFallback` + `SilentAsarFallbackError`).
This did **not** trigger a boot re-audit of the table: with L25's default-on throw a mis-measured floor now
fails loudly the moment anyone boots that pair, so the empirically-measured `min*` values stand and the
catalog keeps flowing via `refresh:metadata`.

Range summary (per-version data in `metadata.json` is the source of truth; the recommended column is
filled from what `wdio-obsidian-service` recorded, for completeness — it matched our values 52/52). `—` = not
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
  pure/glue split): `resolveInstallerCompatibility({ appVersion, installerVersion, metadata }) →
  InstallerCompatibility` with `tier: 'ok' | 'nagged' | 'unrunnable' | 'unknown'`. `unrunnable` ⇔ installer
  `<` `minRunnableInstallerVersion`; `nagged` ⇔ `≥` run floor but `<` `minRecommendedInstallerVersion` (old
  versions only); `unknown` ⇔ installer version undefined (undetectable Linux shell) or app absent from the
  table. Pure `x.y.z` compares (reuses `compareVersions`) — no I/O.
- **Distinct error** — `IncompatibleInstallerVersionError`
  (`incompatible-installer-version-error.ts`, exported from the barrel) carries `appVersion` /
  `installerVersion` / `minRunnableInstallerVersion` and a message naming the installer that would work.
  Thrown from `resolveOwnedInstanceConfig` via the `resolveAndReportCompatibility` helper on `'unrunnable'`;
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
  be integration-tested again) — **now landed, see L24**.

## L22. Auto-install Appium dependencies before auto-starting the server

The harness auto-starts the Appium server via `npx --no-install appium` (the `--no-install` pin and the
server-process observability that surrounds it are **L27**), which assumes both Appium **and** the
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
  output ⇒ not-installed so the caller installs) and `willAutoInstallAppiumDependencies`
  (`@default true`), both unit-tested in `appium-dependencies.test.ts`. The `exec` orchestration stays in the
  `v8 ignore` factory.
- **Windows:** the install/probe commands are passed to `exec` as **strings**, not arrays, so `exec` routes
  them through the shell — required to resolve the `npm`/`npx` `.cmd` shims (the array path spawns without a
  shell and would `ENOENT`). This differs from the `adb`/`tar` calls, which are real `.exe` on PATH.
- Supersedes L19 lever #3 ("pre-provision … driver") for the local/first-run case — provisioning it into a
  CI image is still the faster path when you control the image, but the harness no longer *requires* it.

## L23. Tier-2 runtime Electron nag (`resolveElectronCompatibility` + verdict-as-data)

The runtime companion to L21's offline installer check — deferred item (a) from that section (the parent task
that shipped L20/L21). L21 compares the resolved **installer** version against installer-version thresholds
entirely offline. But the app's real requirement is a **minimum Electron version** hardcoded inside `app.js`
(e.g. `1.13.1` needs Electron `28.2.3`), and the installer's bundled Electron is not derivable offline (see
`ObsidianVersionMetadata.minRecommendedElectronVersion`, L20). So this tier reads the **live** Electron the
owned instance is actually running, post-boot, and warns when it is below the app's recommended minimum. It
never blocks (an old Electron runs but nags) — there is no error tier here, unlike L21's `'unrunnable'`.

- **Pure verdict** — `src/electron-compatibility.ts` (unit-tested; mirrors `installer-compatibility.ts`):
  `resolveElectronCompatibility({ appVersion, actualElectronVersion, metadata }) → ElectronCompatibility` with
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
- **Barrel** — `resolveElectronCompatibility` + `CheckElectronCompatibilityParams` / `ElectronCompatibility` /
  `ElectronCompatibilityTier` are exported from the main entry.
- **Silencing/tuning is via L24's knob** — `shouldWarnOnCompatibilityIssues: false` suppresses this
  runtime-Electron nag alongside the installer nag (the verdict still rides on `getElectronCompatibility()`).
  Landed by T68 (was L21's deferred item (b)); the warning is on by default.
- **Integration test** — `src/electron-compatibility.integration.test.ts` boots a real nag-band pair
  (app `1.13.1` on the `1.1.9` installer shell → live Electron 18 `< 28.2.3` → `'nagged'`) and asserts the
  surfaced `electronCompatibility`. Like the other download-and-boot suites it is opt-in via
  `OBSIDIAN_TEST_ELECTRON_NAG=1`.

## L24. Compatibility-warning knobs (`shouldWarnOnCompatibilityIssues` / `shouldThrowOnIncompatibleInstaller`)

Two flat, independent booleans on the transport-options channel let a consumer silence/tune the compatibility
checks of L21 (installer↔app) and L23 (runtime Electron). Deferred item (b) of L21; both default to `true`
(today's behavior), so existing consumers are unaffected. (A third sibling knob,
`shouldThrowOnSilentAsarFallback`, was later added by **L25** on the same channel with the same `@default true`,
and it reuses this section's `shouldWarnOnCompatibilityIssues` for its warn path rather than adding a fourth.) They ride the existing `ObsidianCdpTransportOptions`
channel (and `ConnectToCdpOptions`), so — like the version/visibility/sandbox knobs (L5) — all three
consumption paths (Vitest / Jest / Manual, L6) inherit them with **no adapter change**. Owned path only; attach
mode runs neither check.

- **`shouldWarnOnCompatibilityIssues`** (`@default true`) — when `false`, suppresses **both** nag warnings:
  the offline installer↔app `'nagged'` warning (L21, logged from `transport-factory`) and the post-boot
  runtime-Electron `'nagged'` warning (L23, logged from `transport-desktop-cdp`). The verdicts are still
  computed and surfaced as data (`getCompatibility()` / `getElectronCompatibility()`,
  `CdpConnection.compatibility` / `.electronCompatibility`) — only the `log()` is gated.
- **`shouldThrowOnIncompatibleInstaller`** (`@default true`) — when `false`, an `'unrunnable'` installer↔app
  pair no longer throws `IncompatibleInstallerVersionError` at version-resolution time; it proceeds to launch
  (a "proceeding to launch" warning is logged unless warnings are also off), where L18's reactive dead-boot
  fast-fail catches the black-screen boot. Consequently an `'unrunnable'` verdict now **can** reach the data
  surface (`compatibility.tier === 'unrunnable'`) — the L18/L21/connect-to-cdp TSDoc that said "unrunnable
  never reaches the data surface, it throws first" is qualified accordingly.

- **Pure/testable split** (mirrors `visibility.ts` / `renderer-boot-detection.ts`): `src/compatibility-options.ts`
  (internal, **not** re-exported) holds `willWarnOnCompatibilityIssues` /
  `willThrowOnIncompatibleInstaller` (the `@default true` resolvers, G10q-tested) and
  `resolveInstallerCompatibilityAction({ tier, shouldThrow, shouldWarn }) → 'throw' | 'warn-unrunnable' |
  'warn-nagged' | 'silent'` — the pure decision the v8-ignored `transport-factory.resolveAndReportCompatibility`
  glue executes (throw / `log` / return the verdict). All branches are unit-tested in
  `compatibility-options.test.ts`.
- **Coverage honesty** — the `log()` suppression itself lives in v8-ignored glue and is not asserted (the repo
  has no console-warn-spy precedent — L23 asserts on the surfaced *verdict*, not on `console.warn`). The
  resolver + action unit tests plus the verdict-as-data surface carry the coverage. There is **no cheap
  integration test for the throw-disable path**: disabling the throw removes the pre-download fast stop, so the
  only faithful end-to-end proof is the heavy opt-in dead-boot suite L18 now unblocks (tracked as a follow-up,
  not bundled here).

## L25. Post-boot silent-asar-fallback verify (`SilentAsarFallbackError` + verdict-as-data)

`DesktopCdpTransport` verifies, **after every owned boot**, that the app (asar) version actually running
matches the swapped-in pin — catching a **silent asar fallback**. When an asar is swapped onto an installer
shell below its real boot floor the renderer does not always dead-boot (the black screen L18 catches); some app
versions instead **silently revert to the installer's own bundled asar** and render a healthy UI of the *wrong
(older)* version. L18's dead-boot detector reads that healthy UI as a false-positive "runnable" — exactly how
`1.13.0` on installer `1.1.9` was first mis-measured (it reports `apiVersion` `1.1.9`, not `1.13.0`; see L20's
silent-fallback caveat). L25 is the **healthy-UI companion** to L18's black-screen fast-fail: L18 catches an
empty `<body>`, L25 catches a full UI running the wrong version. It also closes the gap L24 left open — with
`shouldThrowOnIncompatibleInstaller: false` an `'unrunnable'` pin proceeds to launch, and if it silently falls
back (rather than dead-boots) L18 never fires; L25 is what catches it.

- **Pure verdict** — `src/asar-fallback-detection.ts` (unit-tested; mirrors the `renderer-boot-detection` /
  `installer-compatibility` / `electron-compatibility` pure/glue split):
  `resolveAsarFallback({ requestedVersion, runningApiVersion }) → AsarFallback` with
  `tier: 'match' | 'fallback' | 'unknown'`. `'match'` ⇔ the running version equals the pin; `'fallback'` ⇔ they
  differ (the pin was not honored); `'unknown'` ⇔ no asar was swapped (nothing to verify) or the live version
  was unreadable. Pure `x.y.z` compare (`compareVersions`) — no I/O and **no metadata** (a pin-vs-running
  comparison, not a table lookup).
- **Distinct error** — `SilentAsarFallbackError` (`silent-asar-fallback-error.ts`, **exported from the barrel**)
  carries `requestedVersion` / `runningApiVersion` and names the too-old installer, so callers can
  `instanceof`-match it (like `RendererFailedToInitializeError`).
- **Post-boot glue** — `DesktopCdpTransport.checkRuntimeCompatibility` (owned path only) reads the live running
  app version **once** (`ipcRenderer.sendSync('version')` — the same read L23 uses, truthful even under a silent
  fallback) and shares it with both the asar-fallback check (`checkRuntimeAsarFallback`, may throw) and L23's
  runtime-Electron nag (`applyElectronCompatibility`, best-effort). It runs in the ready branch of
  `waitForOwnedVaultReady`, **outside** the readiness poll's try/catch, so the throw fails fast instead of being
  swallowed as "not ready yet" and looping until timeout. The requested version is `ownedConfig.asar?.version`
  — present only for the **asar-swap** case (the sole fallback risk); the downgrade / own-installer paths run
  the app's own installer, so the running version always matches and the verdict is `'unknown'` (skipped).
- **Verdict-as-data** — the verdict rides on `DesktopCdpTransport.getAsarFallback()` and
  `CdpConnection.asarFallback` (populated in `connectToCdp`), so a consumer / integration test asserts on it
  rather than spying on a throw. A `'fallback'` verdict reaches the data surface only when the throw is disabled
  (below); with the default throw it fails first (same data-surface caveat L24 records for `'unrunnable'`).
- **Knob** — `shouldThrowOnSilentAsarFallback` (`@default true`) is the **third** member of the L24
  compatibility-knob family, on `ObsidianCdpTransportOptions` + `ConnectToCdpOptions`, resolved by the pure,
  unit-tested `willThrowOnSilentAsarFallback` + `resolveAsarFallbackAction({ tier, shouldThrow,
  shouldWarn }) → 'throw' | 'warn' | 'silent'` in `compatibility-options.ts`. When `false`, a fallback no longer
  throws; it warns (gated by the **existing** `shouldWarnOnCompatibilityIssues`, not a new warn knob) and
  surfaces the verdict as data. Owned path only; it rides the existing options channel, so all three consumption
  paths (Vitest / Jest / Manual, L6) inherit it with no adapter change (L5).
- **Integration test** — `src/asar-fallback.integration.test.ts` boots the real fallback pair (`1.13.0` on
  `1.1.9`, throw disabled → `'fallback'`, running `1.1.9`), asserts the default throw, and a no-false-positive
  `'match'` pair (`1.13.1` on `1.1.9`, which genuinely runs — its run floor IS `1.1.9`). Opt-in via
  `OBSIDIAN_TEST_ASAR_FALLBACK=1` (heavy download-and-boot). Because `1.13.0`/`1.1.9` is below the run floor, the
  boot-based cases also set `shouldThrowOnIncompatibleInstaller: false` to get past L21's proactive throw and
  reach the boot. CDP-confirmed on Windows (2026-07-17): `1.13.0`/`1.1.9` really runs `apiVersion` `1.1.9`.
- **Option-bag plumbing uses a local `normalizeOptionalProperties`** — `src/normalize-optional-properties.ts`
  (ported from `obsidian-dev-utils/object-utils`, **not** depended on — same dependency-hygiene reason as the
  L17 duplicated helpers; it needs only `type-fest`, already a dep). It replaces the per-key
  `...(x !== undefined && { k: x })` conditional-spread when building the transport-options / config bags
  (`connect-to-cdp` `buildCdpTransportOptions`, `transport-factory` `createCdpTransport`). Cast-only (keeps
  `undefined`-valued keys at runtime), which is safe because every consumer reads each field with a
  `?? default` / `!== undefined` guard.
- **`metadata.json` was deliberately NOT re-audited** by a boot campaign (a scoping decision): with the
  default-on runtime throw a mis-measured floor now fails loudly the moment anyone boots that pair (including the
  CI boot suites), so the empirically-measured `min*` values stand as-is and the catalog data keeps flowing from
  `refresh:metadata` (L20). This resolves the "harden the boot-floor measurement"
  follow-up L20 tracked.

## L26. Full usability of old Obsidian versions down to 0.6.4 (auto-open + readiness + closures)

The owned-instance path is usable end-to-end (vault auto-opens, readiness completes, `evalInObsidian`
runs) on **every installer from 0.6.4 up** — the oldest the harness supports. Getting there took a stack of
old-version compatibility fixes, each CDP-diagnosed against real boots (2026-07-17/18). App-only closures
(`callback({ app })`) work on the whole range. **`obsidianModule`** resolves wherever the community-plugin registry
exists (`plugins.manifests` + `loadPlugin`) — the API **first appears at 0.9.7**, so the module resolves on
**every version from 0.9.7 up** (0.9.7 needs two partial-API workarounds — undefined `configDir` and absent
`uninstallPlugin` — see the `getObsidianModule` bullet). It is `null` on the **0.6.4–0.9.6** band, which
has no registry at all (predates community plugins) — a genuine platform limit there, not a harness gap;
`getObsidianModule` warns once (`console.warn`) on that band so a `null` `obsidianModule` is self-explaining.

The owned instance opens its vault by pre-seeding `obsidian.json` into the temp `--user-data-dir` (no CLI
arg exists for it). The auto-open marker **changed across Obsidian's history**, and the harness had baked in
only the modern one — so old versions ignored the seed and stuck on the first-run vault-selector
(`starter-screen`), and `waitForOwnedVaultReady` burned its full timeout (no matching `getBasePath()`
target; the selector is not a dead boot, so L18 never fired).

- **Root cause (confirmed by reading old `main.js` + real boots, 2026-07-17).** Old Obsidian's main process
  auto-opens from a **top-level `settings.last_open`** holding the vault **id**
  (`if (id && vaults.hasOwnProperty(id)) createWindow(id); else openStarter();`), and stores each vault
  entry as just `{ path, ts }` — no `open`. Newer versions dropped `last_open` and auto-open from the
  **per-entry `open: true`** flag. The seed only set `open: true`, never `last_open`, so old versions fell
  through to `openStarter()`.
- **Fix — one version-agnostic dual-marker seed, always-on (no knob).** `src/owned-vault-seed.ts`
  `buildOwnedObsidianJson({ vaultId, vaultPath, ts })` returns `{ last_open: vaultId, updateDisabled: true,
  vaults: { [vaultId]: { open: true, path, ts } } }` — BOTH markers. Each version reads the one it
  understands and ignores the other unknown key, so **no per-version branching and no `metadata.json` field**
  are needed. `DesktopCdpTransport.registerVaultInOwnedInstance` calls it in place of the old inline literal.
  Confirmed to open the vault directly (no selector) on 0.6.4, 0.9.20, 0.11.13, 0.12.19, 0.13.19, 0.14.5,
  1.12.7. The marker transition: **≤~0.11 require `last_open`**; **~0.12 reads both**; **≥0.13 uses per-entry
  `open`** only. The pure builder is unit-tested (`owned-vault-seed.test.ts`).
The old-version fixes, each CDP-diagnosed:

- **Readiness — `onLayoutReady` guard (`namespace-bootstrap.ts` `pollVaultBasePath`).** Readiness ran
  `pollVaultBasePath` → `ensureLayoutReady()` → `Workspace.onLayoutReady(cb)`, a method **absent before
  ~0.11** — it threw `onLayoutReady is not a function`, the poll swallowed it, and the 30 s timeout burned.
  Fix: guard the wait behind the long-standing `workspace.layoutReady` flag (already `true` by the time an
  owned window is up): `if (!this.app.workspace.layoutReady) { await this.ensureLayoutReady(); }`. The guard
  lives in the **harness-only** `pollVaultBasePath`, deliberately NOT the L17-synced `ensureLayoutReady`, so
  no `obsidian-dev-utils` mirror is needed.
- **Bootstrap syntax — `??=` removed (Chromium 80 on 0.6.x).** The serialized `bootstrapNamespace` used the
  ES2021 logical-assignment `this.contexts[id] ??= {}`; Chromium 80 (Obsidian 0.6.x, Electron 8) cannot
  parse it → `SyntaxError`, so the namespace never bootstrapped. Rewritten to a plain guard. **Keep the
  serialized bootstrap ES2020-safe** — no logical-assignment (`??=`/`||=`/`&&=`), `.at()`, `Object.hasOwn`,
  etc. — so it parses on the oldest supported Chromium.
- **Base-path — `getBasePath()` → `.basePath` fallback.** `FileSystemAdapter.getBasePath()` is absent on
  0.6.x (the `.basePath` property holds the path; the method exists from ~0.9.20). Both readers —
  `pollVaultBasePath` and the transport's `probeVaultPath` — fall back to the property.
- **Closure path — community-plugin API guards (`evalWrapper` / `getObsidianModule`).** `evalWrapper` called
  `plugins.isEnabled()` and `getObsidianModule` used the temp-plugin `loadPlugin` + `manifests` trick — all
  absent or partial on the pre-plugin-API band (0.6.4–0.9.6: `plugins` exists but has no `isEnabled`, and the
  `loadPlugin` + `manifests` registry is absent or incomplete). Both now probe a local `PluginsLike` optional-member
  view (casting past `obsidian-typings`' always-present declarations avoids a false `no-unnecessary-condition`)
  and degrade gracefully: `evalWrapper` skips plugin-enable, and `getObsidianModule` returns `null` (warning
  once via `console.warn`) only when the registry is absent entirely (`loadPlugin`/`manifests` missing — the
  **0.6.4–0.9.6** band, which predates community plugins, so there is genuinely no way to resolve the module;
  `require('obsidian')` fails outside a plugin-load context too). Where the registry exists, it MAKES the trick work (next bullet), so
  `obsidianModule` resolves **down to 0.9.7** (the first version with the API).
- **Off-screen hiding — `require('electron').remote` fallback (fixes an Electron-10 boot wedge).**
  `moveOwnedWindowOffscreen` polled `window.electron.remote` every 250 ms for 20 s; old versions have no
  `window.electron`, so it hammered the renderer with CDP round-trips through the **whole boot**, which on
  **Electron-10-era builds (~0.8.0–0.9.19) intermittently prevented the workspace from initializing** →
  flaky readiness timeouts. Fix: resolve the bridge via `window.electron.remote` OR the built-in
  `require('electron').remote` (the node-integrated renderer exposes it on the Electron 8-13 shells old
  Obsidian ships; removed in Electron 14+). The move now **succeeds on the first eval** on old versions too —
  ending the boot hammering (reliable readiness) AND actually hiding old windows. Modern is unchanged
  (`window.electron.remote` wins; the `require` fallback is never reached). *(Credit: the `require('electron')`
  approach was the user's suggestion.)*
- **Readiness reconnect-on-retry + relaunch-retry.** Old (Electron-10) Obsidian reloads the owned window
  during boot; the readiness poll `disconnect()`s on each failed attempt so it re-binds to the live
  post-reload context. On top of that, `registerVaultInOwnedInstance` wraps launch → move-offscreen →
  readiness in a **relaunch loop** (`OWNED_LAUNCH_MAX_ATTEMPTS = 3`, with a settle between): the Electron-10
  builds intermittently boot with `window.app` present but the workspace never initializing, so a fresh
  instance is an independent chance. Deterministic failures (dead boot, silent asar fallback) are re-thrown
  at once, never retried.
- **`getObsidianModule` MAKES the temp-plugin trick work on a partial plugin API (does not give up).** The
  trick resolves `require('obsidian')` — which only works inside a plugin-load context — by writing a temp
  plugin at `<vault.configDir>/plugins/<id>` and `loadPlugin`-ing it. The API is **partial on the earliest
  versions that have it**, worked around in two ways. **(1) Undefined `configDir` + missing dir chain** (e.g.
  **0.9.10**): `manifests`/`loadPlugin` exist but `vault.configDir` is undefined and, on a fresh vault, the
  `.obsidian/plugins` dir is absent — and `adapter.mkdir` is not recursive, so the original `mkdir` `ENOENT`'d.
  Fix: default `configDir` to `.obsidian` (via a `VaultLike` cast) AND create the config/plugins dir chain
  (each guarded by `adapter.exists`) before writing the temp plugin. **(2) Absent `uninstallPlugin`**
  (**0.9.7**, the FIRST version with `loadPlugin`/`manifests`): the cleanup `uninstallPlugin(id)` does not
  exist yet and the module is already captured by then, so the unguarded call threw `uninstallPlugin is not a
  function` and lost the module. Fix: guard it behind a `PluginsLike` optional-member probe — uninstall when
  present, else let the temp plugin linger harmlessly in the ephemeral owned vault. CDP-confirmed: **0.9.7
  (asar-swapped onto the 0.9.6 shell), 0.9.10, and 0.9.11 now return an `obsidianModule` object** (previously
  `undefined` / a crash). The earlier "wrap in try/catch → return `undefined`" was a give-up hack and was
  replaced. `null` (with a one-time `console.warn`) remains only for the no-registry band (**0.6.4–0.9.6**).
- **Test** — pure unit test (`owned-vault-seed.test.ts`) for the seed shape; opt-in heavy integration test
  `src/owned-vault-open.integration.test.ts` (`OBSIDIAN_TEST_OLD_VAULT_OPEN=1`) pins **0.6.4** (the oldest
  supported installer), which exercises the whole old-version stack at once — auto-open (`last_open`), the
  `??=` bootstrap, `onLayoutReady`, `getBasePath`, the plugin-API guards, and the `require('electron')` hide —
  asserting readiness plus an app-only `evalInObsidian` closure sees the seeded vault.
- **All 103 catalogued installer versions were validated one-by-one** (readiness + app-only closure), and
  each version's `process.versions` collected into `metadata.json` `runtimeVersions` (+ `ecmaScriptVersion`)
  in the same pass. **Operational caveat:** the Electron-10 band (0.8.12–0.9.17, cr85) has flaky
  workspace-init under **rapid** boot/kill churn — a batch of many back-to-back owned boots degrades the
  host's GPU/compositor state (from force-kills) and starts failing even Electron-11/17 builds; it self-heals
  after an idle period. When bulk-booting many old versions (e.g. `collect-runtime-versions`), pace them with
  a cool-down between boots. The relaunch-retry covers ordinary single-use flakiness.

## L27. Fail-fast + observable Android auto-provisioning (Appium server / emulator / AVD)

L22 auto-installs the Appium toolchain, but a first run on a machine with only the Android SDK + `adb`
(no global Appium, no booted AVD) still **spun the full 180 s `appiumStartTimeout` on "Appium server not
ready yet"** and then hung on teardown, with **no diagnostics** — the T84 report. Root cause: the
auto-started Appium server was **fire-and-forget** (`startAppiumServer` spawned `npx appium` with
`stdio: 'ignore'`, watching neither `exit`/`error` nor output), so `waitForAppiumReady` polled `/status`
blindly for the whole timeout no matter why the server failed to come up. The emulator path already did
the right thing (`startEmulator` pipes output, captures a bounded tail, detects early `exit` →
`buildEmulatorExitMessage`), but had its own two gaps. This section gives the server the same treatment
and closes the emulator's gaps, so the Android path is either turnkey **or** fails fast with an actionable
message — never a silent full-timeout spin.

- **Shared exit-message builder** — `src/process-exit-message.ts` (pure, unit-tested;
  `process-exit-message.test.ts`): `buildProcessExitMessage({ subject, exitInfo, output, outputLabel })`
  and the `ProcessExitInfo` shape (`code`/`signal`, plus `spawnError` for a process that never started).
  Replaces the old inline `buildEmulatorExitMessage` (now gone) and is reused by both the emulator and the
  Appium server. The `ProcessLaunch` interface (in the factory) unifies what `startEmulator` /
  `startAppiumServer` return.
- **Appium server is now observed like the emulator.** `startAppiumServer` returns a `ProcessLaunch`:
  even when the console is hidden it pipes stdout/stderr (`stdio: ['ignore','pipe','pipe']`) so an early
  failure's output is captured (`windowsHide` still suppresses the window), and it records `exit` **and**
  a spawn `error` (ENOENT) as a `ProcessExitInfo`. `waitForAppiumReady` takes the launch and, each poll
  iteration, checks `readExitInfo()` **first** — if the server already died it throws
  `buildProcessExitMessage(...)` with the captured tail **immediately** instead of polling out the
  timeout; the timeout path also appends the tail.
- **`--no-install` on the server spawn.** The spawn is `npx --no-install appium …` (was `npx appium`).
  Appium is guaranteed present by `ensureAppiumInstalled` before this point, so `--no-install` stops npx
  from silently attempting a slow/hung fresh **registry download** in a hidden console whenever it can't
  resolve the global install (e.g. a global prefix not on PATH) — a prime suspect for the original spin.
- **`ensureAppiumInstalled` re-verifies after `npm install -g appium`.** A global install can land under
  an npm prefix whose bin dir is not on the spawn PATH (this host's is the scoop/nvm-managed
  `…\scoop\apps\nvm\current\nodejs\nodejs`), so it re-probes `npx --no-install appium --version` and, if
  still non-zero, **throws** an actionable error (points at `npm config get prefix` / PATH, and the
  `shouldAutoInstallAppiumDependencies: false` opt-out) rather than proceeding to a server that can never
  start.
- **Emulator gap 1 — spawn `error`.** `startEmulator` now also listens for `error` (previously only
  `exit`), recording a synthetic `ProcessExitInfo { spawnError }`. A missing/broken emulator binary
  (ENOENT emits `error`, not `exit`) now fails fast via the existing boot/new-device exit checks instead
  of spinning the full 120 s boot timeout.
- **Emulator gap 2 — AVD preflight.** `ensureDeviceConnected` calls `ensureAvdExists(avdName)` before
  spawning a new emulator (skipped when the AVD is already running): it runs `emulator -list-avds` and, if
  the requested AVD is absent, throws naming the **available** AVDs. AVD creation is deliberately **not**
  automated (system-image download + license acceptance + hardware/API-level choices are too opinionated
  to bake in — the fail-fast-only decision for T84). The parse is pure/unit-tested — `src/avd-list.ts`
  (`checkAvdExists` / `listAvailableAvds`, `avd-list.test.ts`); the `execFile` orchestration stays in the
  `v8 ignore` factory.
- **Pure/testable split** mirrors L21–L25: message-building and list-parsing live in unit-tested modules
  (`process-exit-message.ts`, `avd-list.ts`); only the spawn/`execFile` glue stays in the integration-only
  factory.

## L28. Multi-window CDP routing — match a target by its base path, never by count

The desktop CDP transport routes each `evalInObsidian({ vaultPath })` to the correct Obsidian window by
its vault base path. **In attach mode a single owned instance can hold several vault windows at once** (the
global-setup shared vault + any vault a worker registers in-worker), so routing must always be by identity,
never "there is only one window, use it".

- **`findTargetForVault` matches by probed base path only.** It probes every page target's
  `app.vault.adapter.getBasePath()` and returns the one that matches `vaultPath` via **`areVaultPathsMatching`**
  (`src/vault-path-match.ts`, pure + unit-tested — normalizes separator flavor and, on a case-insensitive
  filesystem, case; on Windows `getBasePath()` and the Node `TemporaryVault` path are backslash-identical, so the
  normalization is defensive). There is **no `targets.length === 1` shortcut** — returning the sole window
  blindly mis-routes whenever the requested vault's window is not (yet) the one open. A target whose probe
  *throws* is treated as not-ready and skipped (the caller's readiness poll retries); a target whose probe
  *succeeds but does not match* is never returned; when nothing matches it throws so the caller keeps polling.
- **`openVaultInRunningInstance` bootstraps the helper namespace against the EXISTING window.** The
  `vault-open` IPC is sent through an already-open window (`targets[0]`), so the namespace must be
  bootstrapped on *that* window — it probes `targets[0]`'s own base path and
  `ensureNamespaceBootstrapped(this, existingBasePath)`. Bootstrapping against the not-yet-open `vaultPath`
  (the pre-fix bug) routed through `findTargetForVault(vaultPath)` with only the existing window present and
  **poisoned the connection cache** (label `vaultPath`, socket → the existing window), so every later
  `evalInObsidian({ vaultPath })` mis-routed to the shared window (the closure saw the shared vault's name
  and none of the fresh vault's plugins — the T116 symptom).
- **Why OIT's own suites never caught it:** the `integration-tests` project registers **in-worker → owned
  mode**, where every `register()` relaunches a fresh single-window instance, so a second window never
  exists. Only attach mode (`integration-tests:owned-attach`, and real consumers like ODU) opens a second
  window. Regression coverage: the "second registered vault routes to its own window" case in
  `owned-instance-worker-attach.integration.test.ts` registers a second vault against the shared instance
  and asserts its evals see the fresh vault, not the shared one.

## L29. Node-side kick-off + poll (`pollInObsidian`)

A single `evalInObsidian` closure cannot run past CDP's ~30s `Runtime.evaluate` cap, so a long-running
in-Obsidian operation (e.g. a whole plugin/vault bootstrap) cannot be awaited inside one closure.
`pollInObsidian` (`src/poll-in-obsidian.ts`, exported from the barrel) drives it from **Node** instead:
an optional short `start` closure kicks the work off once, then a short `poll` closure is re-evaluated on
an interval — each a separate, well-under-30s eval — until the Node-side `until(result)` predicate accepts,
or a Node-side `timeoutInMilliseconds` (default `120000`) elapses. `input` / `contextId` / `transport` /
`vaultPath` are forwarded to every underlying `evalInObsidian` (a shared `contextId` lets `start` stash
non-serializable state that `poll` reads). It replaces the per-test hand-rolled `evalInObsidian` + `sleep`
loop.

Pure/testable split (mirrors L18/L21–L27): the timing loop is the pure, unit-tested **`pollUntil`**
(`src/poll-until.ts`, clock + sleep injected for deterministic tests); `pollInObsidian` is the thin
integration-only wiring (drives a live Obsidian), `v8 ignore`d and covered by
`poll-in-obsidian.integration.test.ts`.

## L30. Security overrides (`brace-expansion` GHSA-mh99-v99m-4gvg)

`npm audit` reported 27 high advisories, **all** of them the same root cause: `brace-expansion`
[GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) (DoS via unbounded expansion). The
fix ships **only** on the `5.x` line, and the advisory's vulnerable range is `<= 5.0.7` — which covers every
`1.x` / `2.x` / `3.x` release, so a backport alone would not clear the audit; the advisory metadata itself has
to stop covering the legacy lines. Nothing here depends on `brace-expansion` directly: it arrives through
`minimatch@3` / `@5` / `@9`, which pin the unpatched `1.x` / `2.x` lines. `npm audit fix` cannot resolve it
(its only offer downgrades unrelated packages), so the `overrides` block carries the fix — the same shape ODU
uses (see its AGENTS.md "Security overrides"):

| Override | Vulnerable path it closes |
| --- | --- |
| `glob` → `^13.0.6` | `@jest/reporters`, `jest-config`, `jest-runtime` (`^10.5.0`), `@wdio/config` (`^10.2.2`) and `archiver-utils` (`^10.0.0`) all resolved `glob@10` → `minimatch@9`; `test-exclude@6` pulled `glob@7` → `minimatch@3`. `glob@13` is on `minimatch@^10`, which uses the patched `brace-expansion@5`. |
| `test-exclude` → `^8.0.0` | `babel-plugin-istanbul@7` pins `test-exclude@^6`, whose own `minimatch@^3` is unpatched. `test-exclude@8` moved to `minimatch@^10`. |
| `readdir-glob` → `^3.0.0` | `archiver@7` pins `readdir-glob@^1.1.2` → `minimatch@5`. `readdir-glob@3` is on `minimatch@^10`. |

Result: one deduped `brace-expansion@5.0.8` and one `minimatch@10.2.5` in the whole tree, and a clean
`npm audit`. Call sites were verified against the new majors rather than assumed — `glob@13` still
exports the callable `glob()` plus `glob.sync` / `globSync` / `hasMagic` (what the Jest, WDIO and archiver
packages call), `test-exclude@8`'s default export is still a `new TestExclude(...)` with `shouldInstrument()`,
and `readdir-glob@3` is still a callable factory emitting `match` / `end`. `glob@13` requires Node
`18 || 20 || >=22`.

**Remove all three** once the advisory stops flagging the legacy lines (test with
`npm audit --json` after `npm update`, not just `npm view brace-expansion versions --json`: as of 2026-07-29
the legacy heads are `1.1.17` / `2.1.3` / `3.0.5` and all are still inside the `<= 5.0.7` range, so the
maintenance releases that already landed changed nothing). These overrides exist purely for the advisory —
per G41 they go as soon as it does.

## L31. Leftover cleanup — sweep at both ends; device unconditional, host age-gated

**A run that dies cannot clean up after itself, and on Android that is the normal case.** Teardown removes
the vault through the WebView, and a dead WebView is exactly what most Android failures are — the logs say so
directly: `Vault cleanup error (non-fatal): no such window`. So every failure leaks a `temp-vault-*`
directory **and leaves it registered**, which is work Obsidian redoes at every startup, inside the same
WebView-readiness budget the run is already straining. Failures therefore make the next failure likelier,
which is why six Android runs of one unchanged build gave 2 passes and 4 failures in a single afternoon
(T265): every failure landed in global setup or the first test, never in an assertion, wearing four different
masks (`Plugin … is in the enabled set but not loaded`, `invalid session id`, `no such window`,
`No WEBVIEW_md.obsidian context found within 60000ms`) that all mean "the WebView never came up". The AVD held
**103 leftover vaults**; the host held **312** `temp-vault-*` plus **331** owned `userdata-*` profiles. It is
about Obsidian's startup enumeration cost, not disk space (the 103 vaults were ~108 MB).

**The start-of-run sweep is the half that breaks the loop, because it runs before anything that can die.**

- **Device (Android)** — `AppiumTransportFactory.sweepDeviceLeftoverVaults`, called from `createNewSession`
  after the device is connected and **before `remote()`** (which launches Obsidian via
  `appium:appPackage`/`appActivity`) — the last point at which nothing has to enumerate vaults yet, and the
  only sweep that needs no WebView. `adb shell ls -1 <vaultBasePath>` → `filterLeftoverNames` → one
  `adb shell` recursive delete, with the paths passed as `exec`'s `ExecArg` `batchedArgs` so a device holding
  a hundred leftovers is split at the platform's real command-line limit rather than a hand-rolled count.
  Not in `attachToExistingSession` — a worker must never sweep.

  A `temp-vault-*` **glob** would also work (Windows spawns `adb` with no shell, and on Unix the absolute
  path cannot match on the host so the literal survives to the device shell). Enumerating is preferred
  because it yields the removed **count** for the log — the very diagnostic that made T265 a task — reuses
  the same unit-tested selection rule as the host sweep, including its `excludedNames` hook, and does not
  lean on two layers of "unmatched glob stays literal".
- **Device registry** — `AppiumTransport.registerVault` prunes the **other** `temp-vault-*` entries from
  `mobile-external-vaults` (and their `enable-plugin-<path>` keys) in the same `browser.execute` that adds its
  own, since it already holds a healthy WebView there. It is this registry, not the filesystem, that Obsidian
  enumerates at startup, so sweeping the directories alone would still leave the list long.
- **Device teardown** — `AppiumTransport.unregisterVault` now removes the vault directory over `adb`
  **whether or not the `localStorage` step succeeded** (that step is wrapped in `try`/`catch`). Routing the
  removal through the app is what made every failed run leak its vault.
- **Host** — `sweepHostLeftovers` (`leftover-cleanup.ts`) removes `temp-vault-*` under `tmpdir()` and
  `userdata-*` under `<tmpdir>/obsidian-integration-testing`. Wired into `coreSetup` (before the transport is
  created) and `coreTeardown`, so Vitest / Jest / Manual all inherit it per **L6**, plus `connectToCdp`,
  which mints the same directories outside the core.

**The two halves gate differently, and the asymmetry is the point:**

| Sweep      | Gate                                      | Why                                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device** | Unconditional                             | Android runs hold the exclusive `android` setup lock (**L7**), so no concurrent run can own a device vault. An age gate would let a vault leaked ten minutes ago survive into the next run — precisely the loop this exists to break.                                                 |
| **Host**   | Older than `leftoverMaxAgeInMilliseconds` | Desktop runs are deliberately **not** serialized (**L7** — each owns an isolated instance), and every project on the machine shares one `tmpdir()`. A young directory may belong to a live run of another repo; one was observed being written four minutes before this work started. |

**Knobs** (on **both** transport option interfaces, per **L6**): `shouldSweepLeftovers` (`@default true`)
and `leftoverMaxAgeInMilliseconds` (`@default 7200000`, `0` disables the host age gate; the device sweep
ignores it by design). `shouldSweepLeftovers` is threaded into `AppiumTransportConfig` so the
`localStorage` prune honours it too — but unregistering **this run's own** vault always happens; that is
teardown, not a sweep.

**`leftover-cleanup.ts` is deliberately NOT `v8 ignore`d.** `filterLeftoverNames` / `checkIsLeftoverStale` /
the two resolvers are pure, and `sweepHostLeftovers` takes injectable `roots`, so the whole module is
unit-tested against mocked `node:fs/promises` (**G16** — unit tests never touch the real filesystem) rather
than hidden from the 100% gate. It also owns the `TEMP_VAULT_DIR_PREFIX` / `OWNED_USER_DATA_DIR_PREFIX` /
`HARNESS_TEMP_DIR_NAME` constants that `temporary-vault.ts` and `transport-factory.ts` now build their paths
from, so the sweeper and the creator can never disagree about what the residue is called.

Everything is best-effort: an unreadable root, an entry that cannot be `stat`ed, and a directory another
process still holds (Windows `EPERM`) are counted and skipped, never thrown — a sweep must not fail the run
it is cleaning up for.

Manual fallback when investigating: a recursive `adb shell` delete of `/sdcard/Documents/temp-vault-*`, with
`adb shell ls /sdcard/Documents | wc -l` and `adb shell df -h /data` to see the damage.

## L32. Version matrix — both G99 ends by default, de-duped on the **resolved** version

G99 makes support a **range**, `[latest public, latest catalyst]`, with **both ends verified**. The ends move
independently and periodically **coincide**: when public catches up to catalyst, `public-latest` and
`catalyst-latest` provision the same build. Before this, every consuming repo discharged the duty by hand
with two scripts, so the coincidence meant the second run re-ran the first build — while the project still
reported "green on public AND catalyst", a two-end claim nobody had verified. The Blueprint fork's
`AGENTS.md` carried exactly that stale claim ("catalyst 1.13.4, public-latest 1.12.7") long after public had
moved to 1.13.4; the only evidence was the `[version-switch] Using cached asar for 1.13.4.` provisioning line
(T266).

The harness resolves both channels before it launches anything, so it decides once instead of making every
consumer decide.

- **`runObsidianVersionMatrix({ run, versions })`** (`run-version-matrix.ts`, exported from the barrel) runs a
  suite once per **distinct** version. `versions` takes an array or a comma-separated string, so
  `process.env['OBSIDIAN_VERSION']` passes straight through; omitted/empty ⇒
  `DEFAULT_OBSIDIAN_VERSION_SPECS` = `['public-latest', 'catalyst-latest']`.
- **De-duplication is keyed on the RESOLVED version, never the specifier string.** `['1.13.4',
  'catalyst-latest']` collapses when catalyst *is* 1.13.4, exactly as the two aliases do when the channels
  converge. Keying on the string would only have caught the literal-duplicate case, which is not the one that
  bites.
- **The loop lives above the transport, in a runner — deliberately not in a Vitest-config helper.** A test
  framework's global setup **cannot re-run its own test files**: it launches one instance for one run. A
  config helper expanding one project into N (`integration-tests:desktop@1.12.7`, `…@1.13.4`) would carry the
  version in the project name for free, but it is Vitest-only and needs an async manifest fetch at
  config-load time. The runner takes the suite invocation as a `run` callback instead, so it never launches
  anything itself and Vitest / Jest / Manual all inherit it per **L6**.
- **Only the runner's default is both ends.** `obsidianVersion` with no explicit pin still means "whatever
  your installed Obsidian runs", so `connectToCdp()`, the CLI (**L10**), and suites not using the runner are
  untouched. The two-end default applies exactly where the G99 duty applies.
- **Every version runs before anything is reported** (not fail-fast): stopping at the first failure leaves
  "catalyst broke" and "both ends broke" indistinguishable without a second run. The thrown `AggregateError`
  names the failed and passed versions and carries each underlying error.
- **The collapse is always logged, never inferred** — `2 requested specifiers resolve to 1 distinct version:
  1.13.4 (public-latest, catalyst-latest). Running the suites once.` A reader seeing one run where they
  expected two must be told the second end was already covered, not left guessing whether it was skipped by
  accident. That line is the whole point of the change.
- **Missing-channel degradation.** Making catalyst part of the *default* means a manifest that momentarily
  ships no `beta` entry would newly break every consumer's gate. So a **default** specifier that cannot
  resolve is dropped with a logged reason, while an **explicitly requested** one still throws; an empty
  resolution set always throws rather than silently verifying nothing.

**Pure/glue split** (as **L20**/**L18**/**L31**): every decision — normalizing the requested specifiers,
resolving them against a manifest, de-duplicating, sequencing, and formatting the plan/summary lines — is
pure and unit-tested in `version-matrix.ts`. Only the single manifest fetch and the `log` calls are
`v8 ignore`d, in `run-version-matrix.ts`. `version-matrix.integration.test.ts` drives the real manifest with
a stub `run` callback, so it exercises the live collapse in under a second and launches no Obsidian. It
asserts **uniqueness**, not a fixed run count — the channels converge and diverge over time, and a test
pinned to today's count would fail the moment catalyst moves ahead.

**Not yet adopted by consumers.** Blueprint (P36) and the 23 plugins still run two desktop scripts; migrating
them (collapse into one, delete `test-integration-desktop-catalyst.ts`) is follow-up work. Their `run`
callbacks must keep hand-spawning vitest because `obsidian-dev-utils`' `test()` helper does not propagate
`OBSIDIAN_VERSION` to the child — teaching it to forward env belongs in ODU. Android is unaffected: the
Appium transport runs the installed APK and takes no `obsidianVersion`.

## L33. Owned instances die with the harness — a socket, not a parent/child link

**Being a child process buys nothing.** The owned instance is already spawned from the harness
(`obsidian-instance.ts`), but no operating system turns that into a lifetime guarantee. Windows never
propagates a parent's death to its children — an orphan just keeps running with a stale parent id — and on
POSIX a `SIGKILL` aimed at one pid never cascades either. The instance is additionally spawned `detached`,
so it is not even in the harness's process group. Teardown therefore rests entirely on the harness running
`killProcessTree` from its own `exit`/signal handlers, which is exactly what a `SIGKILL`, a Task Manager
kill, or an IDE stop button denies it. Each such kill leaked a hidden Obsidian holding a user-data dir and a
CDP port, and they accumulated silently: the next run picks a fresh temp dir and a free port, so nothing
collides and nothing complains. **L31 sweeps leaked directories, not leaked processes** — the two are
complementary, and neither substitutes for the other.

**Why not the real primitive.** The guaranteed fix is a Windows Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (the OS kills the job when the last handle closes, `TerminateProcess`
included), or `prctl(PR_SET_PDEATHSIG)` on Linux. Neither is reachable from Node without a native addon —
too heavy a dependency for this harness, and it would put a compile step in every consumer's install.

**What we use instead.** The one cross-platform resource the kernel reclaims deterministically on process
death: a socket. `parent-liveness.ts` listens on an ephemeral loopback port **before** the spawn; once the
vault is ready the transport evaluates `buildParentLivenessWatchdogExpression(port)` in the renderer, which
`require('node:net')`-connects back. However the harness dies, the kernel closes its end, the renderer sees
`close`, and the window destroys itself. No polling, no heartbeat interval, no timeout to tune. This is the
mirror image of `obsidian-dev-utils`' `watchDevInstanceAndStopOnClose`, which stops the dev build when the
instance is closed; together the two make neither able to outlive the other.

**Fail-open, deliberately.** The renderer arms the destroy handler only after the connection is actually
established, and a renderer without Node access reports `'unavailable'`. A watchdog that cannot reach the
harness leaves the instance running rather than killing a window a developer is working in; arming failures
are logged and swallowed, never fatal to a launch. Arming is idempotent — a retried readiness pass finds the
stored socket and returns `'already-armed'` rather than opening a second connection.

**Pure/glue split** (as **L20**/**L18**/**L31**/**L32**): the server and the expression builder live in
`parent-liveness.ts` and are fully unit-tested — the server against real loopback sockets, the expression by
evaluating it through `new Function('window', …)` against a stubbed `window`, which is what lets the
destroy/fail-open/fallback branches be driven without a renderer. Only the wiring in `obsidian-instance.ts`
and `transport-desktop-cdp.ts` is `v8 ignore`d. The expression is written in ES5 style (`var`, `function`,
no optional chaining) for the same reason as `DISMISS_TRUST_DIALOG_EXPR`: it has to parse on the Chromium
80-era renderers of the oldest supported Obsidian versions (**L26**).

## L34. Lint — `eslint-plugin-unicorn`, ported from `obsidian-dev-utils`

`scripts/eslint-config.ts` is a hand-maintained sibling of `obsidian-dev-utils`' shared config (this repo
deliberately does **not** depend on ODU — see **L17**), so ODU's new rules are ported here by hand. The
`unicorn` block mirrors ODU's, with three groups of deviations that are this repo's and must not be "synced
away":

- **The ES2022 floor is shared, so the same six rules stay off.** `no-array-reverse`, `no-array-sort`,
  `prefer-array-from-async`, `prefer-iterator-helpers`, `prefer-iterator-to-array`,
  `prefer-promise-with-resolvers` and `prefer-set-methods` all suggest APIs newer than `lib: ES2022`, which
  `metadata.json` pins to installer 1.1.9 (**L20**). `prefer-url-can-parse` is off for the matching Node
  16.16.0 floor. Revisit them together if that floor moves.
- **Harness-shaped patterns the rule cannot see.** `no-global-object-property-assignment` (installing
  `__obsidianIntegrationTesting` onto `globalThis`/`window` is what this package *does*),
  `no-top-level-side-effects` and `no-top-level-assignment-in-function` (the framework setup entry points
  register their resolvers at import time — **L6** — and the transport cache / cleanup once-guard are module
  singletons by design), `prefer-await` (fire-and-forget `.catch()` on scheduled work), and
  `no-nonstandard-builtin-properties` (the rule's `Symbol` table predates `Symbol.asyncDispose`).
- **Names that are NOT ours to expand.** `unicorn/name-replacements` runs with `checkProperties: true` and NO
  exemption for this package's own vocabulary — the public surface was renamed to satisfy it rather than
  configured around (see the breaking renames below). The only escapes are individual sites mirroring a name
  a *dependency* owns: Obsidian's `PluginManifest.dir` and `Vault.configDir`, Jest's `rootDir`, Vite's
  `server.deps`, `typescript-eslint`'s `tsconfigRootDir` / `args` / `argsIgnorePattern` / `varsIgnorePattern`.
  Those carry a scoped disable, because renaming them would simply stop the option being read.
  `consistent-boolean-name` keeps `check` as a recognized prefix, which validates the `checkIs*` predicate
  family (`checkIsLockStale`, `checkIsRemovableDirectory`, `checkIsProcessAlive`, ...); the verdict-returning
  functions that used to collide with it are now `resolve*`.

**Breaking public renames this rule forced** (all consumer plugins must follow):

| Before | After |
| --- | --- |
| `evalInObsidian({ fn, args })` / `pollInObsidian({ args })` | `evalInObsidian({ callback, input })` |
| `CommonArgs` / `ContextArgs` / `ExecArg` | `CommonArguments` / `ContextArguments` / `ExecArgument` |
| `TempVault` / `getTempVault()` / `tempVaultPath` | `TemporaryVault` / `getTemporaryVault()` / `temporaryVaultPath` |
| `checkAsarFallback` / `checkElectronCompatibility` / `checkInstallerCompatibility` | `resolveAsarFallback` / `resolveElectronCompatibility` / `resolveInstallerCompatibility` |
| `InjectPluginParams.sourceDir` | `InjectPluginParams.sourceDirectory` |
| `OwnedInstanceConfig.userDataDir` | `OwnedInstanceConfig.userDataDirectory` |

`fn`/`args` could NOT take the rule's own suggestions: `function` and `arguments` are reserved words and
cannot be binding names in a module, so the rule falls back to `function_` / `arguments_`. Since consumers
destructure both inside closures (G76), the names had to be real identifiers — hence `callback` / `input`.

Two contracts deliberately did NOT change, and must not be "fixed" to match: the on-disk leftover-sweep
prefixes (`TEMP_VAULT_DIR_PREFIX = 'temp-vault-'`, **L31**) — renaming them would orphan existing leftover
directories — and Electron's `--user-data-dir` switch string. Two **wire formats** between Node and the
renderer did change: `evalWrapper`'s (`{ fn, args }` → `{ callback, input }`) and `ipcSendSync`'s
(`{ channel, args }` → `{ channel, channelArguments }`). Both are safe only because `getBootstrapVersion()`
keys off `LIBRARY_VERSION`, so a stale namespace in a running Obsidian is re-bootstrapped on the version bump
that ships this. Neither belongs in the table above: the namespace payload types are closure-local to
`namespace-bootstrap.ts` (`EvalWrapperParams`, `IpcSendSyncParams`) and the payloads themselves are JSON
literals `transport-desktop-cdp.ts` writes, so no consumer can name either — nothing to follow. The table
did carry an `IpcSendSyncNamespaceParams` row until T812, naming a type in `src/obsidian-namespace.ts` that
was never once re-exported; that file is gone (**L2**).

**Never run `--fix` over `unicorn/name-replacements`** without `tsc` + the full suite behind it: its fixer is
not reference-aware for enum members, interface members, and parameter properties, and object-literal keys in
loosely typed positions are not contextually typed, so a rename can leave a dangling reference the compiler
never sees. The vendored ambient declarations under `scripts/helpers/@types/` are exempt from it (and from
`prefer-type-literal-last`, which fights `perfectionist/sort-union-types` there in a non-converging fix loop)
because their names come from a dependency's published schema.

## L35. Documentation site (`docs/`) — an Astro + Starlight copy-sync of `obsidian-dev-utils`

The user-facing docs are an Astro + Starlight site under `docs/`, served at
`https://mnaoumov.dev/obsidian-integration-testing/`. `README.md` is now only an overview plus links into
it (G59 "split when too big"; this repo is tooling, not a plugin, so `docs/` is the right destination).

- `npm run docs:build` — generate the API reference, generate the OG cards, `astro build`, then the link
  check. `docs:dev` runs the generator plus a foreground dev server; `docs:preview` serves the last build.
- `.github/workflows/build-pages.yml` deploys it: a published **release** dispatches the workflow again on
  `main` (the `github-pages` environment refuses a deploy from a tag), which builds and deploys. It caches
  the two slow artifacts (the ts-morph markdown, the satori PNGs) keyed by the sources that determine them.
- **Generated, gitignored, never edited by hand:** `docs/src/content/docs/api/`,
  `docs/src/generated-sidebar.json`, `docs/public/og/`, `docs/dist/`, `.astro/`.
- `scripts/docs-gen/**` is excluded from the root `tsconfig.json` (it has its own, bundler-resolved) and
  from dprint + cspell, so the vendored copy stays byte-comparable with ODU's. It IS linted, and its unit
  tests run in the `unit-tests:scripts` Vitest project (`npm test` runs it alongside `unit-tests`).

### The copy is a sync, not a fork — four deliberate divergences

`scripts/docs-gen/**`, `astro.config.ts`, the `docs-*.ts` scripts and `docs/src/{components,styles,
content.config.ts,route-data.ts}` are copied from `obsidian-dev-utils` (same hand-sync discipline as
**L17**; this repo must not depend on ODU, and ODU depends on *this* package, so the edge would be a
cycle). `link-check.ts` and `api-doc-jsdoc.ts` are byte-identical; keep it that way. What differs:

1. **`api-doc-constants.ts`** — `BASE_PATH`, the new `PACKAGE_NAME` / `PUBLIC_API_ENTRY_FILE`, a pruned
   `GENERIC_TYPE_PARAMS`, and a `TS_GLOBAL_TYPES` map scoped to what this package's signatures actually
   mention (Node built-ins, WebdriverIO's `Browser`, Puppeteer's `CDPSession`) instead of ODU's CodeMirror
   and Obsidian-UI entries.
2. **`api-doc-source-processing.ts` — entry discovery follows the barrel, not the file tree.** ODU exports
   one subpath per module, so it walks `src`. Here `src/` also holds the co-located `*.test.ts` suites and
   modules that exist only for the runner adapters, and only `src/index.ts` is public — so
   `findEntryFiles` / `findPublicApiNames` parse that barrel's re-exports, and `computeCacheHash` hashes it
   (a re-export added there changes the output with no entry file touched).
3. **`generate-api-docs.ts`** — filters the collected types down to the barrel's names, *after*
   `resolveInheritedMembers`, so a public class still inherits from an internal base class.
4. **`getImportStatement()`** — every documented name is imported from the package root; the namespace only
   groups the reference by source module, it is not an import subpath.

### Incidental fixes the port forced

- **`js-yaml` override `^5.2.3` → `4.3.1`** — js-yaml 5 is ESM-only with no default export, so `astro build`
  died on import. The `^5.2.3` came from an update sweep, not a requirement; ODU pins the same `4.3.1`.
- **`scripts/helpers/exec.ts` gained an `env` option** — `docs:dev` needs `ASTRO_DEV_BACKGROUND=1`, and
  `CHILD_ENV` snapshots `process.env` at module load, so setting it in the script would not have reached
  the child.
- **`src/type-guards.ts` gained `assertNever`** — the vendored `link-check.ts` imports ODU's.
- **`docs-link-check.ts` rewrites `npmjs.com/package/x` → `registry.npmjs.org/x`** before fetching; npmjs
  answers an unattended `fetch` with 403. Same rewrite `scripts/helpers/markdownlint.ts` gives linkinator.
- **linkinator skips `docs/**`** — in-site links are base-absolute (`/obsidian-integration-testing/...`) and
  only resolve once Astro has built them; `docs-link-check.ts` validates those against the built output.

## L36. Security overrides (`extract-zip` GHSA-jmr9-qjv8-65gv)

`extract-zip` is vulnerable at **every** published version — the advisory range is `*` and `2.0.1` is the
newest release — so there is nothing to override it *to*. It arrives through this package's own
`webdriverio` dependency:

```text
webdriverio → @wdio/utils → @puppeteer/browsers@2.x → extract-zip
```

Lifting the exact `webdriverio` pin would not help either: the newest `@wdio/utils` (`9.30.1`) still
declares `@puppeteer/browsers: ^2.2.0`. So the fix goes one level up — `overrides.@puppeteer/browsers` →
`^3.2.0`, whose `3.x` line replaced `extract-zip` with `modern-tar`. That drops the vulnerable subtree
entirely and **dedupes**: `puppeteer-core` already pulls `3.2.0` here. Verified rather than assumed —
`@wdio/utils` imports exactly `install`, `canDownload`, `resolveBuildId`, `detectBrowserPlatform`,
`Browser`, `ChromeReleaseChannel` and `computeExecutablePath`, all still exported by the installed `3.2.0`,
and both packages are ESM-only.

**Never take `npm audit fix --force` here** — its remedy downgrades `webdriverio` past the version this
harness drives (G100). **Remove the override** when `@wdio/utils` moves to `@puppeteer/browsers@^3` itself;
the `check` in [`pinned-versions.json`](pinned-versions.json) watches exactly that. Same override and same
reasoning as ODU's "Security overrides (`extract-zip` …)"; keep the two in step.

## L37. Release — npm publishes from CI through a Trusted Publisher, not from a token

`npm run version <major|minor|patch|premajor|preminor|prepatch|prerelease|x.y.z>` still drives the release
from the developer machine: it runs the full gate (`format:check`, `spellcheck`, `lint:md`, `build`, `lint`,
`test:coverage`), bumps `package.json` + `package-lock.json`, rewrites `CHANGELOG.md`, commits, tags, pushes,
and creates the GitHub release with the `npm pack` tarball attached.

What it no longer does is publish. It used to read `NPM_TOKEN` out of the gitignored `.env`, write it into
the user npmrc via `npm config set //registry.npmjs.org/:_authToken=…`, and run `npm publish --tag …`. That
long-lived token is replaced by a **Trusted Publisher** (OIDC): npm exchanges the workflow's short-lived
`id-token` for a package-scoped publish credential, so **there is no token to hold and publishing is only
possible from CI** — no local fallback exists, by design.

`.github/workflows/publish-npm.yml` does it, on `release: published`. It checks out the release tag,
installs, **rebuilds** (`dist/` is gitignored, and rebuilding is what makes the provenance attestation
honest — it attests what the workflow built from that commit), derives the dist-tag the way the script used
to (`beta` for an `x.y.z-…` prerelease, else `latest`), and publishes with `--provenance`. Two things are
load-bearing:

- `permissions: id-token: write` on the job — without it npm has no OIDC token to exchange and falls back to
  looking for a credential it will not find.
- **The workflow's filename.** npm authorizes the publisher by *file name*, not path
  (`obsidian-integration-testing` → Settings → Trusted Publisher → workflow `publish-npm.yml`), and
  `scripts/version.ts` polls `gh run list --workflow publish-npm.yml` for the run to watch. Renaming the file
  breaks publishing in both places; `PUBLISH_WORKFLOW_FILE_NAME` is the script's half of that contract.

The script does not fire-and-forget: `watchNpmPublishWorkflow` finds the run by the **commit the tag points
at** (a `release`-triggered run reports the tag rather than `main`, and a re-run keeps the head SHA), then
`gh run watch --exit-status` follows it, so a failed publish fails `npm run version` instead of leaving a
tagged release that silently never reached npm. If the run cannot be found within two minutes it warns with
the Actions URL rather than failing — the release itself is already good, and the workflow can be re-run or
dispatched with the tag as input.

Sibling repos (`obsidian-test-mocks`, and ODU's shared `src/script-utils/npm-publish.ts`) still publish with
`NPM_TOKEN`; this repo is the first one moved.

### `npm pack --json` changed shape in npm 12 — parse it, never cast it (T813-P2)

npm ≤ 11 emitted an **array** of pack results; **npm 12 emits an object keyed by package name**. Both are
valid JSON, so `JSON.parse(output) as [NpmPackResult]` kept parsing happily and then read `filename` off
`undefined`. That is a `TypeError` at `publishGitHubRelease` — the **second-to-last** step of
`updateVersion`, so it fires *after* the gate, the bump, the changelog, the commit, the tag and
`git push --follow-tags` have all already landed on the remote. Cutting 12.0.0 left exactly that: `298fffa`
and a public `12.0.0` tag with **no GitHub release**, so `publish-npm.yml` never fired and nothing reached
npm. There is no re-run from that state — `assertGitRepoClean` passes but `getNewVersion` would bump to
13.0.0.

`scripts/helpers/npm-pack.ts` now owns the read: `parseNpmPackFilename` accepts both shapes, **validates**
rather than asserts, and every failure names the raw output, so the next npm shape change is diagnosable
from the release log instead of from a stack trace. `scripts/helpers/npm-pack.test.ts` pins both
generations against a payload captured from real npm 12 output.

Two notes for anyone syncing this against ODU's copy, which carries the same defect (T806-P1):

- **This repo needs no stdout noise-stripping.** ODU guards with `indexOf('[\n  {')` because its exec helper
  merges the streams. `execString` (`scripts/helpers/exec.ts`) accumulates `stdout` and `stderr`
  **separately** and `execFromRoot(…, { isQuiet: true })` returns `stdout` alone, and npm writes its
  `npm notice run … prepare` lines to `stderr` — so the string reaching the parser is pure JSON. The shape
  was the whole defect here.
- **The two copies are independent by design.** `scripts/version.ts` is not in the **L17** hand-synced set,
  and this repo must never depend on ODU, so fixing one does nothing for the other. Both needed it.

**If a release ever half-fails here again**, `npm pack` has already written the tarball, so recovery needs
no rebuild: `gh release create <version> dist/<tarball> --title v<version> --notes-file <notes>`, the notes
being the `CHANGELOG.md` section for that version plus the
`**Full Changelog**: <repo>/compare/<prev>...<new>` line `getReleaseNotes` would have produced.
`publish-npm.yml` fires on a manually-created release exactly as it would on a scripted one.

## L38. Settings modal — attach the container BEFORE opening (`openSettingsTab`)

`app.setting.open()` on its own does **nothing observable** from a test. `app.setting.containerEl` is built
at startup and is never in the document, and `open()` does not attach it — so the modal builds into a
detached tree, `open()` returns without throwing, and the document a test then reads (or screenshots) is
untouched. `obsidian-backlink-full-path` concluded from exactly this that the settings tab **cannot** be
captured and wrote the impossibility down; the diagnosis was right and the conclusion was not.
`obsidian-frontmatter-markdown-links` skipped the settings shot too but recorded no reason for it — which
is why that shot went just as long without a retry, and is not the same thing as writing an impossibility
down.

The fix is one step, and **its order is load-bearing**: append `containerEl` to `document.body` **before**
`open()`. Attaching afterwards is too late — whatever the modal rendered on open has already gone into the
detached container, so it ends up on screen showing the wrong thing while looking entirely successful. That
is a convincing-looking wrong answer, which is why the harness owns the recipe instead of each plugin
copying it.

Two layers, the same split as `captureObsidianScreenshot` (Node-side) over the renderer-side `lib` bag:

- **`lib.openSettingsTab({ tabId, timeoutInMilliseconds? })`** — a **base** `lib` member
  (`namespace-bootstrap.ts`, typed on `Lib` in `src/eval-in-obsidian.ts`; see **L16**), for a callback that
  also probes the rendered DOM.
- **`openObsidianSettingsTab({ tabId, timeoutInMilliseconds?, transport?, vaultPath? })`**
  (`src/open-obsidian-settings-tab.ts`) — the context-resolving Node-side entry point a screenshot suite
  calls before `captureObsidianScreenshot`.

Both resolve to the `.setting-item-name` texts the tab rendered — the proof it rendered, and what a caller
asserts on. A tab that legitimately renders no such rows (Hotkeys) gives an empty array.

Three behaviors worth knowing, all measured against a live instance rather than assumed:

- **`tabId` is REQUIRED, not optional.** `open()` alone leaves `activeTab === null` and draws **zero** rows
  on a harness-owned instance: the modal restores the profile's last tab, and an isolated profile has never
  opened one. An optional `tabId` would therefore hand back an empty modal — the very symptom being ruled
  out — so the API refuses to express it.
- **An unknown id fails fast, listing the ids that exist**, instead of spending the whole timeout looking
  identical to the does-not-render symptom. Both `settingTabs` (core) and `pluginTabs` (plugins) are
  searched — a plugin's tab is **not** in `settingTabs`.
- **Readiness is polled, never slept.** The recipe was found with a blind `sleep(500)`; the modal's own
  `activeTab.id` + `activeTab.containerEl.childElementCount` are real signals, so the helper waits on those.

**Verified on both transports.** All of the above was first proven against a live desktop instance over
CDP. `obsidian-frontmatter-markdown-links` then ran `openObsidianSettingsTab` unchanged over the **Appium**
transport (2026-08-30): its android capture leg went 3/3 green on a cold AVD, with the plugin's settings tab
rendered and its rows returned. Nothing in the helper is desktop-specific, but that is now measured rather
than assumed.

`app.setting.close()` is the counterpart. Obsidian leaves the container attached on close, and the attach is
a `contains` check, so re-opening simply works.

## L39. Trusted input on mobile — a CDP channel to the WebView, not Appium actions

The trusted-input helpers of **L8** / **L11** / **L14** work on Android too. This section is the *why* of
the mechanism; the helper semantics live with each helper.

### Why the obvious route does not work

Every helper runs **in the renderer**, inside the `lib` bag `evalWrapper` builds. On desktop that is fine:
`electron.remote` bridges into the main process in-band, so `sendInputEvent` is one synchronous call away.
On Android there is **no in-page route to a trusted event at all** — `dispatchEvent` and `element.click()`
are `isTrusted === false` by spec — so the injection has to happen on the **Node** side, and the renderer
has to reach it *mid-closure*.

That rules out Appium's own W3C actions, which is not a preference but a measured constraint:
`AppiumTransport.evaluate` runs the whole closure inside one W3C **Execute Script**, and Execute Script
awaits the promise it returns. While a closure sits waiting on `lib.clickElement(...)`, the WebDriver
session is **busy** and cannot be asked to do anything else. Native injection is also slow
(`switchContext` ~17s, **L19**) and would need a CSS-px → device-px mapping — `devicePixelRatio` plus the
WebView's offset under the status bar — that nothing here computes.

### What it does instead

`AppiumTransport` opens its **own** CDP connection to the WebView (`src/webview-cdp.ts`), independent of
the Appium session:

1. `adb forward` a free port to the app's `localabstract:webview_devtools_remote_<pid>` socket, then the
   usual `/json` endpoint lists the page targets. The WebView's debugger is provably enabled — the
   existing `switchContext('WEBVIEW_md.obsidian')` already depends on it.
2. `Runtime.addBinding` installs a function on the page. The renderer computes the target rect, calls it
   with a JSON request, and awaits.
3. `Runtime.bindingCalled` arrives on **our** socket while chromedriver's Execute Script is still pending
   on **its** socket, so there is no contention. The host injects `Input.dispatchTouchEvent` /
   `dispatchKeyEvent`, then resolves the renderer's promise with a concurrent `Runtime.evaluate`.

**CDP takes CSS pixels in the page's own viewport**, so the device-pixel mapping never has to be written —
the single biggest reason this route is cheaper than the native one.

Measured on a live emulator (2026-08-30) before any of it was built: a CDP touch pair produces
`pointerdown` / `touchstart` / `pointerup` / `touchend` / `click`, **every one `isTrusted: true`**;
`bindingCalled` does fire while an awaited evaluate is pending; and a second CDP client attaches happily
alongside a live Appium session. `src/mobile-trusted-input.android.integration.test.ts` re-asserts the
`isTrusted` half on every run, because that property is the entire point and no weaker observation implies
it.

### Consequences worth knowing

- **The helpers are `Promise<void>`, and the `await` is load-bearing.** `pressKey` / `moveMouse` /
  `clickMouse` / `clickElement` stopped being synchronous when the mobile round-trip was added; the
  declared `Lib` type says so, so `no-floating-promises` forces the `await` rather than letting a missing
  one race the assertion. This supersedes **L17**'s former "must stay synchronous (`void`)" note.
- **The channel is BEST-EFFORT and its absence is not fatal.** It exists only over local `adb`, so there is
  none on iOS or against a remote hub (BrowserStack). `ensureInputChannel` logs and gives up rather than
  failing a run that never drives input; a run that *does* gets a legible error from the renderer's own
  guard, naming the missing channel. A run must never fail because of infrastructure it did not use.
- **The wire format is declared twice on purpose.** `MobileInputRequest` lives in `src/mobile-input.ts` and
  is redeclared inside the bootstrap closure, which is serialized via `toString()` and may not reference
  outer scope (**L15**). The binding name and the request timeout are instead passed *into* the closure as
  bootstrap params, so those two stay single-sourced. Change the redeclared types together.
- **`middle` clicks and hovers throw on mobile, deliberately.** Touch has no middle button and no hover
  state. A silent no-op would leave a test asserting against something that never happened — the exact
  false-confidence failure trusted input exists to end — so the helper says so instead.
- **Long-press is Obsidian's own gesture, not Android's.** Obsidian Mobile implements it in JavaScript on a
  `touchstart` timer, so the 600ms dwell has to clear *its* threshold. A synthetic element with no such
  handler will not produce a `contextmenu` from a dwell, which is why long-press has to be verified against
  a real Obsidian element rather than a probe `div`.
- **`obsidian-dev-utils` reaches this mechanism through `ns.trustedInput`, and only through it** (added
  2026-08-31, T792-P2). Everything above happens inside the renderer closure, so a caller outside the
  harness has no way in — and ODU must never import this package at runtime (ODU **L4**), which rules out
  the direct route. `ns.trustedInput` (`namespace-bootstrap.ts`, **L17**) publishes the seven helpers on
  the namespace object; ODU's mobile mirror reads them off `window.__obsidianIntegrationTesting`. Two
  alternatives were rejected: ODU re-implementing the wire format on top of `resolveInput` (the library
  monkey-patching the harness inverts L4's dependency direction), and shipping a throwing stub in ODU (no
  working mobile path at all). Note the seam publishes the helpers, **not** the channel: `resolveInput`
  and the `Runtime.addBinding` half stay harness-internal.

## L40. Adopting an Appium server is not the same as trusting it (marker + wedged-server recovery)

**L27** made *provisioning* fail fast. This section covers the opposite case: a server that is already
there. The preflight adopts whatever answers `/status` on the port — the right default, since a second
server cannot bind an occupied port — but adoption was unconditional, and **liveness is not readiness**.

The failure that motivated this (T727): a server auto-started by a run ~1h earlier was still listening and
still answering `/status` with `ready: true`, but its `appium-adb` could no longer enumerate devices. Every
session creation then died with `Could not find a connected Android device in 20000ms` while `adb devices`
from the shell listed `emulator-5554` instantly. The error names the wrong subject — it blames a device
that is demonstrably present — so the obvious next diagnostic is the one that misleads. Killing that
server and starting a fresh one fixed the suite with no other change.

- **Provenance is recorded, so it can be reported.** `src/appium-server-marker.ts` writes a per-port JSON
  sentinel (`<tmpdir>/obsidian-integration-testing/<port>.appium-server.json`: `pid`, `port`,
  `startedAtInMilliseconds`) whenever the harness auto-starts a server, and clears it when that server is
  stopped. The preflight log now says which kind of server it adopted — *"started by an earlier run of this
  harness, pid N, up for Ns"* vs *"not started by this harness"* — on **every** run, including ones that go
  on to succeed. A long-lived leftover is therefore visible in the transcript, not only in an error.
- **No preflight can catch the wedge; it is recognized from the failed session.** A wedged server answers
  `/status` normally, so no probe short of creating a session distinguishes it. `src/wedged-appium-server.ts`
  (pure, unit-tested) classifies the failure instead: `checkIsAppiumDeviceNotFoundError` matches
  `appium-adb`'s message through the whole `cause` chain, and `resolveWedgedAppiumServerRemedy` convicts the
  server only when the **host's own adb still lists the device**. If the host cannot see it either, the
  original error was honest and is rethrown untouched.
- **Only a server this harness started is restarted.** `restart` requires: the device-not-found error, the
  host's adb sees the device, the server was *adopted* (not started by this run), auto-start is not disabled,
  and the marker's PID is alive. Then the marked process tree is killed, the port is waited out
  (`waitForAppiumStopped` — a lingering socket would let the readiness poll pass on the dying server), a
  replacement is started, and the session is retried **once**; the replacement is owned by this run and torn
  down with it. Everything else — a foreign/user-managed server, `shouldAutoStartAppium: false`, a server
  this run started itself — is **reported, never killed**. Terminating a process the run does not own is not
  its call to make.
- **The error names the server.** `buildWedgedAppiumServerMessage` replaces the device-not-found text with
  the server's origin, the device the host can see, an explicit warning that `adb devices` will list the
  device and mislead you, and reason-specific advice (foreign server / auto-start disabled / freshly started
  / restart did not help), plus the marker's pid and age when known. The original error is kept as the
  `cause`.
- **`/status` is also read, not just counted.** `checkAppiumReachable` now requires a 2xx and an Appium
  status body that does not report `ready: false` (Appium sets that while shutting down), so a server on its
  way down is no longer adopted as healthy. The parse is deliberately tolerant — a malformed or
  flag-less body reads as ready, since an unrecognized shape must not make a healthy server look
  unreachable. This does **not** catch the wedge, which is why the session-side recognition above exists.
- **Pure/testable split** mirrors L27: classification, remedy and message live in unit-tested modules
  (`wedged-appium-server.ts`, `appium-server-marker.ts`); the spawn/kill/HTTP glue stays in the `v8 ignore`
  factory. `killProcessTreeByPid` was split out of `kill-process-tree.ts` because a marker yields a PID, not
  a `ChildProcess`.

## L41. Headless demo-vault bootstrap — the injected plugins install themselves

- **The problem was a GUI step in the only documented remedy.** `buildDemoVaultPopulate` requires each
  injected community plugin's `main.js` / `manifest.json` to be on disk and throws when they are not — the
  throw itself is deliberate and unchanged. Its message used to name exactly one fix: *open
  `demo-vault/` in Obsidian once so `demo-vault-helper` installs it*. But `.obsidian/plugins/*` is gitignored
  in every fleet plugin repo, so that state lives on the one machine that did it and is invisible to a fresh
  clone, a new machine, or CI — and since a plugin repo's `npm run version` preflight runs
  `test:integration`, **a clean clone could not cut a release** until a human opened a GUI. It surfaced ~7
  minutes into the App Update Notifier 1.0.0 preflight.
- **Downloading the release assets is the exact equivalent.** A plugin's published `main.js` /
  `manifest.json` / `styles.css` are what Obsidian's own community browser installs, so writing them into
  `demo-vault/.obsidian/plugins/<id>/` produces the same folder — and therefore the same fleet-standard
  `*-demo-vault-<version>.zip`, which is supposed to carry `fix-require-modules` anyway.
- **The id → repo mapping is not hardcoded; it comes from Obsidian.**
  `community-plugin-registry.ts` (pure, unit-tested) holds the registry URL —
  `obsidianmd/obsidian-releases`' `community-plugins.json`, the same table the in-app browser installs from —
  the `selectPluginRepo` lookup, and the `buildPluginAssetUrl` shapes for a pinned tag vs the moving latest
  release. `InjectPluginParams.repo` overrides the lookup (and is the only way to bootstrap an unlisted
  plugin); `InjectPluginParams.version` pins a tag.
- **Sync stays sync — that is why there are two entry points, not one.** `fetch` has no synchronous form and
  `buildDemoVaultPopulate` is synchronous, so auto-healing cannot go inside `seedPlugin`. It lives on
  `buildDemoVaultPopulateAsync` (`demo-vault-bootstrap.ts`), reachable because the Vitest **and** Jest
  `populate` thunks now return `PopulateFilesParams | Promise<PopulateFilesParams>` — a widening, so every
  existing synchronous thunk still typechecks and `CoreSetupParams.populate` is untouched (the adapters
  `await` it). The `bootstrap-demo-vault` CLI subcommand is the same installer for a one-off repair.
- **One definition of "missing".** `resolveMissingInjectedPlugins` is exported from `demo-vault-populate.ts`
  and used by both the throw path and the bootstrap, so the two cannot drift. It also owns the opt-out: a
  plugin with an explicit `sourceDirectory` names a **local build output**, never somewhere to download a
  published release into, so it is excluded even under `--force` and gets its own error message.
- **Module direction avoids a cycle.** `demo-vault-bootstrap.ts` imports from `demo-vault-populate.ts`, never
  the reverse — which is why `buildDemoVaultPopulateAsync` lives in the bootstrap module rather than next to
  its synchronous sibling.
- **Pure/testable split** as L27/L39: the registry lookup, URL building and missing-detection are unit-tested;
  only the `fetch`/write glue sits in the `v8 ignore` band, and the unit tests deliberately cover the
  no-download paths so the suite never touches the network.

## L42. `webdriverio` is Appium-only — it must stay behind a lazy import

`src/transport-factory.ts` calls exactly two `webdriverio` entry points, both inside
`AppiumTransportFactory`: `attach` (reattaching to an existing session) and `remote` (creating one).
Nothing on the desktop CDP path touches the module. It is therefore loaded through the module-local
`importWebdriverio()` — the same shape as `src/sharp-loader.ts`, `no-restricted-syntax` disable and
justification included — and imported statically **only** as `import type { attach, remote }`, which
erases.

**Two reasons it must not go back to a static import.**

- **Weight.** `src/index.ts` re-exports `evalInObsidian`, which imports this module, so an eager
  `webdriverio` puts the whole WebDriver stack — `@wdio/*`, `archiver`, `cheerio`, `jszip` — in the graph
  of every consumer of the package index, including the desktop-only ones who never start a session.
- **It breaks Jest outright (T755).** `@wdio/logger` imports `chalk@5`, which reads its own
  `#supports-color` internal subpath import at module scope. Jest's `--experimental-vm-modules` linker
  does not link `#`-prefixed internal imports before the body runs, so the binding is still in its TDZ:
  every Jest ESM suite whose graph reaches this module dies at import with
  `ReferenceError: Cannot access 'supportsColor' before initialization`, before a single test runs — the
  same silent shape as T241. That is what kept `npm run test:jest` at "1 suite, 0 tests". **There is no
  config-level escape**: `moduleNameMapper` is bypassed for `#` specifiers (mapping
  `^#supports-color$` to a path that does not even exist changes nothing), and Jest cannot drop ESM mode
  here because `scripts/jest-config.ts` and `scripts/helpers/metadata-global.ts` use
  `import.meta.dirname`. Removing the edge is the fix; masking `chalk` would only have covered this
  repo's own suite and left every Jest consumer of the barrel broken.

Per **L6** this reaches Vitest / Jest / Manual alike — the lazy load lives in the shared factory, so no
adapter changes. One deliberate consequence in the built output: the CJS bundle now emits
`await import("webdriverio")` rather than `require("webdriverio")`, so Node resolves the package's
`import` condition (`build/node.js`) instead of its `require` one (`build/index.cjs`). Both are supported
entry points and only the Appium path reaches them.

## L43. Android startup is two budgets, and a reused device gets the same settle gate as a started one

A release preflight (T789, 2026-08-31) failed Android setup with
`Obsidian layout did not become ready within 90000ms` while `adb devices` reported
`emulator-5554 device` throughout. This is the real failing trace **L19**'s "Honest limit" asked for,
and it says the 90 s was never spent on Obsidian: L19 measured `waitForLayoutReady` at ~1 s, and ≤8.4 s
under 12-core + disk + memory stress. It was spent on ~2–4 `browser.execute` round-trips against a guest
that was still churning — the 25–50× round-trip inflation L19 measured directly.

### The hole: `ensureDeviceConnected`'s reuse branch skipped the gate

`ensureDeviceConnected` has two branches. The start-a-new-emulator branch runs `waitForBoot` →
`waitForDeviceIdle` → `wakeScreen`. The **reuse-an-already-running-device branch returned immediately**,
doing only `suppressErrorDialogs` — and `transport-options.ts` documented that as intended ("Only applies
to a harness-started emulator, not a reused one"). Appearing in `adb devices` says only that `adbd`
answers; the guest can still be running the boot animation or `dex2oat`. So the one shape that most needs
the gate — an emulator booted moments earlier, by hand or by a previous run — was the one shape that
never got it, and the cost landed on whatever polled the WebView next.

The reuse branch now runs the same three steps, so `deviceIdleTimeoutInMilliseconds` governs both paths
(`0` still skips; the wait is still best-effort — it warns and proceeds). `waitForBoot`'s `emulator`
parameter became `ProcessLaunch | undefined`: a reused device was not launched by this run, so there is
no exit info to fail fast on. `ensureAvdExists` deliberately stays where it is — **L27**'s reasoning for
skipping the AVD preflight on a running AVD is untouched.

### The budget: one wall clock became two phases

`registerVault` waited out `location.reload()` on a single 90 s clock started at the reload, so it paid
for the app's cold start *and* Obsidian's own work out of one budget sized for the latter. That is why a
first run after a machine restart failed once by design. It is now two phases, each with its own budget:

- **`appStartTimeoutInMilliseconds` (`@default 180000`)** — until `globalThis.app` exists. Everything
  here is outside Obsidian's control (the WebView reloading, a guest still optimizing packages), so it
  sits in the same generous tier as `appiumStartTimeoutInMilliseconds` /
  `sessionConnectionRetryTimeoutInMilliseconds`.
- **`layoutReadyTimeoutInMilliseconds` (`@default 90000`)** — until `app.workspace.layoutReady`, its
  clock starting **only when phase 1 completes**. It now covers Obsidian's work alone, which is why it
  can stay tight.

Progress is read as a **milestone ladder** rather than a boolean —
`no-webview` → `no-app` → `no-workspace` → `workspace-not-ready` → `layout-ready` — from one probe per
poll. Deliberately **one `browser.execute` round-trip and no `ensureWebViewContext`**: that call's
`getContexts()` runs `adb shell cat /proc/net/unix`, measured at ~17 s (L19), which is the very cost
being budgeted. A probe that throws is `no-webview`, not an error — the page is mid-reload for most of
phase 1, so a WebView that cannot answer is the expected reading there.

### The timeout message now discriminates, which is the L19 ask

The failure reports the furthest milestone reached, the probe count, and the slowest round-trip. **Many
fast probes stalled at one milestone** = Obsidian genuinely slow, and the phase's budget is the right
knob. **A handful of probes each taking tens of seconds** = a contended guest, and the knob is
`deviceIdleTimeoutInMilliseconds`, not a bigger budget. Before this, both read as the same sentence.

### Where the code lives

Per **L27**'s pure/testable split: `src/app-startup-progress.ts` (`classifyAppStartupProbe`,
`checkAppStarted`, `checkLayoutReady`, `compareAppStartupMilestones`, `buildStartupTimeoutMessage`) is
pure and unit-tested; `transport-appium.ts` keeps only the polling orchestration, and `transport-factory.ts`
only the `adb` glue — both stay `/* v8 ignore */` under the 100 % gate.

## L44. Security overrides (`fflate` GHSA-px8p-9vwx-vf98)

`fflate` `0.7.0 – 0.7.4` can enter an infinite loop in `unzipSync` on a malformed ZIP64 archive; `0.7.5` is
the fix. Two packages in this tree reach it, and only one of them is vulnerable:

```text
@shuding/opentype.js → fflate@^0.7.3   ← already resolves 0.7.5 on its own, fine
satori               → fflate@0.7.3    ← an EXACT pin, so it keeps a second, vulnerable copy nested
```

Both arrive through the docs-site OG-image path (`satori` + `@resvg/resvg-js`). No direct bump reaches the
vulnerable copy: `satori@0.33.4` is the newest release and still declares the exact `0.7.3`. So the fix is
`overrides.fflate` → `^0.7.5` (G100 step 2), which also **dedupes** the two copies into one — the install
that applied it reported `removed 1 package`.

**Never take `npm audit fix --force` here** — its remedy is `satori@0.32.0`, a downgrade. **Remove the
override** when `satori` declares a range that admits `0.7.5` or later; the `check` in
[`pinned-versions.json`](pinned-versions.json) reads that declared range and watches exactly that.

The override is kept **caret-ranged** so `update-npm-deps.ps1` carries it forward, and it is listed in
`pinned-versions.json` anyway — the sweep keeps a caret override *current*, but it never reports that the
advisory the override answers has gone away, and the override with it. Same arrangement as
`brace-expansion` in **L30**.
