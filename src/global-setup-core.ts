/**
 * @file
 *
 * Framework-agnostic core logic for integration test global setup and teardown.
 *
 * Vitest and Jest adapters delegate to these functions.
 */

/* v8 ignore start -- Integration-time setup covered by integration tests, not unit tests. */

import type { PluginManifest } from 'obsidian';

import {
  existsSync,
  rmSync
} from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  stat,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import process, { loadEnvFile } from 'node:process';
import { setTimeout as nativeSetTimeout } from 'node:timers';

import type { ObsidianTransportOptions } from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';

import { enablePluginWithErrorCapture } from './enable-plugin.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { log } from './log.ts';
import { TempVault } from './temp-vault.ts';
import { createTransportFromOptions } from './transport-factory.ts';

const DEFAULT_TRANSPORT_TYPE = 'obsidian-cli';
const DIST_DEV = 'dist/dev';
const DIST_BUILD = 'dist/build';
const MAIN_JS = 'main.js';
const OBSIDIAN_CONFIG_DIR = '.obsidian';
const PLUGINS_DIR = 'plugins';
const COMMUNITY_PLUGINS_JSON = 'community-plugins.json';

/**
 * Tracks setups that completed successfully but haven't been torn down yet.
 * Used by the `beforeExit` handler to clean up when a test runner exits
 * without calling teardown (e.g., when one project's setup fails and the
 * runner aborts before tearing down already-initialized projects).
 */
const activeSetups = new Set<CoreSetupResult>();
const disposedResults = new WeakSet<CoreSetupResult>();
let isCleanupHandlerRegistered = false;

const TEARDOWN_TIMEOUT_IN_MILLISECONDS = 15000;
const FORCE_EXIT_TIMEOUT_IN_MILLISECONDS = 20000;

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

  /** Short label for log messages (e.g. `"obsidian-cli"`, `"obsidian-cdp"`). */
  transportLabel: string;

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
  const label = transportOptions?.type ?? DEFAULT_TRANSPORT_TYPE;
  log(`[integration-setup:${label}] Creating transport...`);
  const transport = await createTransportFromOptions(transportOptions);
  log(`[integration-setup:${label}] Transport created: ${transport.constructor.name}`);

  let tempVault: TempVault | undefined;

  try {
    log(`[integration-setup:${label}] Project root: ${projectRoot}`);
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

    log(`[integration-setup:${label}] Using ${distPath} (${buildStat.mtime.toISOString()}). If outdated, rebuild.`);

    tempVault = new TempVault();
    log(`[integration-setup:${label}] Created temp vault: ${tempVault.path}`);
    const pluginDir = join(tempVault.path, OBSIDIAN_CONFIG_DIR, PLUGINS_DIR, pluginId);
    await mkdir(pluginDir, { recursive: true });
    await cp(distPath, pluginDir, { recursive: true });
    await writeFile(join(tempVault.path, OBSIDIAN_CONFIG_DIR, COMMUNITY_PLUGINS_JSON), JSON.stringify([pluginId]));

    log(`[integration-setup:${label}] Syncing vault to device...`);
    await tempVault.syncToDevice(transport);
    log(`[integration-setup:${label}] Registering vault...`);
    await tempVault.register(transport);
    log(`[integration-setup:${label}] Vault registered.`);

    // Enable the plugin and verify it loaded. Obsidian's enablePlugin() wraps
    // LoadPlugin() in a try-catch that swallows errors and returns false.
    // We monkey-patch loadPlugin() to capture the error before it's swallowed.
    log(`[integration-setup:${label}] Enabling plugin "${pluginId}"...`);
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

    log(`[integration-setup:${label}] Plugin "${pluginId}" enabled successfully.`);
  } catch (error: unknown) {
    log(`[integration-setup:${label}] Setup failed, cleaning up...`);
    try {
      if (tempVault) {
        await tempVault.dispose(transport);
      }
    } catch (cleanupError: unknown) {
      log(`[integration-setup:${label}] Vault cleanup error (non-fatal): ${String(cleanupError)}`);
    }
    try {
      await transport.dispose?.();
    } catch (cleanupError: unknown) {
      log(`[integration-setup:${label}] Transport cleanup error (non-fatal): ${String(cleanupError)}`);
    }

    // Tear down any previously successful setups. The test runner will abort
    // After this error and won't call their teardown functions. Doing it here
    // While we're still in async context avoids relying on the sync `exit`
    // Handler (which can only do best-effort cleanup).
    for (const activeResult of [...activeSetups]) {
      log(`[integration-setup:${label}] Tearing down previously successful setup (${activeResult.transportLabel})...`);
      await coreTeardown(activeResult);
    }

    log(`[integration-setup:${label}] NOTE: If the test runner reports "No test files found", ignore it — it is a side effect of the setup failure above.`);
    throw error;
  }

  const result: CoreSetupResult = { tempVault, transport, transportLabel: label, transportOptions };
  activeSetups.add(result);
  registerProcessCleanupHandler();
  return result;
}

