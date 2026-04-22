/**
 * @file
 *
 * Contains the entry point for the integration testing module.
 */

export { ContextId } from './context-id.ts';
export type { EvalInObsidianParams } from './obsidian-cli.ts';
export { evalInObsidian } from './obsidian-cli.ts';
export { TempVault } from './temp-vault.ts';
export { DesktopCliTransport } from './transport-desktop-cli.ts';
export {
  getTransport,
  setTransport
} from './transport-state.ts';
export type {
  ObsidianTransport,
  TransportEvalOptions
} from './transport.ts';
export {
  registerVault,
  unregisterVault
} from './vault-registry.ts';
