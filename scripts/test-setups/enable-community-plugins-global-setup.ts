/**
 * @file
 *
 * Vitest global setup for the `enableCommunityPlugins` end-to-end regression test.
 *
 * Exercises BOTH additions against a real Obsidian instance:
 *
 * - **Gap 2** — {@link buildDemoVaultPopulate} composes the populate map for a throwaway `demo-vault/`
 *   containing two inline dummy community plugins (seeded via `injectPlugins`).
 * - **Gap 1** — `createSetup({ installPlugin: false, enableCommunityPlugins })` registers the vault and
 *   enables both seeded plugins (there is no plugin-under-test — the harness ships no plugin `dist`).
 *
 * The companion test (`enable-community-plugins.integration.test.ts`) evals from a worker and asserts both
 * dummy plugins loaded, which passes only if the extra-enable loop in `coreSetup` ran.
 *
 * A third dummy rides the same seeding path for a different reason: it patches `app.plugins.loadPlugin` and
 * `console.error` from its own `onload`, which is exactly the window in which `enablePluginWithErrorCapture`
 * holds its own patches on both slots. It is enabled FIRST, so the companion test's survival assertions
 * cover both halves of the restore — that plugin's own enable, whose `finally` used to overwrite the patch
 * with the value read before the plugin existed, and the two enables that run over the top of it afterwards.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PopulateFilesParams } from '../../src/vault/temporary-vault.ts';

import { buildDemoVaultPopulate } from '../../src/vault/demo-vault/demo-vault-populate.ts';
import { createSetup } from '../../src/vitest/global-setup.ts';

/**
 * The dummy community-plugin id whose `onload` monkey-patches the two slots the enable helper patches too.
 * Enabled first (see the file comment), so the patches it installs face every later enable's restore as well
 * as its own.
 */
export const PATCHING_PLUGIN_ID = 'enable-extra-patcher';

/**
 * The marker property the patching dummy hangs on each function it installs. The companion test looks for it
 * by name and duplicates the literal rather than importing it: an `evalInObsidian` callback is serialized
 * into the renderer and cannot close over module scope.
 */
export const PATCH_MARKER = 'obsidianIntegrationTestingPatchMarker';

/**
 * The dummy community-plugin ids seeded into the demo vault and enabled via
 * `enableCommunityPlugins`. Kept in sync with the companion test's assertions.
 */
export const EXTRA_PLUGIN_IDS = [PATCHING_PLUGIN_ID, 'enable-extra-a', 'enable-extra-b'];

/**
 * The body of every dummy but the patching one: a plugin that loads and does nothing.
 */
const PLAIN_PLUGIN_SOURCE = `const { Plugin } = require('obsidian');
class P extends Plugin { onload() {} }
module.exports = P; exports.default = P;
`;

/*
 * The patching dummy. Both patches take `monkey-around`'s shape — an own property holding a wrapper that
 * delegates to what it replaced — and both unpatch on unload under the same identity guard the enable helper
 * uses, so the plugin leaves nothing behind if it is disabled. The marker property is what the companion
 * test looks for: finding it after setup means the function installed during `onload` is still the one in
 * the slot.
 */
const PATCHING_PLUGIN_SOURCE = `const { Plugin } = require('obsidian');
const MARKER = '${PATCH_MARKER}';
function patch(target, key) {
  const original = target[key];
  const wrapper = function (...args) { return original.apply(this, args); };
  wrapper[MARKER] = true;
  target[key] = wrapper;
  return () => {
    if (target[key] === wrapper) {
      target[key] = original;
    }
  };
}
class P extends Plugin {
  onload() {
    this.register(patch(this.app.plugins, 'loadPlugin'));
    this.register(patch(console, 'error'));
  }
}
module.exports = P; exports.default = P;
`;

/**
 * A dummy listed in `community-plugins.json` itself rather than in `enableCommunityPlugins`, so nothing but
 * Obsidian's own startup ever loads it. Its `onload` records what the workspace looked like, which the
 * companion test reads: a startup load runs before `workspace.loadLayout()` sets `rootSplit`.
 */
export const STARTUP_PROBE_PLUGIN_ID = 'enable-extra-startup-probe';

/*
 * The startup probe. The record lives on `window` rather than on the plugin, so it is readable without
 * assuming the plugin loaded at all.
 */
const STARTUP_PROBE_PLUGIN_SOURCE = `const { Plugin } = require('obsidian');
class P extends Plugin {
  onload() {
    window.obsidianIntegrationTestingStartupProbe = {
      isLayoutReady: this.app.workspace.layoutReady === true,
      isRootSplitNull: this.app.workspace.rootSplit === null
    };
  }
}
module.exports = P; exports.default = P;
`;

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
 * Builds the populate map (invoked once, during setup): materializes a throwaway demo vault with the inline
 * dummy plugins, then composes it with {@link buildDemoVaultPopulate}.
 *
 * @returns The populate map for the temp vault.
 */
function buildDemoVaultPopulateForTest(): PopulateFilesParams {
  demoVaultPath = mkdtempSync(join(tmpdir(), 'enable-community-plugins-demo-vault-'));
  writeFileSync(join(demoVaultPath, 'note.md'), '# Demo note\n');

  const pluginIds = [...EXTRA_PLUGIN_IDS, STARTUP_PROBE_PLUGIN_ID];
  for (const pluginId of pluginIds) {
    const pluginDirectory = join(demoVaultPath, '.obsidian', 'plugins', pluginId);
    mkdirSync(pluginDirectory, { recursive: true });
    writeFileSync(join(pluginDirectory, 'main.js'), resolvePluginSource(pluginId));
    writeFileSync(
      join(pluginDirectory, 'manifest.json'),
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

  return {
    ...buildDemoVaultPopulate({
      demoVaultPath,
      injectPlugins: pluginIds.map((pluginId) => ({ pluginId }))
    }),
    // `installPlugin: false` leaves this file to the populate map, so the startup probe is the only plugin
    // enabled when the vault opens.
    '.obsidian/community-plugins.json': JSON.stringify([STARTUP_PROBE_PLUGIN_ID])
  };
}

/**
 * Picks a dummy plugin's `main.js`.
 *
 * @param pluginId - The dummy's id.
 * @returns Its source.
 */
function resolvePluginSource(pluginId: string): string {
  switch (pluginId) {
    case PATCHING_PLUGIN_ID: {
      return PATCHING_PLUGIN_SOURCE;
    }
    case STARTUP_PROBE_PLUGIN_ID: {
      return STARTUP_PROBE_PLUGIN_SOURCE;
    }
    default: {
      return PLAIN_PLUGIN_SOURCE;
    }
  }
}
