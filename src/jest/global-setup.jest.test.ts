/**
 * @jest-environment node
 */

import {
  getTemporaryVault,
  getTransportOptions
} from './global-setup.ts';

describe('jest global-setup', () => {
  it('should throw when temporaryVaultPath is not set', () => {
    globalThis.__obsidianIntegrationTesting = undefined;
    expect(() => getTemporaryVault()).toThrow(
      'globalThis.__obsidianIntegrationTesting.temporaryVaultPath is not set'
    );
  });

  it('should return a TemporaryVault when temporaryVaultPath is set', () => {
    globalThis.__obsidianIntegrationTesting = {
      temporaryVaultPath: '/tmp/test-vault'
    };
    const vault = getTemporaryVault();
    expect(vault.path).toBe('/tmp/test-vault');
  });

  it('should return undefined transport options when not configured', () => {
    globalThis.__obsidianIntegrationTesting = undefined;
    expect(getTransportOptions()).toBeUndefined();
  });

  it('should return transport options when configured', () => {
    globalThis.__obsidianIntegrationTesting = {
      transportOptions: { type: 'obsidian-cdp' }
    };
    expect(getTransportOptions()).toEqual({ type: 'obsidian-cdp' });
  });
});
