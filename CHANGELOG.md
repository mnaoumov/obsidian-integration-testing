# CHANGELOG

## 17.9.1

This release has 3 fixes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- **desktop:** let a persistent profile's instance quit before the kill
- **desktop:** hold a persistent profile's updater state aside for the run
- **android:** press again when a long press is taken for a tap

## 17.9.0

This release has 1 new feature and 2 documentation changes.

### New

- **desktop:** run the owned instance on a persistent user-data profile

### Documentation

- link the changelog from the README
- add a See also section comparing similar libraries

## 17.8.3

This release has 1 fix. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- **android:** gate the Appium session on system_server and its services

## 17.8.2

This release has 2 fixes. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- **android:** scale the emulator boot budget with the guest core count
- **desktop:** wait for owned process exit before retrying cleanup

## 17.8.1

This release has 4 fixes and 1 documentation change.

### Fixed

- **desktop:** bound startup waits and clean up failed connections
- restore source maps for cached Vitest modules
- **desktop:** avoid blocking worker shutdown during cleanup
- recover stacks when source maps fail

### Documentation

- link to the Obsidian resources page

## 17.8.0

This release has 1 new feature, 3 fixes and 4 documentation changes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- add plugin lifecycle test patterns

### Fixed

- **desktop:** kill an owned instance by its CDP port when its PID no longer holds it
- **desktop:** keep a registered vault in the vault list when an attached connection closes it
- **desktop:** never close a vault window an attached connection did not open

### Documentation

- **readme:** link the plugin lifecycle patterns guide
- **readme:** name the questions the harness answers
- add a guide on driving Obsidian from a coding agent
- add issue-filing instructions for AI agents

## 17.7.4

This release has 2 fixes and 1 documentation change. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- **android:** send a mobile key press as one keyDown, so one Enter is one line break
- **android:** give the auto-started Appium server a separate driver-load budget

### Documentation

- **deps:** record unpatched deepmerge advisory

## 17.7.3

This release has 1 fix. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- **android:** accept long non-ASCII vault paths on the device and keep long pushes alive

## 17.7.2

This release has 5 fixes.

### Fixed

- **namespace:** never save plugin config while resolving the obsidian module
- **android:** recover from an ended session or a closed WebView window during startup
- **desktop:** register another vault after a left-behind window
- **jest:** point setupFiles at the metadata shim in test-setups
- **deps:** clear the zod, fast-uri and vitest advisories

## 17.7.1

This release has 1 fix. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- **android:** use host DNS for emulator launches

## 17.7.0

This release has 1 new feature. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- **android:** cap emulator guest CPUs by the bulk budget

## 17.6.1

This release has 2 fixes and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- **android:** recover requested vault from the mobile picker
- preserve setup errors when stack formatting fails

### Documentation

- **readme:** combine related resources and plugin comparisons

## 17.6.0

This release has 2 new features and 6 fixes. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **lib:** add a trusted dragMouse helper for held-button pointer drags
- **metadata:** absorb the per-version catalog obsidian-versions dropped

### Fixed

- resolve the obsidian module in restricted mode, fall back from a Catalyst installer pin, keep visible windows rendering
- **demo-vault:** let a bare bootstrap-demo-vault --force sweep past unlisted and own plugins
- **demo-vault:** make the injected-plugin throw's bootstrap command actually repair the plugin
- **android:** stop a failed registration's teardown from provisioning, and name the host's load
- **android:** size the emulator boot budget for a loaded machine
- **android:** report and survive a failed adb devices during the emulator boot

## 17.5.1

This release has 3 fixes and 3 documentation changes. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- **mobile-input:** merge reporting a mobile long-press that produced no contextmenu
- **deps:** merge clearing the markdown-it and vite audit advisories
- **deps:** merge clearing every npm audit advisory except the unpatched braces

### Documentation

- **changelog:** escape the issue-title tags so markdownlint and cspell pass
- **changelog:** name the issue each released entry resolved
- merge pointing the sync rules and examples at the packages that replaced obsidian-dev-utils

## 17.5.0

This release has 1 new feature.

### New

- **android:** merge writing a file again when the emulator lands it empty

## 17.4.0

This release has 1 new feature, 2 fixes and 1 documentation change. 7 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **demo-vault:** merge re-downloading a stale injected plugin

