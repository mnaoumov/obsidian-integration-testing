/**
 * @jest-environment node
 */

import {
  getTempVault,
  getTransportOptions
} from './global-setup.ts';

describe('jest global-setup', () => {
  it('should throw when tempVaultPath is not set', () => {
    globalThis.__obsidianIntegrationTesting = undefined;
    expect(() => getTempVault()).toThrow(
      'globalThis.__obsidianIntegrationTesting.tempVaultPath is not set'
    );
  });

  it('should return a TempVault when tempVaultPath is set', () => {
    globalThis.__obsidianIntegrationTesting = {
      tempVaultPath: '/tmp/test-vault'
    };
    const vault = getTempVault();
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
