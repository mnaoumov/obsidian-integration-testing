# CHANGELOG

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

- fix(cli-transport): run enablePluginsInLocalStorage in existing vault window enablePluginsInLocalStorage sets a localStorage flag that must be set before the new vault loads. Since localStorage is shared across all Obsidian windows (same Electron origin), run the eval in an already-loaded vault instead of targeting the new vault that hasn't finished loading yet. Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
- chore: release 2.5.8

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