/**
 * Framework-agnostic global teardown logic.
 *
 * Disposes of the temporary vault and transport created during setup.
 *
 * @param result - The result from {@link coreSetup}. When `undefined`, does nothing.
 */
export async function coreTeardown(result?: CoreSetupResult): Promise<void> {
  if (!result || disposedResults.has(result)) {
    return;
  }
  disposedResults.add(result);

  log(`[integration-teardown:${result.transportLabel}] Tearing down (timeout: ${String(TEARDOWN_TIMEOUT_IN_MILLISECONDS)}ms)...`);

  // Native setTimeout from node:timers bypasses Vite's module runner,
  // Which patches the global setTimeout and prevents it from firing.
  const forceExitTimer = nativeSetTimeout(() => {
    log(`[integration-teardown:${result.transportLabel}] Teardown timed out after ${String(TEARDOWN_TIMEOUT_IN_MILLISECONDS)}ms, forcing exit...`);
    process.exit(1);
  }, TEARDOWN_TIMEOUT_IN_MILLISECONDS);

  try {
    await teardownAsync(result);
  } catch (error: unknown) {
    log(`[integration-teardown:${result.transportLabel}] Cleanup error (non-fatal): ${String(error)}`);
  } finally {
    clearTimeout(forceExitTimer);
    activeSetups.delete(result);
  }
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
 * Registers cleanup handlers for orphaned setups that were never explicitly
 * torn down.
 *
 * Two handlers cover different exit scenarios:
 *
 * - `beforeExit` — fires when the event loop drains naturally. Allows full
 *   async teardown (unregister vaults, dispose transports). Does NOT fire
 *   when `process.exit()` is called directly.
 *
 * - `unhandledRejection` — catches async errors that bypass `coreSetup`'s
 *   catch block. Performs full async teardown while we still can.
 *
 * - `exit` — fires on every exit, including `process.exit()`. Only synchronous
 *   work is possible, so this handler does best-effort cleanup: kills child
 *   processes via `disposeSync()` and removes temp vault directories with
 *   `rmSync`. Unregistering vaults (which requires IPC with Obsidian) is
 *   skipped — a stale vault entry is an acceptable trade-off vs. leaked
 *   processes and temp directories.
 */
function registerProcessCleanupHandler(): void {
  if (isCleanupHandlerRegistered) {
    return;
  }
  isCleanupHandlerRegistered = true;

  process.on('beforeExit', () => {
    if (activeSetups.size === 0) {
      return;
    }

    log(`[integration-teardown] Process exiting with ${String(activeSetups.size)} setup(s) not torn down. Cleaning up...`);

    const forceExitTimer = nativeSetTimeout(() => {
      log('[integration-teardown] Async cleanup timed out, forcing exit...');
      process.exit(1);
    }, FORCE_EXIT_TIMEOUT_IN_MILLISECONDS);
    forceExitTimer.unref();

    for (const result of [...activeSetups]) {
      coreTeardown(result).catch((error: unknown) => {
        log(`[integration-teardown:${result.transportLabel}] Process cleanup error (non-fatal): ${String(error)}`);
      });
    }
  });

  process.on('unhandledRejection', () => {
    if (activeSetups.size === 0) {
      return;
    }

    log(`[integration-teardown] Unhandled rejection detected. Tearing down ${String(activeSetups.size)} active setup(s)...`);
    for (const result of [...activeSetups]) {
      coreTeardown(result).catch((error: unknown) => {
        log(`[integration-teardown:${result.transportLabel}] Rejection cleanup error (non-fatal): ${String(error)}`);
      });
    }
  });

  process.on('exit', () => {
    if (activeSetups.size === 0) {
      return;
    }

    log(`[integration-teardown] Sync cleanup: ${String(activeSetups.size)} orphaned setup(s).`);
    for (const result of [...activeSetups]) {
      try {
        result.transport.disposeSync?.();
      } catch (error: unknown) {
        log(`[integration-teardown:${result.transportLabel}] Sync transport cleanup error (non-fatal): ${String(error)}`);
      }
      try {
        rmSync(result.tempVault.path, { force: true, recursive: true });
      } catch (error: unknown) {
        log(`[integration-teardown:${result.transportLabel}] Sync vault cleanup error (non-fatal): ${String(error)}`);
      }
    }
    activeSetups.clear();
  });
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

/**
 * Performs the async teardown work (vault disposal + transport disposal).
 *
 * @param result - The setup result to tear down.
 */
async function teardownAsync(result: CoreSetupResult): Promise<void> {
  try {
    await result.tempVault.dispose(result.transport);
  } catch (error: unknown) {
    log(`[integration-teardown:${result.transportLabel}] Vault cleanup error (non-fatal): ${String(error)}`);
  }

  try {
    await result.transport.dispose?.();
  } catch (error: unknown) {
    log(`[integration-teardown:${result.transportLabel}] Transport cleanup error (non-fatal): ${String(error)}`);
  }
}
