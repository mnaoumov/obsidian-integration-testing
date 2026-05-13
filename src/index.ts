/**
 * @file
 *
 * Contains the entry point for the integration testing module.
 */

export { ContextId } from './context-id.ts';
export type { TransportOptionsResolver } from './context-provider.ts';
export { setTransportOptionsResolver } from './context-provider.ts';
export type { EvalInObsidianParams } from './eval-in-obsidian.ts';
export { evalInObsidian } from './eval-in-obsidian.ts';
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
export type { DesktopCdpTransportConfig } from './transport-desktop-cdp.ts';
export { DesktopCdpTransport } from './transport-desktop-cdp.ts';
export { DesktopCliTransport } from './transport-desktop-cli.ts';
export { createTransportFromOptions } from './transport-factory.ts';
export type {
  ObsidianAndroidAppiumTransportOptions,
  ObsidianCdpTransportOptions,
  ObsidianCliTransportOptions,
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
