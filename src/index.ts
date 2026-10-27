/**
 * @file
 *
 * Contains the entry point for the integration testing module.
 */

export type { RunAdbParams } from './android/adb/adb.ts';
export {
  runAdbBinary,
  runAdbText,
  runAdbTextWithoutDevice
} from './android/adb/adb.ts';
export type {
  AppiumSessionInfo,
  AppiumTransportConfig
} from './android/appium/transport-appium.ts';
export { AppiumTransport } from './android/appium/transport-appium.ts';
export type {
  EmulatorDeviceCandidate,
  SelectEmulatorDeviceIdParams
} from './android/avd/emulator-device-id.ts';
export { selectEmulatorDeviceId } from './android/avd/emulator-device-id.ts';
export type { ResolveEmulatorDeviceIdParams } from './android/avd/resolve-emulator-device-id.ts';
export { resolveEmulatorDeviceId } from './android/avd/resolve-emulator-device-id.ts';
export type {
  DeviceSettingRestore,
  DeviceSettingRestoreDelete,
  DeviceSettingRestoreWrite
} from './android/device-setting-restore.ts';
export {
  DeviceSettingRestoreKind,
  resolveDeviceSettingRestore
} from './android/device-setting-restore.ts';
export type { BuildDeviceSettingsCommandArgumentsParams } from './android/device-settings-command.ts';
export {
  buildDeviceSettingsCommandArguments,
  DeviceSettingNamespace,
  DeviceSettingVerb
} from './android/device-settings-command.ts';
export type {
  DeviceSettingParams,
  WithSoftKeyboardEnabledParams,
  WriteDeviceSettingParams
} from './android/device-settings.ts';
export {
  deleteDeviceSetting,
  readDeviceSetting,
  withSoftKeyboardEnabled,
  writeDeviceSetting
} from './android/device-settings.ts';
export type {
  BuildSoftKeyboardDiagnosticMessageParams,
  CheckIsSoftKeyboardUpParams,
  ElementRect,
  ResolveSoftKeyboardTapPointsParams,
  SoftKeyboardTapPoint,
  SoftKeyboardViewportSnapshot
} from './android/soft-keyboard/soft-keyboard-geometry.ts';
export {
  buildSoftKeyboardDiagnosticMessage,
  checkIsInputMethodShown,
  checkIsSoftKeyboardUp,
  DEFAULT_MINIMUM_KEYBOARD_HEIGHT_IN_PIXELS,
  parseInputMethodState,
  resolveSoftKeyboardTapPoints
} from './android/soft-keyboard/soft-keyboard-geometry.ts';
export type {
  RaiseSoftKeyboardParams,
  TapDeviceParams
} from './android/soft-keyboard/soft-keyboard.ts';
export {
  raiseSoftKeyboard,
  tapDevice
} from './android/soft-keyboard/soft-keyboard.ts';
export type {
  ApplyObsidianThemeParams,
  AssertObsidianThemeUnchangedParams,
  ObsidianTheme
} from './capture/apply-obsidian-theme.ts';
export {
  applyObsidianTheme,
  assertObsidianThemeUnchanged
} from './capture/apply-obsidian-theme.ts';
export type { CaptureObsidianScreenshotOptions } from './capture/capture-obsidian-screenshot.ts';
export { captureObsidianScreenshot } from './capture/capture-obsidian-screenshot.ts';
export type {
  CaptureScreenshotParams,
  PngDimensions
} from './capture/capture-screenshot.ts';
export {
  buildDeviceMetricsOverride,
  decodeBase64Png,
  isPng,
  readPngDimensions
} from './capture/capture-screenshot.ts';
export type { CaptureDeviceScreenshotParams } from './capture/device-screenshot.ts';
export { captureDeviceScreenshot } from './capture/device-screenshot.ts';
export type {
  ComputeFitToCanvasParams,
  FitScreenshotToCanvasOptions,
  FitToCanvasGeometry
} from './capture/fit-screenshot.ts';
export {
  computeFitToCanvas,
  fitScreenshotToCanvas
} from './capture/fit-screenshot.ts';
export type {
  HiddenCaret,
  HideCaretOptions
} from './capture/hide-caret.ts';
export { hideCaret } from './capture/hide-caret.ts';
export type { HideVaultNameOptions } from './capture/hide-vault-name.ts';
export { hideVaultName } from './capture/hide-vault-name.ts';
export type {
  ComputeLabelBandParams,
  LabelBandGeometry,
  LabelCaptionMeasurement,
  LabelScreenshotOptions,
  MeasureLabelCaptionParams
} from './capture/label-screenshot.ts';
export {
  buildLabelSvg,
  computeLabelBand,
  escapeSvgText,
  labelScreenshot,
  measureLabelCaption
} from './capture/label-screenshot.ts';
export type {
  BuildStatusBarBandFailureMessageParams,
  PaintOutStatusBarOptions,
  ResolveStatusBarBandParams,
  StatusBarBandColor,
  StatusBarBandVerdict
} from './capture/paint-out-status-bar.ts';
export {
  buildStatusBarBandFailureMessage,
  DEFAULT_STATUS_BAR_EDGE_MARGIN_IN_PIXELS,
  DEFAULT_STATUS_BAR_SAMPLE_INSET_IN_PIXELS,
  paintOutStatusBar,
  resolveStatusBarBand
} from './capture/paint-out-status-bar.ts';
export type {
  PinnedWindowFocus,
  PinWindowFocusOptions
} from './capture/pin-window-focus.ts';
export { pinWindowFocus } from './capture/pin-window-focus.ts';
export type { CdpCommandTimeoutErrorConstructorParams } from './desktop/cdp-command-timeout-error.ts';
export { CdpCommandTimeoutError } from './desktop/cdp-command-timeout-error.ts';
export type {
  AsarFallback,
  AsarFallbackTier,
  ResolveAsarFallbackParams
} from './desktop/compatibility/asar-fallback-detection.ts';
export { resolveAsarFallback } from './desktop/compatibility/asar-fallback-detection.ts';
export type {
  ElectronCompatibility,
  ElectronCompatibilityTier,
  ResolveElectronCompatibilityParams
} from './desktop/compatibility/electron-compatibility.ts';
export { resolveElectronCompatibility } from './desktop/compatibility/electron-compatibility.ts';
export type { IncompatibleInstallerVersionErrorConstructorParams } from './desktop/compatibility/incompatible-installer-version-error.ts';
export { IncompatibleInstallerVersionError } from './desktop/compatibility/incompatible-installer-version-error.ts';
export type {
  InstallerCompatibility,
  InstallerCompatibilityTier,
  ResolveInstallerCompatibilityParams
} from './desktop/compatibility/installer-compatibility.ts';
export { resolveInstallerCompatibility } from './desktop/compatibility/installer-compatibility.ts';
export { RendererFailedToInitializeError } from './desktop/compatibility/renderer-failed-to-initialize-error.ts';
export type { SilentAsarFallbackErrorConstructorParams } from './desktop/compatibility/silent-asar-fallback-error.ts';
export { SilentAsarFallbackError } from './desktop/compatibility/silent-asar-fallback-error.ts';
export type { ConfigDirectoryFallbackErrorConstructorParams } from './desktop/config-directory-fallback-error.ts';
export { ConfigDirectoryFallbackError } from './desktop/config-directory-fallback-error.ts';
export {
  assertValidConfigDirectory,
  DEFAULT_CONFIG_DIRECTORY
} from './desktop/config-directory.ts';
export type {
  CdpConnection,
  ConnectToCdpOptions
} from './desktop/connect-to-cdp.ts';
export { connectToCdp } from './desktop/connect-to-cdp.ts';
export type { OwnedInstanceExitedErrorConstructorParams } from './desktop/owned-instance/owned-instance-exited-error.ts';
export { OwnedInstanceExitedError } from './desktop/owned-instance/owned-instance-exited-error.ts';
export type {
  DesktopCdpTransportConfig,
  OwnedInstanceAsar,
  OwnedInstanceConfig,
  OwnedInstanceEndpoint
} from './desktop/transport-desktop-cdp.ts';
export { DesktopCdpTransport } from './desktop/transport-desktop-cdp.ts';
export type {
  ObsidianRuntimeVersions,
  ObsidianVersionChangelogUrls,
  ObsidianVersionDownloads,
  ObsidianVersionMetadata
} from './desktop/versions/obsidian-metadata.ts';
export { getVersionMetadata } from './desktop/versions/obsidian-metadata.ts';
export {
  CATALYST_LATEST,
  PUBLIC_LATEST
} from './desktop/versions/obsidian-version.ts';
export type { RunObsidianVersionMatrixParams } from './desktop/versions/run-version-matrix.ts';
export { runObsidianVersionMatrix } from './desktop/versions/run-version-matrix.ts';
export type { ObsidianVersionMatrixEntry } from './desktop/versions/version-matrix.ts';
export { DEFAULT_OBSIDIAN_VERSION_SPECS } from './desktop/versions/version-matrix.ts';
export type { EvalCapExceededErrorConstructorParams } from './eval/eval-cap-exceeded-error.ts';
export {
  EvalCapExceededError,
  isScriptTimeoutError
} from './eval/eval-cap-exceeded-error.ts';
export { DEFAULT_EVAL_CAP_IN_MILLISECONDS } from './eval/eval-cap.ts';
export type {
  ClickElementParams,
  ClickMouseParams,
  CommonArguments,
  CreateNoteParams,
  DragMouseParams,
  EvalInObsidianParams,
  GenericObject,
  HoverElementParams,
  Lib,
  MouseButton,
  MousePoint,
  MoveMouseParams,
  OpenSettingsTabParams,
  PressKeyParams,
  TypeIntoEditorParams,
  UnhoverElementParams,
  WaitUntilParams
} from './eval/eval-in-obsidian.ts';
export { evalInObsidian } from './eval/eval-in-obsidian.ts';
export type { PollInObsidianParams } from './eval/poll-in-obsidian.ts';
export { pollInObsidian } from './eval/poll-in-obsidian.ts';
export type { LibResolver } from './namespace/lib-registry.ts';
export { registerLibResolver } from './namespace/lib-registry.ts';
export type { OpenObsidianSettingsTabParams } from './namespace/open-obsidian-settings-tab.ts';
export { openObsidianSettingsTab } from './namespace/open-obsidian-settings-tab.ts';
export { DesktopOnlyPluginSkipError } from './plugin/desktop-only-plugin-skip-error.ts';
export type { StaleBuildErrorConstructorParams } from './plugin/stale-build-error.ts';
export { StaleBuildError } from './plugin/stale-build-error.ts';
export type {
  ContextArguments,
  ContextOf
} from './transport/context-id.ts';
export { ContextId } from './transport/context-id.ts';
export type {
  SetupErrorResolver,
  TransportOptionsResolver,
  VaultPathResolver
} from './transport/context-provider.ts';
export {
  setSetupErrorResolver,
  setTransportOptionsResolver,
  setVaultPathResolver
} from './transport/context-provider.ts';
export type { IntegrationSetupFailedErrorConstructorParams } from './transport/integration-setup-failed-error.ts';
export { IntegrationSetupFailedError } from './transport/integration-setup-failed-error.ts';
export { createTransportFromOptions } from './transport/transport-factory.ts';
export type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianCdpTransportOptions,
  ObsidianTransportOptions
} from './transport/transport-options.ts';
export { checkIsMobileTransport } from './transport/transport-options.ts';
export type {
  ConsoleCaptureHandle,
  ObsidianTransport,
  TransportEvalOptions
} from './transport/transport.ts';
export type {
  AppConfigRestore,
  GetAppConfigParams,
  SetAppConfigParams,
  WithAppConfigParams
} from './vault/app-config.ts';
export {
  getAppConfig,
  restoreAppConfig,
  setAppConfig,
  withAppConfig
} from './vault/app-config.ts';
export type {
  BootstrapDemoVaultPluginsParams,
  BootstrapDemoVaultPluginsResult,
  BuildDemoVaultPopulateAsyncParams,
  InstalledPluginInfo
} from './vault/demo-vault/demo-vault-bootstrap.ts';
export {
  bootstrapDemoVaultPlugins,
  buildDemoVaultPopulateAsync
} from './vault/demo-vault/demo-vault-bootstrap.ts';
export type {
  BuildDemoVaultPopulateParams,
  InjectPluginParams,
  ResolveInjectedPluginStaleReasonParams,
  ResolveMissingInjectedPluginsParams
} from './vault/demo-vault/demo-vault-populate.ts';
export {
  buildDemoVaultPopulate,
  resolveInjectedPluginStaleReason,
  resolveMissingInjectedPlugins
} from './vault/demo-vault/demo-vault-populate.ts';
export type { ReadDemoVaultTreeParams } from './vault/demo-vault/demo-vault-tree.ts';
export { readDemoVaultTree } from './vault/demo-vault/demo-vault-tree.ts';
export type {
  PopulateFileContent,
  PopulateFilesParams,
  TemporaryVaultConstructorOptions
} from './vault/temporary-vault.ts';
export { TemporaryVault } from './vault/temporary-vault.ts';
export {
  registerVault,
  unregisterVault
} from './vault/vault-registry.ts';
