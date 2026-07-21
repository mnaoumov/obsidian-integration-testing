/**
 * @file
 *
 * Vitest global setup for the `enableCommunityPlugins` end-to-end regression test.
 *
 * Exercises BOTH T121 additions against a real Obsidian instance:
 *
 * - **Gap 2** — {@link buildDemoVaultPopulate} composes the populate map for a throwaway `demo-vault/`
 *   containing two inline dummy community plugins (seeded via `injectPlugins`).
 * - **Gap 1** — `createSetup({ installPlugin: false, enableCommunityPlugins })` registers the vault and
 *   enables both seeded plugins (there is no plugin-under-test — the harness ships no plugin `dist`).
 *
 * The companion test (`enable-community-plugins.integration.test.ts`) evals from a worker and asserts both
 * dummy plugins loaded, which passes only if the extra-enable loop in `coreSetup` ran.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PopulateFilesParams } from '../src/temp-vault.ts';

import { buildDemoVaultPopulate } from '../src/demo-vault-populate.ts';
import { createSetup } from '../src/vitest/global-setup.ts';

/**
 * The two dummy community-plugin ids seeded into the demo vault and enabled via
 * `enableCommunityPlugins`. Kept in sync with the companion test's assertions.
 */
export const EXTRA_PLUGIN_IDS = ['enable-extra-a', 'enable-extra-b'];

let demoVaultPath: string | undefined;

const setupPair = createSetup({
  enableCommunityPlugins: EXTRA_PLUGIN_IDS,
  installPlugin: false,
  populate: buildDemoVaultPopulateForTest
});

/**
 * Vitest global setup — delegates to the `createSetup` pair configured above.
 */
export const setup = setupPair.setup;

/**
 * Vitest global teardown — disposes the owned instance/vault, then removes the throwaway demo vault.
 */
export async function teardown(): Promise<void> {
  try {
    await setupPair.teardown();
  } finally {
    if (demoVaultPath) {
      rmSync(demoVaultPath, { force: true, recursive: true });
    }
  }
}

/**
 * Builds the populate map (invoked once, during setup): materializes a throwaway demo vault with two inline
 * dummy plugins, then composes it with {@link buildDemoVaultPopulate}.
 *
 * @returns The populate map for the temp vault.
 */
function buildDemoVaultPopulateForTest(): PopulateFilesParams {
  demoVaultPath = mkdtempSync(join(tmpdir(), 'enable-community-plugins-demo-vault-'));
  writeFileSync(join(demoVaultPath, 'note.md'), '# Demo note\n');

  for (const pluginId of EXTRA_PLUGIN_IDS) {
    const pluginDir = join(demoVaultPath, '.obsidian', 'plugins', pluginId);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'main.js'),
      'const { Plugin } = require(\'obsidian\');\n'
        + 'class P extends Plugin { onload() {} }\n'
        + 'module.exports = P; exports.default = P;\n'
    );
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        author: 'obsidian-integration-testing',
        description: `Dummy plugin ${pluginId} for the enableCommunityPlugins regression test.`,
        id: pluginId,
        isDesktopOnly: false,
        minAppVersion: '1.0.0',
        name: pluginId,
        version: '1.0.0'
      })
    );
  }

  return buildDemoVaultPopulate({
    demoVaultPath,
    injectPlugins: EXTRA_PLUGIN_IDS.map((pluginId) => ({ pluginId }))
  });
}
