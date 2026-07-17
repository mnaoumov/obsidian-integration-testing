# CHANGELOG

## 8.2.1

- chore: spellcheck
- fix: hide windows
- chore: update libs

## 8.2.0

- feat: autoinstall appium
- build: pin the dev Node version to 26 and make CI follow .nvmrc

## 8.1.2

- fix: hide appium console

## 8.1.1

- fix: visibility
- docs: migrate to AGENTS.md
- feat: static version compatibility check
- feat: precalculate minInstallerVersions
- refactor: sync functions
- feat: cross-platform boot validation + asar-swap fix
- feat: cross-platform validation

## 8.1.0

- feat: add GitHub test for Linux/macOS installer-shell path
- feat(cli): exit on owned-instance window close
- docs: capture Android integration performance reference (L19)
- build: drop urlpattern-polyfill dry-uninstall override
- feat: detect dead combination of obsidian version and installer version

## 8.0.1

- fix: installer urls for old versions

## 8.0.0

- feat!: update funcs

## 7.0.0

- test: expose lib

## 6.2.0

- chore: republish

## 6.1.0

- docs: mark the boot-idle gate done and cold-boot-confirmed
- feat: gate the Android session on a post-boot idle wait
- docs: record Android cold-cost root-cause and mark Part 1 done
- feat: make the Appium server-start timeout configurable
- chore: fix CHANGELOG typo and add dictionary words

## 6.0.0

- docs: document the process-visibility flags
- feat: add process-visibility options, hidden by default
- docs: note the unreproduced layout-trip caveat and next step in CLAUDE.md
- docs: record Android setup-timeout profiling findings in CLAUDE.md
- feat: make the Appium session-establishment timeout configurable
- perf: push Android vault marker via adb instead of the slow WebDriver pushFile
- docs: document Appium transport timeout options and de-stale CLI references
- fix: make Android layout-ready timeout configurable; raise default to 90s
- chore: update libs

## 5.6.0

- feat: add trusted pressKey helper
- chore: update libs

## 5.5.0

- fix: suppress Android crash/ANR dialogs after boot

## 5.4.0

- feat: add reusable waitUntil poll helper to CommonArgs

## 5.3.0

- docs: document trusted keyboard and pointer input helpers
- test: retry the flaky network-connectivity check
- test: align plugin-load-detection expectations with real Obsidian behavior
- fix: relaunch the owned instance per vault, never the vault picker
- docs: document trusted-pointer helpers (L11)
- test: remove stale obsidian eval CLI focus-steal tests
- feat: add trusted-pointer hover and move helpers
- refactor: reuse public param types in namespace bootstrap

## 5.2.0

- docs: document connectToCdp and the CLI in the README
- feat: add connectToCdp helper and CLI for ad-hoc CDP debugging

## 5.1.2

- test: add opt-in Windows installer download and extract test
- test: cover asar download and unpack for both channels
- fix: download public asars from GitHub releases, catalyst from CDN
- refactor: keep only first line of each commit in changelog

## 5.1.1

- test: guard the owned-instance worker-attach path
- fix: attach test workers to the harness-owned CDP instance

## 5.1.0

- feat: provide typeIntoEditor trusted-input helper in evalInObsidian callbacks

## 5.0.0

- chore: update libs
- docs: document hermetic owned-instance transport and version pinning
- refactor: never hardcode the CDP port
- feat!: run desktop tests in a hermetic owned Obsidian instance
- docs: propose trusted keyboard input helper for evalInObsidian
- refactor(scripts): make eslint rule helpers self-contained
- refactor(scripts): make format.ts helper self-contained
- feat(scripts): add linkinator and unify markdownlint.ts link-checking
- refactor(scripts): import process explicitly in spellcheck
- feat(scripts): add isVerbose option to check-project-types
- fix(scripts): make markdownlint schema Rule import type-only
- chore: read .env and honor NANO_STAGED opt-out in nano-staged config
- docs: correct desktop run file count in known-issues note
- docs: close stale CLI-eval-pollution known issue

## 4.4.0

- feat: serialize concurrent integration-test runs with a cross-process lock

## 4.3.0