### Fixed

- **scripts:** merge reading vendored eslint rules from typescript-dev-toolkit
- **android:** merge starting the adb server before the first adb devices listing

### Documentation

- merge marking plugin names as code in markdown and comments

## 17.3.0

This release has 2 new features and 3 fixes.

### New

- **trusted-input:** merge delivering input to a popout window, not always the main one (re #1 - \[FR\] allow to specify the window in `pressKey`)
- **capture:** merge applying the theme with an immediate save, and refusing a frame in the wrong theme

### Fixed

- **soft-keyboard:** merge refusing a field selector that matches more than one element
- **capture:** merge drawing the window focused whether or not the OS gave it focus
- **capture:** merge rasterizing owned instances on the CPU so sized captures stop varying

## 17.2.0

This release has 1 new feature.

### New

- **soft-keyboard:** merge parking the caret at offset 0 so Gboard's strip is always its toolbar

## 17.1.1

This release has 1 fix.

### Fixed

- **soft-keyboard:** merge holding the written-back text until the IME stops undoing it

## 17.1.0

This release has 1 new feature.

### New

- **screenshot:** merge hiding the focused element's caret for each capture

## 17.0.2

This release has 1 fix and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- **android:** merge hit-testing clickElement's target in its own shadow root

### Documentation

- merge repointing dead {@link} targets

## 17.0.1

This release has 1 fix.

### Fixed

- **android:** merge waiting for clickElement's target to stop moving

## 17.0.0

This release has 1 new feature, 8 fixes, 1 improvement and 2 documentation changes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- **screenshots:** make a device frame committable - paint the status bar out, and touch an empty field

### Fixed

- **android:** merge confirming a showing keyboard before pressing KEYCODE_BACK
- **android:** merge adopting only the emulator that serves the launched AVD
- **android:** merge host-query failure reporting for the port-owner query and wedge probe
- **screenshots:** put an already-up soft keyboard down before raiseSoftKeyboard measures
- **android:** identify an emulator over adb, not over its console
- **emulator-reclaim:** measure the host process listing's budget, and report which way it failed
- **transport-appium:** stop the vault marker overwriting the app.json register just pushed
- **enable-plugin:** restore a patched slot only while our own patch is still in it

### Improved

- **android:** list only emulator processes on Windows

### Documentation

- **contributing:** name main as the PR base branch
- **agents:** point L47 at the channel change it no longer describes

## 16.0.0

This release has 1 breaking change.

### Breaking changes

- **label-screenshot:** make the caption band opaque, so nothing under it reaches the frame

## 15.0.0

This release has 2 breaking changes, 1 new feature, 2 fixes and 3 documentation changes. 7 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Breaking changes

- **label-screenshot:** measure the caption, and refuse one too wide instead of clipping it
- **setup:** fail a run whose dist predates its sources, before the transport exists

### New

- **capture-obsidian-screenshot:** hide the vault name, so a captured frame does not depend on which temporary vault the run got

### Fixed

- **check-vendored-eslint-rules:** read this repo's side from the git index, not the working tree
- **lint:** clear eslint-plugin-unicorn 75's 137 findings so `lint` is green again

### Documentation

- **agents:** state the L59 findings without private tracker labels
- **lint:** state the unicorn arm's reason in a form that is true in every consumer
- settle what the CLI-pipe EADDRINUSE at boot means

## 14.1.0

This release has 1 documentation change. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Documentation

- **agents:** merge the auto-memory pointer repoint

## 14.0.0

This release has 2 breaking changes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Breaking changes

- **types:** land the deferred public params-options-name-match renames
- **types:** take method-signature-style to its `property` default

## 13.0.0

This release has 1 breaking change and 2 documentation changes. 6 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Breaking changes

- **trusted-input:** clear the hover for real, and refuse to resolve when it is not cleared

### Documentation

- **agents:** record the five lint rules this repo keeps stricter than the shared config
- **deps:** give the js-yaml pin a check that can see what it guards

## 12.3.0

This release has 1 breaking change, 1 new feature, 2 fixes and 2 documentation changes. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Breaking changes

- **soft-keyboard:** verify the keyboard by how far the field moved, not by where it sits

### New

- **eval-cap:** export the per-eval cap, and give both transports one constant

### Fixed

- **transport:** multiplex CDP commands over one message listener per socket
- **scripts:** route every local tool hop through the resolved bin shim

### Documentation

- **markdown:** put every paragraph on one physical line
- **changelog:** drop the tracker reference from the soft-keyboard entry

## 12.2.0

This release has 2 new features, 6 fixes and 2 documentation changes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- **app-config:** add a per-test seam for a vault config key
- **transport:** land the per-eval cap on both transports

### Fixed

- **android:** keep the emulator reaper alive through a process-tree kill
- **android:** make the long-press menu test open the drawer reliably
- **emulator:** record an emulator from its launch, not from its device
- **scripts:** reconcile the shared helper copies across the sibling projects
- **emulator:** stop an emulator whose runner was killed, with no run after it
- **emulator:** stop every emulator the harness starts, and cap netsimd's log

### Documentation

- **android:** fix a garbled clause in the drawer-retry comment
- **agents:** record that trusted input is claimed once across every attached host

## 12.1.2

This release has 1 fix.

### Fixed

- **mobile-input:** inject each trusted gesture once, however many hosts are attached

## 12.1.1

This release has 1 new feature, 2 fixes and 2 documentation changes.

### New

- **android:** capture the device and raise its soft keyboard

### Fixed

- **deps:** clear the js-yaml and smol-toml advisories through overrides
- **scripts:** run the script hops through the detected package manager

### Documentation

- **agents:** retire the dangling Current Task pointers
- **release:** say the sibling repos have followed onto trusted publishing

## 12.1.0

This release has 2 new features, 18 fixes and 4 documentation changes. 6 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **android:** run the Android leg on a CI runner, with a kept wedge probe
- **cdp:** open a vault whose config folder is not .obsidian

### Fixed

- **temporary-vault:** carry the vault to the device before registering it
- **mobile-input:** recognize a long press as a gesture, not a dwell
- **emulator-liveness:** send a recurring wedge to the host socket filters first
- **temporary-vault:** delete only a directory the handle itself created
- **unregister-vault:** tear down only the vaults this transport registered
- **obsidian-instance:** observe the owned instance's exit instead of discarding it
- **parent-liveness:** verify the harness is gone before destroying the window
- **global-setup:** send every pre-open vault write to the overridden config folder
- **ci:** run every workflow on actions that target Node 24
- **ci:** pin where the AVD lives, so create and boot agree on it
- **ci:** do not let a SIGPIPE'd `yes` fail the AVD step
- **android:** diagnose a wedged emulator instead of blaming the device
- **setup:** keep the settings modal in the window the harness drives
- **android:** refuse to launch beside a device that did not answer
- **android:** verify every auto-started process actually stopped
- **android:** wait for a validated network, not just an idle device
- **version:** read npm pack --json under npm 12, where it stopped being an array
- **android:** budget the emulator's cold boot separately from layout readiness

### Documentation

- **demo-vault:** name the unversioned demo-vault archive
- **android:** record that the runner survives, so the fault is the machine
- write what a reader of this repo can check, not a private label
- **agents:** record the fflate override as L44, beside the other two

## 12.0.0

This release has 1 breaking change, 3 new features, 5 fixes and 1 documentation change.

### Breaking changes

- **trusted-input:** give the lib bag a mobile path via a CDP channel to the WebView

### New

- **trusted-input:** publish the helpers as ns.trustedInput, the seam dev-utils reads on mobile
- **demo-vault:** install a demo vault's injected plugins headlessly
- **metadata:** source the catalog from Obsidian's own endpoints

### Fixed

- **vitest-config:** budget every project's testTimeout, not eight of nine
- **transport-factory:** lazy-load webdriverio so the Jest gate can run
- **coverage:** restore the 100% gate so a release can be cut again
- **appium:** recognize a wedged Appium server and stop blaming the device
- **setup:** fail a project's tests with its setup error, not a fallback transport

### Documentation

- **settings-tab:** credit the impossibility note to one plugin, not two

## 11.0.0

This release has 1 breaking change, 1 new feature and 2 documentation changes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Breaking changes

- **metadata:** per-target changelogUrl object and baked Android apk URLs

### New

- **lib:** open a settings tab that actually renders

### Documentation

- **agents:** fix the barrel contradiction and guard it with a test
- **user-input:** document the trusted clickMouse and clickElement helpers

## 10.4.0

This release has 1 new feature, 1 fix, 1 improvement and 1 documentation change. 6 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **lib:** add trusted clickMouse and clickElement to the lib bag

### Fixed

- override deepmerge-ts to clear GHSA-ggr8-5vv4-36mx

### Improved

- skip a desktop-only plugin's mobile setup before the device boots

### Documentation

- record the extract-zip security override

## 10.3.2

This release has 1 fix.

### Fixed

- deepen the label band so it clears the status row entirely

## 10.3.1

This release has 1 fix.

### Fixed

- make the label band cover the chrome it sits over

## 10.3.0

This release has 1 new feature.

### New

- caption a screenshot with a label band

## 10.2.0

This release has 1 new feature. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- fit a screenshot onto a canvas of a different aspect ratio

## 10.1.0

This release has 2 new features and 2 documentation changes. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- resolve the transport for a screenshot from the test context
- add screenshot capture to both transports

### Documentation

- draw an original favicon instead of repainting the dev-utils one
- publish an Astro + Starlight documentation site

## 10.0.0

This release has 1 breaking change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Breaking changes

- eslint unicorn

## 9.2.2

This release has 1 fix.

### Fixed

- kill orphans

## 9.2.1

This release has 2 new features, 1 fix and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- **lib:** add a content-verified createNote helper to the injected lib bag
- **scripts:** add per-script env-var off switch

### Fixed

- **leftover-cleanup:** sweep device vaults one directory at a time and verify the result

### Documentation

- **android:** state the AVD provisioning minimums in setup, disk included

## 9.2.0

This release has 2 new features, 3 fixes and 1 documentation change. 6 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **version-matrix:** run the suites once when both supported ends are the same version
- **cleanup:** sweep leftover temp vaults and instance profiles at both ends of a run

### Fixed

- **jest:** supply the OBSIDIAN_METADATA global via a shared setup file
- **setup-lock:** identify the holder by heartbeat, not just its pid
- **deps:** override glob/test-exclude/readdir-glob to clear GHSA-mh99-v99m-4gvg

### Documentation

- record a release condition for every pinned version

## 9.1.1

This release has 2 fixes.

### Fixed

- **version:** skip interactive CHANGELOG editor in non-interactive sessions
- enable alwaysUpdateLinks in owned vaults so headless renames resolve

## 9.1.0

This release has 3 new features and 1 fix.

### New

- allow install additional plugins
- safety checks
- capture logs

### Fixed

- ensure correct vault window

## 9.0.0

This release has 1 breaking change and 2 new features. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Breaking changes

- **global-setup:** split into -plugin / -no-plugin entry points

### New

- fail fast
- add readDemoVaultTree for pre-launch demo-vault seeding

## 8.4.0

This release has 5 new features and 2 fixes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- ensure every version loaded
- populate runtime versions for 68 installer versions
- extract process.versions
- asar fallback detection
- reuse obsidian-versions.json

### Fixed

- resolve obsidianModule on old versions with an undefined configDir
- ensure all installer versions are supported

## 8.3.0

This release has 2 new features.

### New

- allow to bypass version checks
- check for electron version

## 8.2.1

This release has 1 fix. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- hide windows

## 8.2.0

This release has 1 new feature. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- autoinstall appium

## 8.1.2

This release has 1 fix.

### Fixed

- hide appium console

## 8.1.1

This release has 4 new features, 1 fix and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- static version compatibility check
- precalculate minInstallerVersions
- cross-platform boot validation + asar-swap fix
- cross-platform validation

### Fixed

- visibility

### Documentation

- migrate to AGENTS.md

## 8.1.0

This release has 3 new features and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- add GitHub test for Linux/macOS installer-shell path
- **cli:** exit on owned-instance window close
- detect dead combination of obsidian version and installer version

### Documentation

- capture Android integration performance reference (L19)

## 8.0.1

This release has 1 fix.

### Fixed

- installer urls for old versions

## 8.0.0

This release has 1 breaking change.

### Breaking changes

- update funcs

## 7.0.0

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 6.2.0

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 6.1.0

This release has 2 new features and 2 documentation changes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- gate the Android session on a post-boot idle wait
- make the Appium server-start timeout configurable

### Documentation

- mark the boot-idle gate done and cold-boot-confirmed
- record Android cold-cost root-cause and mark Part 1 done

## 6.0.0

This release has 2 new features, 1 fix, 1 improvement and 4 documentation changes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- add process-visibility options, hidden by default
- make the Appium session-establishment timeout configurable

### Fixed

- make Android layout-ready timeout configurable; raise default to 90s

### Improved

- push Android vault marker via adb instead of the slow WebDriver pushFile

### Documentation

- document the process-visibility flags
- note the unreproduced layout-trip caveat and next step in CLAUDE.md
- record Android setup-timeout profiling findings in CLAUDE.md
- document Appium transport timeout options and de-stale CLI references

## 5.6.0

This release has 1 new feature. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- add trusted pressKey helper

## 5.5.0

This release has 1 fix.

### Fixed

- suppress Android crash/ANR dialogs after boot

## 5.4.0

This release has 1 new feature.

### New

- add reusable waitUntil poll helper to CommonArgs

## 5.3.0

This release has 1 new feature, 1 fix and 2 documentation changes. 4 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- add trusted-pointer hover and move helpers

### Fixed

- relaunch the owned instance per vault, never the vault picker

### Documentation

- document trusted keyboard and pointer input helpers
- document trusted-pointer helpers (L11)

## 5.2.0

This release has 1 new feature and 1 documentation change.

### New

- add connectToCdp helper and CLI for ad-hoc CDP debugging

### Documentation

- document connectToCdp and the CLI in the README

## 5.1.2

This release has 1 fix. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- download public asars from GitHub releases, catalyst from CDN

## 5.1.1

This release has 1 fix. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- attach test workers to the harness-owned CDP instance

## 5.1.0

This release has 1 new feature.

### New

- provide typeIntoEditor trusted-input helper in evalInObsidian callbacks

## 5.0.0

This release has 1 breaking change, 2 new features, 1 fix and 4 documentation changes. 6 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Breaking changes

- run desktop tests in a hermetic owned Obsidian instance

### New

- **scripts:** add linkinator and unify markdownlint.ts link-checking
- **scripts:** add isVerbose option to check-project-types

### Fixed

- **scripts:** make markdownlint schema Rule import type-only

### Documentation

- document hermetic owned-instance transport and version pinning
- propose trusted keyboard input helper for evalInObsidian
- correct desktop run file count in known-issues note
- close stale CLI-eval-pollution known issue

## 4.4.0

This release has 1 new feature.

### New

- serialize concurrent integration-test runs with a cross-process lock

## 4.3.0

This release has 6 new features and 2 documentation changes. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- **jest:** add default-export globalSetup/globalTeardown entry points
- **jest:** mirror createSetup/populate into the Jest adapter
- pre-populate temp vault before Obsidian opens it
- add no-unused-params-members ESLint rule
- **eslint:** enforce readonly Params/Options/Result members
- **eslint:** migrate recent obsidian-dev-utils eslint changes

### Documentation

- document vault pre-population across Vitest/Jest/Manual
- add framework-parity rule to project CLAUDE.md

## 4.2.6

This release has 4 fixes.

### Fixed

- restart Obsidian in the cold path when it runs without an open vault
- bound pollVaultReady with a per-eval timeout
- ignore stale obsidian.json open flag when Obsidian is not running
- resolve real Obsidian GUI executable over scoop shim

## 4.2.5

This release has 1 fix.

### Fixed

- surface emulator startup failures immediately

## 4.2.4

This release has maintenance changes only. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

## 4.2.3

This release has 1 fix and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- strip forbidden fetch headers when reattaching to Appium session

### Documentation

- resolve Obsidian executable dynamically in CDP launch instructions

## 4.2.2

This release has 2 fixes.

### Fixed

- enable Chromedriver autodownload for newer Obsidian WebViews
- strip forbidden Connection/Content-Length headers on Node 26 (<https://github.com/webdriverio/webdriverio/issues/15265>)

## 4.2.1

This release has 2 fixes.

### Fixed

- prevent orphan windows when (un)registering a vault that isn't open `obsidian eval`'s CLI handler
- dismiss trust dialog reliably across Obsidian 1.12.x and 1.13.0

## 4.2.0

This release has 1 fix. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- verify Obsidian executable path before auto-launch

## 4.1.6

This release has 1 new feature. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- auto-resolve vault path via framework adapters

## 4.1.5

This release has maintenance changes only. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

## 4.1.4

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 4.1.3

- chore: update libs
sd

## 4.1.2

This release has 1 documentation change. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Documentation

- contributing

## 4.1.1

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 4.1.0

This release has 2 fixes.

### Fixed

- cache WebView context to avoid redundant getContexts()
- reuse Appium session in test workers instead of creating a second one

## 4.0.1

This release has 1 fix and 3 documentation changes.

### Fixed

- reuse already-running emulator in ensureDeviceConnected

### Documentation

- update TSDoc example to use avdName instead of deviceId
- simplify Android setup instructions
- update README examples

## 4.0.0

This release has 1 breaking change.

### Breaking changes

- remove deviceId from Android transport options, require avdName

## 3.0.5

This release has 2 fixes.

### Fixed

- increase server install/launch timeouts for fresh emulators
- increase Appium connection retry timeout and count for fresh emulators

## 3.0.4

This release has 1 fix.

### Fixed

- increase Appium server timeouts and allow server installation on fresh emulators

## 3.0.3

This release has 1 fix.

### Fixed

- increase WebView poll timeout and reset context on switchContext

## 3.0.2

This release has 1 fix.

### Fixed

- use vault adapter fsPromises instead of window.require in CLI transport

## 3.0.1

This release has 1 fix.

### Fixed

- dismiss trust dialog when registering first vault via CLI transport

## 3.0.0

This release has 3 new features and 8 fixes. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- add trust dialog web modal check
- add NativeDialogMonitor for integration tests
- auto-open vault in preflightCheck when registered but not open

### Fixed

- use named timeout constants instead of multipliers
- add timeout to closeVaultWindow to prevent infinite hang
- manually clear vault open flag after window destroy
- ensure CLI is responsive before and after Obsidian restarts
- wait for vault open flag after closing windows
- rewrite integration tests with proper state management
- restructure integration tests to avoid native dialogs
- use vault ID in obsidian://open URI instead of path

## 2.7.2

This release has 1 fix.

### Fixed

- layoutReady waiter

## 2.7.1

This release has 1 fix.

### Fixed

- cover case workspace is not loaded

## 2.7.0

This release has 1 new feature and 2 fixes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- **transport:** register vault directly in obsidian.json when no existing vault is available

### Fixed

- **transport:** auto-enable CLI and restart Obsidian when cli is disabled
- **config:** enable CLI when writing vault entry to obsidian.json

## 2.6.1

This release has 1 fix.

### Fixed

- **appium:** remove --force-local tar flag for bsdtar compatibility

## 2.6.0

This release has 2 fixes.

### Fixed

- **emulator:** add DNS server flag to ensure network access
- **eval:** rewrite plugin: stack frames to avoid Vitest EISDIR crash

## 2.5.9

This release has 1 fix.

### Fixed

- **cli-transport:** run enablePluginsInLocalStorage in existing vault window

## 2.5.8

- No changes since 2.5.6.

## 2.5.6

This release has 1 fix.

### Fixed

- **cli-transport:** use existing registered vault for IPC eval instead of process.

## 2.5.5

This release has 3 fixes.

### Fixed

- **appium:** flush filesystem buffers after tar extraction
- **cli-transport:** use vaultPath instead of process.cwd() in enablePluginsInLocalStorage
- **appium:** add --force-local to tar

## 2.5.4

This release has 1 fix.

### Fixed

- **appium:** use relative archive path instead of --force-local for tar compatibility

## 2.5.3

This release has 1 fix.

### Fixed

- **appium:** add --force-local to tar to fix Windows drive-letter paths

## 2.5.2

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 2.5.1

This release has 1 fix.

### Fixed

- **cli:** wrap require() in async IIFE and use unique invoke names

## 2.5.0

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 2.4.0

This release has 1 new feature.

### New

- support binary files and typed folders in TempVault.populate()

## 2.3.6

This release has 1 fix and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- use unique result marker to prevent cross-eval stdout pollution

### Documentation

- add current task investigation notes for cross-eval bug

## 2.3.5

This release has 1 fix.

### Fixed

- **appium:** replace browser.pushFile with compressed adb push

## 2.3.4

This release has 1 fix and 1 documentation change.

### Fixed

- optional vitest typings

### Documentation

- mention endpoint

## 2.3.3

This release has maintenance changes only. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

## 2.3.2

This release has 1 fix.

### Fixed

- patch vite types to resolve ts(2320) MinimalPluginContext conflict

## 2.3.1

This release has 1 fix.

### Fixed

- rewrite .ts extensions in side-effect imports

## 2.3.0

This release has 1 fix.

### Fixed

- typings

## 2.2.3

This release has 1 fix.

### Fixed

- make desktop / android tests running independently

## 2.2.2

This release has 1 new feature and 3 fixes.

### New

- include transport type in setup/teardown log messages

### Fixed

- tear down active setups on unhandled rejections
- tear down all active setups when one setup fails
- sync cleanup of orphaned setups on process.exit()

## 2.2.1

This release has 3 fixes.

### Fixed

- log note about misleading "No test files found"
- clean up orphaned setups when process exits without teardown
- inline CAUSE_INDENT_SIZE in serializeError for toString()

## 2.2.0

This release has 2 fixes. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- detect plugins that are enabled but fail to load
- make coreTeardown resilient to cleanup failures

## 2.1.0

This release has 1 fix. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### Fixed

- suppress verbose webdriver DATA logs

## 2.0.7

This release has 1 fix.

### Fixed

- retry switchContext failures and ensure cleanup steps are independent

## 2.0.6

This release has 2 fixes.

### Fixed

- ensure Appium/emulator processes are killed even if session disposal fails
- normalize backslash separators in Appium pushFiles device paths On Windows

## 2.0.5

This release has 1 new feature and 1 fix.

### New

- log timeout and poll interval when waiting

### Fixed

- make screen wake best-effort to prevent hanging on keyevent

## 2.0.4

This release has 1 fix.

### Fixed

- parallelize Appium/emulator startup and wake screen

## 2.0.3

This release has 1 new feature and 2 fixes.

### New

- auto-start Android emulator when avdName is configured

### Fixed

- fail early if ANDROID_HOME/ANDROID_SDK_ROOT is not set
- improve Appium DX — ADB preflight check, local timestamps, cleanup on failure

## 2.0.2

This release has 1 fix.

### Fixed

- resolve %LOCALAPPDATA% in Node.js

## 2.0.1

This release has 1 fix.

### Fixed

- add timestamps to log output, fix DEP0190 warning, increase Appium timeout

## 2.0.0

This release has 1 new feature and 1 fix.

### New

- add support for jest

### Fixed

- suppress trust dialog when registering temp vaults

## 1.3.2

This release has 1 new feature and 3 fixes.

### New

- auto-include vitest augmentations

### Fixed

- normalize absolute paths to relative in markdownlint helper
- move EnvironmentOptions augmentation to vitest/node module
- pass transport through globalSetup to avoid inject() in wrong context

## 1.3.1

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 1.3.0

This release has 1 new feature and 1 documentation change.

### New

- vitest types

### Documentation

- update

## 1.2.3

This release has 1 new feature and 2 fixes.

### New

- auto-start Appium server when unreachable

### Fixed

- backtick-escape @default
- guard teardown against undefined

## 1.2.2

This release has 1 fix.

### Fixed

- dependencies

## 1.2.1

This release has 1 new feature and 1 documentation change. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

### New

- add verbose logging to setup and transport polling loops

### Documentation

- namespaces

## 1.2.0

This release has 1 new feature.

### New

- add CDP and Android testing

## 1.1.2

This release has 3 fixes and 1 documentation change. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- workaround for eslint bug <https://github.com/eslint/rewrite/issues/425>
- use "where.exe obsidian" instead of "where.exe obsidian.com" for CLI detection
- template

### Documentation

- improve

## 1.1.1

This release has 1 fix.

### Fixed

- recreate TempVault instance

## 1.1.0

This release has 1 new feature. 2 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- expose tempVault

## 1.0.1

This release has maintenance changes only. 1 maintenance commit (tests, build, CI, refactoring, dependencies) is not listed.

## 1.0.0

- initial
