/**
 * @file
 *
 * Vitest global setup for the `configDirectory` override end-to-end regression test.
 *
 * Runs a harness-owned instance against a vault whose settings live in `.obsidian-desktop` rather than
 * `.obsidian`, with a dummy community plugin seeded through `buildDemoVaultPopulate`. Every pre-open write
 * the harness makes has to agree on that folder; until 2026-09-06 only the `app.json` write did, so the seeded
 * plugin landed in `.obsidian/` — a folder the vault never opens — and came back "enabled but not loaded"
 * with nothing naming a config folder.
 *
 * `installPlugin: false` is forced: `coreSetup` takes its project root from `findProjectRoot()` rather than
 * a parameter, and this repo ships no plugin `dist`, so `copyPluginIntoVault` is not reachable from here.
 * Its own override handling is proven by `src/vault-plugin-install.test.ts`; what this suite proves is the
 * other half — that a real Obsidian, opened under an override, finds what the harness wrote for it.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PopulateFilesParams } from '../src/temporary-vault.ts';

import { buildDemoVaultPopulate } from '../src/demo-vault-populate.ts';
import { createSetup } from '../src/vitest/global-setup.ts';

/**
 * The dummy community-plugin id seeded into the demo vault and enabled via `enableCommunityPlugins`. Kept in
 * sync with the companion test's assertions.
 */
export const OVERRIDE_PLUGIN_ID = 'config-directory-override-extra';

let demoVaultPath: string | undefined;

/*
 * The override itself is NOT set here: `createSetup` takes no transport options, reading them from the
 * project's `environmentOptions.obsidianTransport` instead — so `configDirectory` lives in this project's
 * entry in `scripts/vitest-config.ts`, beside the `.obsidian-desktop` the companion test asserts.
 */
const setupPair = createSetup({
  enableCommunityPlugins: [OVERRIDE_PLUGIN_ID],
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
 * Builds the populate map (invoked once, during setup): materializes a throwaway demo vault holding one
 * inline dummy plugin, then composes it with {@link buildDemoVaultPopulate}.
 *
 * The map it returns names its destinations under `.obsidian/`, because that is the only folder a populate
 * map can know about. Redirecting them to the override is `coreSetup`'s job — which is the thing under test.
 *
 * @returns The populate map for the temp vault.
 */
function buildDemoVaultPopulateForTest(): PopulateFilesParams {
  demoVaultPath = mkdtempSync(join(tmpdir(), 'config-directory-override-demo-vault-'));
  writeFileSync(join(demoVaultPath, 'note.md'), '# Demo note\n');

  const pluginDirectory = join(demoVaultPath, '.obsidian', 'plugins', OVERRIDE_PLUGIN_ID);
  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(
    join(pluginDirectory, 'main.js'),
    'const { Plugin } = require(\'obsidian\');\n'
      + 'class P extends Plugin { onload() {} }\n'
      + 'module.exports = P; exports.default = P;\n'
  );
  writeFileSync(
    join(pluginDirectory, 'manifest.json'),
    JSON.stringify({
      author: 'obsidian-integration-testing',
      description: `Dummy plugin ${OVERRIDE_PLUGIN_ID} for the configDirectory override regression test.`,
      id: OVERRIDE_PLUGIN_ID,
      isDesktopOnly: false,
      minAppVersion: '1.0.0',
      name: OVERRIDE_PLUGIN_ID,
      version: '1.0.0'
    })
  );

  return buildDemoVaultPopulate({
    demoVaultPath,
    injectPlugins: [{ pluginId: OVERRIDE_PLUGIN_ID }]
  });
}
