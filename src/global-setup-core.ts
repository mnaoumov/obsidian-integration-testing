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

import type { SetupLock } from './setup-lock.ts';
import type { PopulateFilesParams } from './temp-vault.ts';
import type { ObsidianTransportOptions } from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';

import { enablePluginWithErrorCapture } from './enable-plugin.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { log } from './log.ts';
import { serializeError } from './serialize-error.ts';
import { acquireSetupLock } from './setup-lock.ts';
import { TempVault } from './temp-vault.ts';
import { AppiumTransport } from './transport-appium.ts';
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

/**
 * The cross-process setup lock held by each active setup. Released when the
 * setup is torn down (or by the process cleanup handlers), allowing a competing
 * run to proceed. See {@link acquireSetupLock}.
 */
const setupLocks = new Map<CoreSetupResult, SetupLock>();

const DESKTOP_LOCK_SCOPE = 'desktop';
const ANDROID_LOCK_SCOPE = 'android';

/**
 * Parameters for {@link coreSetup}.
 */
export interface CoreSetupParams {
  /**
   * Files and folders to write into the vault **before** Obsidian opens it, so
   * its startup scan indexes them in one pass (see {@link TempVault.populate}).
   * Use this for large fixtures — writing thousands of notes after open and
   * forcing a re-scan is far slower and less reliable.
   */
  readonly populate?: PopulateFilesParams | undefined;

  /** Transport options. When omitted, defaults to the CLI transport. */
  readonly transportOptions?: ObsidianTransportOptions | undefined;
}

/**
 * Result returned by {@link coreSetup}, used by framework adapters
 * to pass context to test workers.
 */
export interface CoreSetupResult {
  /** The temporary vault created during setup. */
  readonly tempVault: TempVault;

  /** The transport instance used during setup. */
  readonly transport: ObsidianTransport;

  /** Short label for log messages (e.g. `"obsidian-cli"`, `"obsidian-cdp"`). */
  readonly transportLabel: string;

  /** The transport options that were resolved. */
  readonly transportOptions: ObsidianTransportOptions | undefined;
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
  const lockScope = getLockScope(transportOptions);

  log(`[integration-setup:${label}] Acquiring '${lockScope}' setup lock (serializes against any concurrent integration-test run)...`);
  const lock = await acquireSetupLock({ label, scope: lockScope });
  log(`[integration-setup:${label}] Setup lock acquired.`);

  let transport: ObsidianTransport | undefined;
  let tempVault: TempVault | undefined;

  try {
    log(`[integration-setup:${label}] Creating transport...`);
    transport = await createTransportFromOptions(transportOptions);
    log(`[integration-setup:${label}] Transport created: ${transport.constructor.name}`);

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

    if (params?.populate) {
      const entryCount = Object.keys(params.populate).length;
      log(`[integration-setup:${label}] Populating vault with ${String(entryCount)} entries before open...`);
      tempVault.populate(params.populate);
    }

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

    const augmentedOptions = augmentTransportOptions(transportOptions, transport);
    const result: CoreSetupResult = { tempVault, transport, transportLabel: label, transportOptions: augmentedOptions };
    activeSetups.add(result);
    setupLocks.set(result, lock);
    registerProcessCleanupHandler();
    return result;
  } catch (error: unknown) {
    log(`[integration-setup:${label}] Setup failed, cleaning up...`);
    try {
      if (tempVault && transport) {
        await tempVault.dispose(transport);
      }
    } catch (cleanupError: unknown) {
      log(`[integration-setup:${label}] Vault cleanup error (non-fatal): ${serializeError(cleanupError)}`);
    }
    try {
      await transport?.dispose?.();
    } catch (cleanupError: unknown) {
      log(`[integration-setup:${label}] Transport cleanup error (non-fatal): ${serializeError(cleanupError)}`);
    }

    // Release the lock so a waiting run can proceed even though this run failed.
    lock.release();

    log(`[integration-setup:${label}] NOTE: If the test runner reports "No test files found", ignore it — it is a side effect of the setup failure above.`);
    throw error;
  }
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

  log(`[integration-teardown:${result.transportLabel}] Tearing down...`);

  try {
    await teardownAsync(result);
  } catch (error: unknown) {
    log(`[integration-teardown:${result.transportLabel}] Cleanup error (non-fatal): ${serializeError(error)}`);
  } finally {
    activeSetups.delete(result);
    releaseSetupLock(result);
  }
}

/**
 * Augments transport options with session reuse info when the transport
 * supports it (currently Appium only).
 *
 * The augmented options are provided to test workers so they can reattach
 * to the existing session instead of creating a new one.
 *
 * @param options - The original transport options.
 * @param transport - The transport instance created during setup.
 * @returns The augmented options, or the original options if not applicable.
 */
function augmentTransportOptions(
  options: ObsidianTransportOptions | undefined,
  transport: ObsidianTransport
): ObsidianTransportOptions | undefined {
  if (options?.type !== 'obsidian-android-appium' || !(transport instanceof AppiumTransport)) {
    return options;
  }

  const sessionInfo = transport.getSessionInfo();
  log(`[integration-setup:${options.type}] Session reuse info: sessionId=${sessionInfo.sessionId}, deviceId=${sessionInfo.deviceId}`);

  return {
    ...options,
    deviceId: sessionInfo.deviceId,
    sessionId: sessionInfo.sessionId
  };
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
 * Resolves the lock scope for a transport. Runs that share an Obsidian instance
 * and its resources must serialize against each other, so the CLI and CDP
 * desktop transports share one scope while the Android transport uses another.
 *
 * @param transportOptions - The resolved transport options.
 * @returns The lock scope string.
 */
function getLockScope(transportOptions: ObsidianTransportOptions | undefined): string {
  return transportOptions?.type === 'obsidian-android-appium' ? ANDROID_LOCK_SCOPE : DESKTOP_LOCK_SCOPE;
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

    for (const result of [...activeSetups]) {
      coreTeardown(result).catch((error: unknown) => {
        log(`[integration-teardown:${result.transportLabel}] Process cleanup error (non-fatal): ${serializeError(error)}`);
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
        log(`[integration-teardown:${result.transportLabel}] Rejection cleanup error (non-fatal): ${serializeError(error)}`);
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
        log(`[integration-teardown:${result.transportLabel}] Sync transport cleanup error (non-fatal): ${serializeError(error)}`);
      }
      try {
        rmSync(result.tempVault.path, { force: true, recursive: true });
      } catch (error: unknown) {
        log(`[integration-teardown:${result.transportLabel}] Sync vault cleanup error (non-fatal): ${serializeError(error)}`);
      }
      releaseSetupLock(result);
    }
    activeSetups.clear();
  });
}

/**
 * Releases and forgets the setup lock associated with a result, if any.
 *
 * @param result - The setup result whose lock should be released.
 */
function releaseSetupLock(result: CoreSetupResult): void {
  const lock = setupLocks.get(result);
  if (lock) {
    lock.release();
    setupLocks.delete(result);
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

/**
 * Performs the async teardown work (vault disposal + transport disposal).
 *
 * @param result - The setup result to tear down.
 */
async function teardownAsync(result: CoreSetupResult): Promise<void> {
  try {
    await result.tempVault.dispose(result.transport);
  } catch (error: unknown) {
    log(`[integration-teardown:${result.transportLabel}] Vault cleanup error (non-fatal): ${serializeError(error)}`);
  }

  try {
    await result.transport.dispose?.();
  } catch (error: unknown) {
    log(`[integration-teardown:${result.transportLabel}] Transport cleanup error (non-fatal): ${serializeError(error)}`);
  }
}
