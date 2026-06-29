/**
 * @file
 *
 * Vitest global setup for the owned-instance worker-attach regression test.
 *
 * Writes a trivial fixture plugin into `dist/dev`, then delegates to the real
 * `vitest-global-setup`. That runs `coreSetup`, which launches the harness-owned
 * Obsidian instance on a free CDP port, registers the temp vault, enables the
 * fixture plugin, and — via `augmentTransportOptions` — publishes the owned
 * instance's `host`/`port` (plus the `isHarnessOwnedInstance` flag) to test
 * workers through Vitest `provide`.
 *
 * The companion test (`owned-instance-worker-attach.integration.test.ts`) evals
 * from a worker WITHOUT registering a vault in-worker, so it succeeds only if the
 * worker reads those provided options (through the `vitest-setup` resolvers) and
 * **attaches** to the owned instance. Before the fix, the worker rebuilt an
 * owned transport that never launched, so the first eval threw
 * `Failed to parse URL from /json`.
 */

import type { TestProject } from 'vitest/node';

import {
  mkdirSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  setup as integrationSetup,
  teardown as integrationTeardown
} from '../src/vitest/global-setup.ts';

const FIXTURE_PLUGIN_ID = 'owned-attach-fixture';

/**
 * Vitest global setup: write the fixture plugin, then run the real harness setup.
 *
 * @param project - The Vitest test project.
 */
export async function setup(project: TestProject): Promise<void> {
  writeFixturePlugin();
  await integrationSetup(project);
}

/**
 * Vitest global teardown — disposes the owned instance and temp vault.
 */
export async function teardown(): Promise<void> {
  await integrationTeardown();
}

/**
 * Writes a minimal, loadable Obsidian plugin into `dist/dev` so `coreSetup` has
 * a plugin to copy into the temp vault and enable. `coreSetup` reads the plugin
 * from `dist/dev` (or `dist/build`); the harness's library build lands in
 * `dist/lib`, so `dist/dev` is otherwise unused here.
 */
function writeFixturePlugin(): void {
  const distDev = join(process.cwd(), 'dist', 'dev');
  mkdirSync(distDev, { recursive: true });

  const manifest = {
    author: 'obsidian-integration-testing',
    description: 'Fixture plugin for the owned-instance worker-attach regression test.',
    id: FIXTURE_PLUGIN_ID,
    isDesktopOnly: false,
    minAppVersion: '1.0.0',
    name: 'Owned Attach Fixture',
    version: '1.0.0'
  };
  writeFileSync(join(distDev, 'manifest.json'), JSON.stringify(manifest));

  const mainJs = `const { Plugin } = require('obsidian');
class OwnedAttachFixture extends Plugin { onload() {} }
module.exports = OwnedAttachFixture;
exports.default = OwnedAttachFixture;
`;
  writeFileSync(join(distDev, 'main.js'), mainJs);
}
