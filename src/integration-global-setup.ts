/**
 * @packageDocumentation
 *
 * Contains the global setup and teardown functions for integration tests.
 */

/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import type { PluginManifest } from 'obsidian';
import type { TestProject } from 'vitest/node';

import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  stat,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { inject } from 'vitest';

import { evalInObsidian } from './obsidian-cli.ts';
import { TempVault } from './temp-vault.ts';

declare module 'vitest' {
  interface ProvidedContext {
    tempVault: TempVault;
  }
}

/**
 * Returns the temporary vault provided by the global setup.
 *
 * @returns The temporary vault.
 */
export function getTempVault(): TempVault {
  return inject('tempVault');
}

const DIST_DEV = 'dist/dev';
const DIST_BUILD = 'dist/build';
const MAIN_JS = 'main.js';
const OBSIDIAN_CONFIG_DIR = '.obsidian';
const PLUGINS_DIR = 'plugins';
const COMMUNITY_PLUGINS_JSON = 'community-plugins.json';

let tempVault: TempVault;

/**
 * Vitest global setup function.
 *
 * Copies the built plugin into a temporary vault, enables it via the Obsidian CLI,
 * and provides `tempVaultPath` to tests.
 *
 * @param project - The Vitest project.
 */
export async function setup(project: TestProject): Promise<void> {
  const projectRoot = findProjectRoot();
  const distPath = await resolveDistPath(projectRoot);
  const manifestJson = JSON.parse(await readFile(join(distPath, 'manifest.json'), 'utf-8')) as PluginManifest;
  const pluginId = manifestJson.id;

  const mainJs = join(distPath, MAIN_JS);
  const buildStat = await stat(mainJs);

  console.warn(`Using ${distPath} (${buildStat.mtime.toISOString()}). If outdated, rebuild.`);

  tempVault = new TempVault();
  const pluginDir = join(tempVault.path, OBSIDIAN_CONFIG_DIR, PLUGINS_DIR, pluginId);
  await mkdir(pluginDir, { recursive: true });
  await cp(distPath, pluginDir, { recursive: true });
  await writeFile(join(tempVault.path, OBSIDIAN_CONFIG_DIR, COMMUNITY_PLUGINS_JSON), JSON.stringify([pluginId]));
  await tempVault.register();

  await evalInObsidian({
    args: { pluginId },
    // eslint-disable-next-line no-shadow -- No actual shadowing as the function is executed externally.
    fn: async ({ app, pluginId }) => {
      await app.plugins.enablePluginAndSave(pluginId);
    },
    shouldSkipPreflightChecks: true,
    vaultPath: tempVault.path
  });

  project.provide('tempVault', tempVault);
}

/**
 * Vitest global teardown function.
 *
 * Removes the temporary vault created during setup.
 */
export async function teardown(): Promise<void> {
  await tempVault.dispose();
}

/**
 * Finds the project root by walking up from `process.cwd()` looking for `package.json`.
 *
 * @returns The absolute path to the project root.
 */
function findProjectRoot(): string {
  let dir = process.cwd();

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Loop terminates at filesystem root.
  while (true) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) {
      throw new Error('Could not find project root (no package.json found).');
    }
    dir = parent;
  }
}

/**
 * Resolves the dist path to use for integration tests.
 *
 * Picks whichever of `dist/dev` and `dist/build` has a newer `main.js`.
 * If only one exists, that one is used. Throws if neither exists.
 *
 * @param projectRoot - The absolute path to the project root.
 * @returns The absolute path to the chosen dist folder.
 */
async function resolveDistPath(projectRoot: string): Promise<string> {
  const devPath = join(projectRoot, DIST_DEV);
  const buildPath = join(projectRoot, DIST_BUILD);
  const devMainJs = join(devPath, MAIN_JS);
  const buildMainJs = join(buildPath, MAIN_JS);
  const devStat = existsSync(devMainJs) ? await stat(devMainJs) : null;
  const buildStat = existsSync(buildMainJs) ? await stat(buildMainJs) : null;

  if (devStat && buildStat) {
    return devStat.mtime > buildStat.mtime ? devPath : buildPath;
  }

  if (devStat) {
    return devPath;
  }

  if (buildStat) {
    return buildPath;
  }

  throw new Error('No build found. Run `npm run build` or `npm run dev` first.');
}
