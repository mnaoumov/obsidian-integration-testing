import {
  describe,
  expect,
  it
} from 'vitest';

import { ConfigDirectoryFallbackError } from './config-directory-fallback-error.ts';

const VAULT_PATH = String.raw`F:\Obsidian`;

describe('ConfigDirectoryFallbackError', () => {
  const error = new ConfigDirectoryFallbackError({
    actualConfigDirectory: '.obsidian',
    requestedConfigDirectory: '.obsidian-desktop',
    vaultPath: VAULT_PATH
  });

  it('is an Error with the specific name', () => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ConfigDirectoryFallbackError');
  });

  it('names both config folders and the vault in the message', () => {
    expect(error.message).toContain('.obsidian-desktop');
    expect(error.message).toContain('.obsidian');
    expect(error.message).toContain(VAULT_PATH);
  });

  it('exposes the folders and the vault path as fields', () => {
    expect(error.actualConfigDirectory).toBe('.obsidian');
    expect(error.requestedConfigDirectory).toBe('.obsidian-desktop');
    expect(error.vaultPath).toBe(VAULT_PATH);
  });
});
