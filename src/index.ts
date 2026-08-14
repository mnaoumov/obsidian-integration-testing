/**
 * @file
 *
 * Contains the entry point for the integration testing module.
 */

export type {
  AsarFallback,
  AsarFallbackTier,
  ResolveAsarFallbackParams
} from './asar-fallback-detection.ts';
export { resolveAsarFallback } from './asar-fallback-detection.ts';
export type { CaptureObsidianScreenshotOptions } from './capture-obsidian-screenshot.ts';
export { captureObsidianScreenshot } from './capture-obsidian-screenshot.ts';
export type {
  CaptureScreenshotParams,
  PngDimensions
} from './capture-screenshot.ts';
export {
  buildDeviceMetricsOverride,
  decodeBase64Png,
  isPng,
  readPngDimensions
} from './capture-screenshot.ts';
export type {
  CdpConnection,
  ConnectToCdpOptions
} from './connect-to-cdp.ts';
export { connectToCdp } from './connect-to-cdp.ts';
export { ContextId } from './context-id.ts';
export type {
  TransportOptionsResolver,
  VaultPathResolver
} from './context-provider.ts';
export {
  setTransportOptionsResolver,
  setVaultPathResolver
} from './context-provider.ts';
export type {
  BuildDemoVaultPopulateParams,
  InjectPluginParams
} from './demo-vault-populate.ts';
export { buildDemoVaultPopulate } from './demo-vault-populate.ts';
export type { ReadDemoVaultTreeParams } from './demo-vault-tree.ts';
export { readDemoVaultTree } from './demo-vault-tree.ts';
export type {
  ElectronCompatibility,
  ElectronCompatibilityTier,
  ResolveElectronCompatibilityParams
} from './electron-compatibility.ts';
export { resolveElectronCompatibility } from './electron-compatibility.ts';
export type {
  EvalInObsidianParams,
  HoverElementParams,
  Lib,
  MoveMouseParams,
  PressKeyParams,
  TypeIntoEditorParams,
  UnhoverElementParams,
  WaitUntilParams
} from './eval-in-obsidian.ts';
export { evalInObsidian } from './eval-in-obsidian.ts';
export type { IncompatibleInstallerVersionErrorConstructorParams } from './incompatible-installer-version-error.ts';
export { IncompatibleInstallerVersionError } from './incompatible-installer-version-error.ts';
export type {
  InstallerCompatibility,
  InstallerCompatibilityTier,
  ResolveInstallerCompatibilityParams
} from './installer-compatibility.ts';
export { resolveInstallerCompatibility } from './installer-compatibility.ts';
export type { LibResolver } from './lib-registry.ts';
export { registerLibResolver } from './lib-registry.ts';
export type {
  ObsidianRuntimeVersions,
  ObsidianVersionDownloads,
  ObsidianVersionMetadata
} from './obsidian-metadata.ts';
export { getVersionMetadata } from './obsidian-metadata.ts';
export {
  CATALYST_LATEST,
  PUBLIC_LATEST
} from './obsidian-version.ts';
export type { PollInObsidianParams } from './poll-in-obsidian.ts';
export { pollInObsidian } from './poll-in-obsidian.ts';
export { RendererFailedToInitializeError } from './renderer-failed-to-initialize-error.ts';
export type { RunObsidianVersionMatrixParams } from './run-version-matrix.ts';
export { runObsidianVersionMatrix } from './run-version-matrix.ts';
export type { SilentAsarFallbackErrorConstructorParams } from './silent-asar-fallback-error.ts';
export { SilentAsarFallbackError } from './silent-asar-fallback-error.ts';
export type {
  PopulateFileContent,
  PopulateFilesParams
} from './temporary-vault.ts';
export { TemporaryVault } from './temporary-vault.ts';
export type {
  AppiumSessionInfo,
  AppiumTransportConfig
} from './transport-appium.ts';
export { AppiumTransport } from './transport-appium.ts';
export type {
  DesktopCdpTransportConfig,
  OwnedInstanceAsar,
  OwnedInstanceConfig
} from './transport-desktop-cdp.ts';
export { DesktopCdpTransport } from './transport-desktop-cdp.ts';
export { createTransportFromOptions } from './transport-factory.ts';
export type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianCdpTransportOptions,
  ObsidianTransportOptions
} from './transport-options.ts';
export type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';
export {
  registerVault,
  unregisterVault
} from './vault-registry.ts';
export type { ObsidianVersionMatrixEntry } from './version-matrix.ts';
export { DEFAULT_OBSIDIAN_VERSION_SPECS } from './version-matrix.ts';