- docs: document vault pre-population across Vitest/Jest/Manual
- feat(jest): add default-export globalSetup/globalTeardown entry points
- chore: update libs
- chore: normalize tsconfig lib casing to ES2022
- docs: add framework-parity rule to project CLAUDE.md
- feat(jest): mirror createSetup/populate into the Jest adapter
- feat: pre-populate temp vault before Obsidian opens it
- feat: add no-unused-params-members ESLint rule
- feat(eslint): enforce readonly Params/Options/Result members
- feat(eslint): migrate recent obsidian-dev-utils eslint changes

## 4.2.6

- fix: restart Obsidian in the cold path when it runs without an open vault
- fix: bound pollVaultReady with a per-eval timeout
- fix: ignore stale obsidian.json open flag when Obsidian is not running
- fix: resolve real Obsidian GUI executable over scoop shim

## 4.2.5

- fix: surface emulator startup failures immediately

## 4.2.4

- chore: format
- chore: stop patching

## 4.2.3

- fix: strip forbidden fetch headers when reattaching to Appium session
- docs: resolve Obsidian executable dynamically in CDP launch instructions
- test: add strictProxy and castTo helpers for type-safe mocks

## 4.2.2

- fix: enable Chromedriver autodownload for newer Obsidian WebViews
- fix: strip forbidden Connection/Content-Length headers on Node 26

## 4.2.1

- fix: prevent orphan windows when (un)registering a vault that isn't open `obsidian eval`'s CLI handler
- fix: dismiss trust dialog reliably across Obsidian 1.12.x and 1.13.0

## 4.2.0

- chore: lint
- fix: verify Obsidian executable path before auto-launch

## 4.1.6

- feat: auto-resolve vault path via framework adapters
- chore: update libs

## 4.1.5

- chore: update config
- chore: update libs
- refactor: migrate to @obsidian-typings/obsidian-public-latest

## 4.1.4

- chore: release

## 4.1.3

- chore: update libs
sd

## 4.1.2

- chore: update libs
- chore: add attestation
- docs: contributing

## 4.1.1

- chore: fix versions

## 4.1.0

- fix: cache WebView context to avoid redundant getContexts()
- fix: reuse Appium session in test workers instead of creating a second one

## 4.0.1

- fix: reuse already-running emulator in ensureDeviceConnected
- docs: update TSDoc example to use avdName instead of deviceId
- docs: simplify Android setup instructions
- docs: update README examples

## 4.0.0

- feat!: remove deviceId from Android transport options, require avdName

## 3.0.5

- fix: increase server install/launch timeouts for fresh emulators
- fix: increase Appium connection retry timeout and count for fresh emulators

## 3.0.4

- fix: increase Appium server timeouts and allow server installation on fresh emulators

## 3.0.3

- fix: increase WebView poll timeout and reset context on switchContext

## 3.0.2

- fix: use vault adapter fsPromises instead of window.require in CLI transport

## 3.0.1

- fix: dismiss trust dialog when registering first vault via CLI transport

## 3.0.0

- refactor: consolidate window state under __obsidianIntegrationTesting namespace
- refactor: never kill user's Obsidian instance in tests
- feat: add trust dialog web modal check
- fix: use named timeout constants instead of multipliers
- fix: add timeout to closeVaultWindow to prevent infinite hang
- fix: manually clear vault open flag after window destroy
- fix: ensure CLI is responsive before and after Obsidian restarts
- fix: wait for vault open flag after closing windows
- fix: rewrite integration tests with proper state management
- fix: restructure integration tests to avoid native dialogs
- feat: add NativeDialogMonitor for integration tests
- refactor: use new Function instead of module.constructor._load
- fix: use vault ID in obsidian://open URI instead of path
- feat: auto-open vault in preflightCheck when registered but not open

## 2.7.2

- fix: layoutReady waiter

## 2.7.1

- fix: cover case workspace is not loaded

## 2.7.0

- fix(transport): auto-enable CLI and restart Obsidian when cli is disabled
- fix(config): enable CLI when writing vault entry to obsidian.json
- feat(transport): register vault directly in obsidian.json when no existing vault is available
- refactor(eval): replace string-template IIFE with generateFunctionCall helper

## 2.6.1

- fix(appium): remove --force-local tar flag for bsdtar compatibility

## 2.6.0

- fix(emulator): add DNS server flag to ensure network access
- fix(eval): rewrite plugin: stack frames to avoid Vitest EISDIR crash

## 2.5.9

- fix(cli-transport): run enablePluginsInLocalStorage in existing vault window

## 2.5.6

- fix(cli-transport): use existing registered vault for IPC eval instead of process.

## 2.5.5

