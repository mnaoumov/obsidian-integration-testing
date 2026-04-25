/**
 * @file
 *
 * Framework-agnostic core logic for integration test global setup and teardown.
 *
 * Vitest and Jest adapters delegate to these functions.
 */

/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import type { PluginManifest } from 'obsidian';

import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  stat,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

import type { ObsidianTransportOptions } from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';

import { enablePluginWithErrorCapture } from './enable-plugin.ts';
import { log } from './log.ts';
import { evalInObsidian } from './obsidian-cli.ts';
import { TempVault } from './temp-vault.ts';
import { createTransportFromOptions } from './transport-factory.ts';

const DIST_DEV = 'dist/dev';
const DIST_BUILD = 'dist/build';
const MAIN_JS = 'main.js';
const OBSIDIAN_CONFIG_DIR = '.obsidian';
const PLUGINS_DIR = 'plugins';
const COMMUNITY_PLUGINS_JSON = 'community-plugins.json';

/**
 * Parameters for {@link coreSetup}.
 */
export interface CoreSetupParams {
  /** Transport options. When omitted, defaults to the CLI transport. */
  transportOptions?: ObsidianTransportOptions | undefined;
}

/**
 * Result returned by {@link coreSetup}, used by framework adapters
 * to pass context to test workers.
 */
export interface CoreSetupResult {
  /** The temporary vault created during setup. */
  tempVault: TempVault;

  /** The transport instance used during setup. */
  transport: ObsidianTransport;

  /** The transport options that were resolved. */
  transportOptions: ObsidianTransportOptions | undefined;
}

/**
 * Framework-agnostic global setup logic.
 *
 * Loads `.env` from the project root, creates a transport, copies the built
 * plugin into a temporary vault, registers the vault with Obsidian, and
 * enables the plugin.
 *
 * @param params - Setup parameters.
 * @returns The setup result containing the temp vault, transport, and resolved options.
 */
export async function coreSetup(params?: CoreSetupParams): Promise<CoreSetupResult> {
  const projectRoot = findProjectRoot();
  const envFilePath = join(projectRoot, '.env');
  if (existsSync(envFilePath)) {
    loadEnvFile(envFilePath);
  }

  const transportOptions = params?.transportOptions;
  log('[integration-setup] Creating transport...');
  const transport = await createTransportFromOptions(transportOptions);
  log(`[integration-setup] Transport created: ${transport.constructor.name}`);

  let tempVault: TempVault | undefined;

  try {
    log(`[integration-setup] Project root: ${projectRoot}`);
    const distPath = await resolveDistPath(projectRoot);
    const manifestJson = JSON.parse(await readFile(join(distPath, 'manifest.json'), 'utf-8')) as PluginManifest;
    const pluginId = manifestJson.id;

    if (transport.isMobile && manifestJson.isDesktopOnly) {
      throw new Error(
        `Plugin "${pluginId}" has isDesktopOnly: true in manifest.json. Mobile integration tests cannot run for desktop-only plugins.`
      );
    }

    const mainJs = join(distPath, MAIN_JS);
    const buildStat = await stat(mainJs);

    log(`[integration-setup] Using ${distPath} (${buildStat.mtime.toISOString()}). If outdated, rebuild.`);

    tempVault = new TempVault();
    log(`[integration-setup] Created temp vault: ${tempVault.path}`);
    const pluginDir = join(tempVault.path, OBSIDIAN_CONFIG_DIR, PLUGINS_DIR, pluginId);
    await mkdir(pluginDir, { recursive: true });
    await cp(distPath, pluginDir, { recursive: true });
    await writeFile(join(tempVault.path, OBSIDIAN_CONFIG_DIR, COMMUNITY_PLUGINS_JSON), JSON.stringify([pluginId]));

    log('[integration-setup] Syncing vault to device...');
    await tempVault.syncToDevice(transport);
    log('[integration-setup] Registering vault...');
    await tempVault.register(transport);
    log('[integration-setup] Vault registered.');

    // Enable the plugin and verify it loaded. Obsidian's enablePlugin() wraps
    // LoadPlugin() in a try-catch that swallows errors and returns false.
    // We monkey-patch loadPlugin() to capture the error before it's swallowed.
    log(`[integration-setup] Enabling plugin "${pluginId}"...`);
    const { errorMessage } = await evalInObsidian({
      args: { pluginId },
      fn: enablePluginWithErrorCapture,
      shouldSkipPreflightChecks: true,
      transport,
      vaultPath: tempVault.path
    });

    if (errorMessage) {
      throw new Error(`Plugin "${pluginId}" failed to load: ${errorMessage}`);
    }

    log(`[integration-setup] Plugin "${pluginId}" enabled successfully.`);
  } catch (error: unknown) {
    log('[integration-setup] Setup failed, cleaning up...');
    try {
      if (tempVault) {
        await tempVault.dispose(transport);
      }
    } catch (cleanupError: unknown) {
      log(`[integration-setup] Vault cleanup error (non-fatal): ${String(cleanupError)}`);
    }
    try {
      await transport.dispose?.();
    } catch (cleanupError: unknown) {
      log(`[integration-setup] Transport cleanup error (non-fatal): ${String(cleanupError)}`);
    }
    throw error;
  }

  return { tempVault, transport, transportOptions };
}

/**
 * Framework-agnostic global teardown logic.
 *
 * Disposes of the temporary vault and transport created during setup.
 *
 * @param result - The result from {@link coreSetup}. When `undefined`, does nothing.
 */
export async function coreTeardown(result?: CoreSetupResult): Promise<void> {
  await result?.tempVault.dispose(result.transport);
  await result?.transport.dispose?.();
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
