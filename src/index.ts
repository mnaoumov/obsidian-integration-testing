/**
 * @file
 *
 * Contains the entry point for the integration testing module.
 */

export type {
  AsarFallback,
  AsarFallbackTier,
  CheckAsarFallbackParams
} from './asar-fallback-detection.ts';
export { checkAsarFallback } from './asar-fallback-detection.ts';
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
export type { ReadDemoVaultTreeParams } from './demo-vault-tree.ts';
export { readDemoVaultTree } from './demo-vault-tree.ts';
export type {
  CheckElectronCompatibilityParams,
  ElectronCompatibility,
  ElectronCompatibilityTier
} from './electron-compatibility.ts';
export { checkElectronCompatibility } from './electron-compatibility.ts';
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
  CheckInstallerCompatibilityParams,
  InstallerCompatibility,
  InstallerCompatibilityTier
} from './installer-compatibility.ts';
export { checkInstallerCompatibility } from './installer-compatibility.ts';
export type { LibResolver } from './lib-registry.ts';
export { registerLibResolver } from './lib-registry.ts';
export type {
  ObsidianRuntimeVersions,
  ObsidianVersionDownloads,
  ObsidianVersionMetadata
} from './obsidian-metadata.ts';
export { getVersionMetadata } from './obsidian-metadata.ts';
export type { PollInObsidianParams } from './poll-in-obsidian.ts';
export { pollInObsidian } from './poll-in-obsidian.ts';
export { RendererFailedToInitializeError } from './renderer-failed-to-initialize-error.ts';
export type { SilentAsarFallbackErrorConstructorParams } from './silent-asar-fallback-error.ts';
export { SilentAsarFallbackError } from './silent-asar-fallback-error.ts';
export type {
  PopulateFileContent,
  PopulateFilesParams
} from './temp-vault.ts';
export { TempVault } from './temp-vault.ts';
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
