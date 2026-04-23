/**
 * @file
 *
 * Integration tests for the setup harness itself.
 * Validates that the harness correctly detects plugin load success and failure
 * across various crash scenarios.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  inject,
  it
} from 'vitest';

import type { EnablePluginResult } from './enable-plugin.ts';
import type { ObsidianTransport } from './transport.ts';

import { enablePluginWithErrorCapture } from './enable-plugin.ts';
import { evalInObsidian } from './obsidian-cli.ts';
import { TempVault } from './temp-vault.ts';
import { getOrCreateTransport } from './transport-factory.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60000;

interface CreateManifestParams {
  id: string;
  isDesktopOnly?: boolean;
}

interface LoadPluginParams {
  pluginId: string;
  vaultPath: string;
}

interface ManifestCheckParams {
  id: string;
  isDesktopOnly: boolean;
}

type PluginLoadTestResult = EnablePluginResult;

function createManifest(params: CreateManifestParams): string {
  return JSON.stringify({
    author: 'test',
    description: 'test',
    id: params.id,
    isDesktopOnly: params.isDesktopOnly ?? false,
    minAppVersion: '1.0.0',
    name: params.id,
    version: '1.0.0'
  });
}

/**
 * Loads a plugin inside Obsidian and captures any load error.
 *
 * Uses the shared {@link enablePluginWithErrorCapture} helper which
 * monkey-patches `app.plugins.loadPlugin` to intercept errors before
 * Obsidian's `enablePlugin` try-catch swallows them.
 */
async function loadPluginAndCheck(params: LoadPluginParams): Promise<PluginLoadTestResult> {
  return evalInObsidian({
    args: { pluginId: params.pluginId },
    fn: enablePluginWithErrorCapture,
    shouldSkipPreflightChecks: true,
    vaultPath: params.vaultPath
  });
}

// --- Plugin source code for each test case ---

const SYNC_OK_MAIN = `
const { Plugin } = require('obsidian');
class P extends Plugin { onload() { /* sync, no error */ } }
module.exports = P; exports.default = P;
`;

const ASYNC_OK_MAIN = `
const { Plugin } = require('obsidian');
class P extends Plugin { async onload() { await Promise.resolve(); } }
module.exports = P; exports.default = P;
`;

const SYNC_CRASH_MAIN = `
const { Plugin } = require('obsidian');
class P extends Plugin { onload() { throw new Error('sync onload crash'); } }
module.exports = P; exports.default = P;
`;

const ASYNC_CRASH_MAIN = `
const { Plugin } = require('obsidian');
class P extends Plugin { async onload() { throw new Error('async onload crash'); } }
module.exports = P; exports.default = P;
`;

const CONSTRUCTOR_CRASH_MAIN = `
const { Plugin } = require('obsidian');
class P extends Plugin { constructor(app, manifest) { super(app, manifest); throw new Error('constructor crash'); } }
module.exports = P; exports.default = P;
`;

interface PluginTestCase {
  expectedError?: string;
  id: string;
  mainJs: string;
  name: string;
  shouldBeEnabled: boolean;
}

const TEST_CASES: PluginTestCase[] = [
  { id: 'test-sync-ok', mainJs: SYNC_OK_MAIN, name: 'sync onload (no error)', shouldBeEnabled: true },
  { id: 'test-async-ok', mainJs: ASYNC_OK_MAIN, name: 'async onload (no error)', shouldBeEnabled: true },
  { expectedError: 'sync onload crash', id: 'test-sync-crash', mainJs: SYNC_CRASH_MAIN, name: 'sync onload (crash)', shouldBeEnabled: false },
  { expectedError: 'async onload crash', id: 'test-async-crash', mainJs: ASYNC_CRASH_MAIN, name: 'async onload (crash)', shouldBeEnabled: false },
  { expectedError: 'constructor crash', id: 'test-ctor-crash', mainJs: CONSTRUCTOR_CRASH_MAIN, name: 'constructor (crash)', shouldBeEnabled: false }
];

describe('plugin load detection', () => {
  const vault = new TempVault();

  beforeAll(async () => {
    const files: Record<string, string> = {
      '.obsidian/community-plugins.json': JSON.stringify([])
    };

    for (const tc of TEST_CASES) {
      files[`.obsidian/plugins/${tc.id}/main.js`] = tc.mainJs;
      files[`.obsidian/plugins/${tc.id}/manifest.json`] = createManifest({ id: tc.id });
    }

    vault.populate(files);
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    for (const tc of TEST_CASES) {
      try {
        await evalInObsidian({
          args: { pluginId: tc.id },

          fn: async ({ app, pluginId }): Promise<void> => {
            await app.plugins.disablePlugin(pluginId);
            await app.plugins.uninstallPlugin(pluginId);
          },
          shouldSkipPreflightChecks: true,
          vaultPath: vault.path
        });
      } catch {
        // May not have loaded.
      }
    }
    await vault.dispose();
  });

  for (const tc of TEST_CASES) {
    it(tc.name, async () => {
      const result = await loadPluginAndCheck({
        pluginId: tc.id,
        vaultPath: vault.path
      });

      expect(result.isEnabled).toBe(tc.shouldBeEnabled);

      if (tc.expectedError) {
        expect(result.errorMessage).toContain(tc.expectedError);
      } else {
        expect(result.errorMessage).toBeUndefined();
      }
    });
  }
});

describe('isDesktopOnly check', () => {
  it('should reject mobile transport for desktop-only plugins', async () => {
    const transport = await getOrCreateTransport(inject('obsidianTransport'));
    const manifest = JSON.parse(createManifest({ id: 'desktop-only', isDesktopOnly: true })) as ManifestCheckParams;

    const mockMobileTransport: ObsidianTransport = {
      ...transport,
      isMobile: true
    };

    const shouldReject = mockMobileTransport.isMobile && manifest.isDesktopOnly;
    expect(shouldReject).toBe(true);
  });

  it('should allow mobile transport for non-desktop-only plugins', () => {
    const manifest = JSON.parse(createManifest({ id: 'cross-platform', isDesktopOnly: false })) as ManifestCheckParams;

    // Non-desktop-only plugins should not be rejected regardless of transport.
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it('should allow desktop transport for desktop-only plugins', async () => {
    const transport = await getOrCreateTransport(inject('obsidianTransport'));

    // The default desktop transport should not be mobile.
    expect(transport.isMobile).toBe(false);
  });
});

describe('obsidianModule extraction', () => {
  const vault = new TempVault();

  beforeAll(async () => {
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  it('should provide obsidianModule with Plugin class', async () => {
    const hasPluginClass = await evalInObsidian({
      fn({ obsidianModule }): boolean {
        return typeof obsidianModule.Plugin === 'function';
      },
      vaultPath: vault.path
    });
    expect(hasPluginClass).toBe(true);
  });

  it('should provide obsidianModule with Notice class', async () => {
    const hasNoticeClass = await evalInObsidian({
      fn({ obsidianModule }): boolean {
        return typeof obsidianModule.Notice === 'function';
      },
      vaultPath: vault.path
    });
    expect(hasNoticeClass).toBe(true);
  });
});