- fix(appium): flush filesystem buffers after tar extraction
- fix(cli-transport): use vaultPath instead of process.cwd() in enablePluginsInLocalStorage
- fix(appium): add --force-local to tar

## 2.5.4

- fix(appium): use relative archive path instead of --force-local for tar compatibility

## 2.5.3

- fix(appium): add --force-local to tar to fix Windows drive-letter paths

## 2.5.2

- refactor(cli): use JSON envelope for script result communication

## 2.5.1

- fix(cli): wrap require() in async IIFE and use unique invoke names

## 2.5.0

- refactor(cli): use temp script files instead of inline expressions Write eval expressions to temp .cjs files

## 2.4.0

- feat: support binary files and typed folders in TempVault.populate()

## 2.3.6

- docs: add current task investigation notes for cross-eval bug
- fix: use unique result marker to prevent cross-eval stdout pollution
- chore: update dependency lockfile

## 2.3.5

- fix(appium): replace browser.pushFile with compressed adb push

## 2.3.4

- docs: mention endpoint
- fix: optional vitest typings

## 2.3.3

- chore: better patch
- chore: patch webdriverio
- chore: remove conflicting package

## 2.3.2

- fix: patch vite types to resolve ts(2320) MinimalPluginContext conflict

## 2.3.1

- fix: rewrite .ts extensions in side-effect imports

## 2.3.0

- fix: typings

## 2.2.3

- fix: make desktop / android tests running independently

## 2.2.2

- feat: include transport type in setup/teardown log messages
- fix: tear down active setups on unhandled rejections
- fix: tear down all active setups when one setup fails
- fix: sync cleanup of orphaned setups on process.exit()

## 2.2.1

- fix: log note about misleading "No test files found"
- fix: clean up orphaned setups when process exits without teardown
- fix: inline CAUSE_INDENT_SIZE in serializeError for toString()

## 2.2.0

- fix: detect plugins that are enabled but fail to load
- fix: make coreTeardown resilient to cleanup failures
- refactor: rename obsidian-cli.ts to eval-in-obsidian.ts

## 2.1.0

- refactor: extract serializeError and capture eval errors
- fix: suppress verbose webdriver DATA logs

## 2.0.7

- fix: retry switchContext failures and ensure cleanup steps are independent

## 2.0.6

- fix: ensure Appium/emulator processes are killed even if session disposal fails
- fix: normalize backslash separators in Appium pushFiles device paths On Windows

## 2.0.5

- feat: log timeout and poll interval when waiting
- fix: make screen wake best-effort to prevent hanging on keyevent

## 2.0.4

- fix: parallelize Appium/emulator startup and wake screen

## 2.0.3

- fix: fail early if ANDROID_HOME/ANDROID_SDK_ROOT is not set
- feat: auto-start Android emulator when avdName is configured
- fix: improve Appium DX — ADB preflight check, local timestamps, cleanup on failure

## 2.0.2

- fix: resolve %LOCALAPPDATA% in Node.js

## 2.0.1

- fix: add timestamps to log output, fix DEP0190 warning, increase Appium timeout

## 2.0.0

- feat: add support for jest
- fix: suppress trust dialog when registering temp vaults

## 1.3.2

- fix: normalize absolute paths to relative in markdownlint helper
- feat: auto-include vitest augmentations
- fix: move EnvironmentOptions augmentation to vitest/node module
- fix: pass transport through globalSetup to avoid inject() in wrong context

## 1.3.1

- chore: resubmit

## 1.3.0

- docs: update
- feat: vitest types

## 1.2.3

- fix: backtick-escape @default
- feat: auto-start Appium server when unreachable
- fix: guard teardown against undefined

## 1.2.2

- fix: dependencies

## 1.2.1

- feat: add verbose logging to setup and transport polling loops
- chore: publish patches
- docs: namespaces

## 1.2.0

- feat: add CDP and Android testing

## 1.1.2

- fix: workaround for eslint bug <https://github.com/eslint/rewrite/issues/425>
- fix: use "where.exe obsidian" instead of "where.exe obsidian.com" for CLI detection
- fix: template
- chore: unify rules
- chore: unify scripts
- docs: improve

## 1.1.1

- fix: recreate TempVault instance

## 1.1.0

- feat: expose tempVault
- refactor: populate
- chore: remove patch for vitest types

## 1.0.1

- refactor: temp vault

## 1.0.0

- initial
