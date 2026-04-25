# CHANGELOG

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
