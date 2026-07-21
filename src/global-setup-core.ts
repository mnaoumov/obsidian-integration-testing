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
import { setTimeout as sleep } from 'node:timers/promises';

import type { EnablePluginResult } from './enable-plugin.ts';
import type { SetupLock } from './setup-lock.ts';
import type { PopulateFilesParams } from './temp-vault.ts';
import type { ObsidianTransportOptions } from './transport-options.ts';
import type { ObsidianTransport } from './transport.ts';

import {
  enablePluginWithErrorCapture,
  getGenericPluginLoadFailureMessage
} from './enable-plugin.ts';
import { errorToString } from './error-to-string.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { log } from './log.ts';
import {
  computeBackoffDelayInMilliseconds,
  resolvePluginEnableRetryCount,
  resolvePluginEnableRetryDelayInMilliseconds,
  shouldRetryPluginEnable
} from './plugin-enable-retry.ts';
import { acquireSetupLock } from './setup-lock.ts';
import { TempVault } from './temp-vault.ts';
import { AppiumTransport } from './transport-appium.ts';
import { DesktopCdpTransport } from './transport-desktop-cdp.ts';
import { createTransportFromOptions } from './transport-factory.ts';

const DEFAULT_TRANSPORT_TYPE = 'obsidian-cdp';
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

const ANDROID_LOCK_SCOPE = 'android';

/**
 * Parameters for {@link coreSetup}.
 */
export interface CoreSetupParams {
  /**
   * Whether to install and enable the built plugin in the temp vault. Defaults
   * to `true`. Set to `false` for a **non-plugin** consumer (e.g. a typings
   * crawler) that only needs a registered, empty vault to `evalInObsidian`
   * against: the plugin `dist`/`manifest.json` read, the copy into
   * `.obsidian/plugins`, the `community-plugins.json` write, and the enable step
   * are all skipped, while the transport, temp vault, registration, and
   * worker-facing endpoint provisioning still run unchanged.
   */
  readonly installPlugin?: boolean | undefined;

  /**
   * Files and folders to write into the vault **before** Obsidian opens it, so
   * its startup scan indexes them in one pass (see {@link TempVault.populate}).
   * Use this for large fixtures — writing thousands of notes after open and
   * forcing a re-scan is far slower and less reliable.
   */
  readonly populate?: PopulateFilesParams | undefined;

  /** Transport options. When omitted, uses an off-screen owned desktop instance. */
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

  /** Short label for log messages (e.g. `"obsidian-cdp"`). */
  readonly transportLabel: string;

  /** The transport options that were resolved. */
  readonly transportOptions: ObsidianTransportOptions | undefined;
}

/**
 * Parameters for {@link copyPluginIntoVault}.
 */
interface CopyPluginIntoVaultParams {
  /** Short label for log messages. */
  readonly label: string;

  /** The project root to resolve the built plugin from. */
  readonly projectRoot: string;

  /** The temp vault to copy the plugin into. */
  readonly tempVault: TempVault;

  /** The transport (used for the mobile/desktop-only compatibility check). */
  readonly transport: ObsidianTransport;
}

/**
 * Parameters for {@link enablePluginInVault}.
 */
interface EnablePluginInVaultParams {
  /** Short label for log messages. */
  readonly label: string;

  /** The id of the plugin to enable. */
  readonly pluginId: string;

  /** The temp vault the plugin was copied into. */
  readonly tempVault: TempVault;

  /** The transport to evaluate against. */
  readonly transport: ObsidianTransport;

  /** The resolved transport options (source of the plugin-enable retry knobs). */
  readonly transportOptions: ObsidianTransportOptions | null;
}

/**
 * Framework-agnostic global setup logic.
 *
 * Loads `.env` from the project root, creates a transport, creates and registers
 * a temporary vault with Obsidian, and — unless {@link CoreSetupParams.installPlugin}
 * is `false` — copies the built plugin into the vault and enables it. The
 * plugin-less mode still launches the owned instance and publishes its
 * worker-facing endpoint, so a non-plugin consumer reuses the same attach wiring.
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

  const transportOptions = resolveIntegrationTransportOptions(params?.transportOptions);
  const label = transportOptions.type;
  const lockScope = getLockScope(transportOptions);

  let lock: SetupLock | undefined;
  if (lockScope !== undefined) {
    log(`[integration-setup:${label}] Acquiring '${lockScope}' setup lock (serializes against any concurrent integration-test run)...`);
    lock = await acquireSetupLock({ label, scope: lockScope });
    log(`[integration-setup:${label}] Setup lock acquired.`);
  }

  let transport: ObsidianTransport | undefined;
  let tempVault: TempVault | undefined;

  try {
    log(`[integration-setup:${label}] Creating transport...`);
    transport = await createTransportFromOptions(transportOptions);
    log(`[integration-setup:${label}] Transport created: ${transport.constructor.name}`);

    log(`[integration-setup:${label}] Project root: ${projectRoot}`);
    const shouldInstallPlugin = params?.installPlugin !== false;

    tempVault = new TempVault();
    log(`[integration-setup:${label}] Created temp vault: ${tempVault.path}`);

    let pluginId: string | undefined;

    if (shouldInstallPlugin) {
      pluginId = await copyPluginIntoVault({ label, projectRoot, tempVault, transport });
    } else {
      log(`[integration-setup:${label}] Skipping plugin install (installPlugin: false) — registering an empty vault.`);
    }

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

    if (pluginId !== undefined) {
      await enablePluginInVault({ label, pluginId, tempVault, transport, transportOptions });
    }

    const augmentedOptions = augmentTransportOptions(transportOptions, transport);
    const result: CoreSetupResult = { tempVault, transport, transportLabel: label, transportOptions: augmentedOptions };
    activeSetups.add(result);
    if (lock) {
      setupLocks.set(result, lock);
    }
    registerProcessCleanupHandler();
    return result;
  } catch (error: unknown) {
    log(`[integration-setup:${label}] Setup failed, cleaning up...`);
    try {
      if (tempVault && transport) {
        await tempVault.dispose(transport);
      }
    } catch (cleanupError: unknown) {
      log(`[integration-setup:${label}] Vault cleanup error (non-fatal): ${errorToString(cleanupError)}`);
    }
    try {
      await transport?.dispose?.();
    } catch (cleanupError: unknown) {
      log(`[integration-setup:${label}] Transport cleanup error (non-fatal): ${errorToString(cleanupError)}`);
    }

    // Release the lock so a waiting run can proceed even though this run failed.
    lock?.release();

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
    log(`[integration-teardown:${result.transportLabel}] Cleanup error (non-fatal): ${errorToString(error)}`);
  } finally {
    activeSetups.delete(result);
    releaseSetupLock(result);
  }
}

/**
 * Resolves transport options for an integration run.
 *
 * Desktop launches are normally visible, but test setup explicitly keeps its
 * owned instance off-screen so it does not interrupt the developer.
 *
 * @param options - Consumer-provided transport options.
 * @returns Options with the desktop integration visibility default applied.
 */
export function resolveIntegrationTransportOptions(options?: ObsidianTransportOptions): ObsidianTransportOptions {
  if (options?.type === 'obsidian-android-appium') {
    return options;
  }

  return {
    ...options,
    isObsidianAppVisible: options?.isObsidianAppVisible ?? false,
    type: 'obsidian-cdp'
  };
}

/**
 * Augments transport options with reuse info so test workers can reattach to the
 * instance the global setup already launched instead of creating their own:
 *
 * - **Appium** — injects the established `sessionId`/`deviceId`.
 * - **Owned desktop CDP** — injects the owned instance's `host`/`port` (chosen
 *   at launch) plus the internal `isHarnessOwnedInstance` flag, so each worker
 *   **attaches** to that instance over CDP rather than launching (and never
 *   registering) its own — the bug that otherwise leaves a worker's transport
 *   with no CDP endpoint.
 *
 * @param options - The original transport options.
 * @param transport - The transport instance created during setup.
 * @returns The augmented options, or the original options if not applicable.
 */
function augmentTransportOptions(
  options: ObsidianTransportOptions | undefined,
  transport: ObsidianTransport
): ObsidianTransportOptions | undefined {
  if (options?.type === 'obsidian-android-appium' && transport instanceof AppiumTransport) {
    const sessionInfo = transport.getSessionInfo();
    log(`[integration-setup:${options.type}] Session reuse info: sessionId=${sessionInfo.sessionId}, deviceId=${sessionInfo.deviceId}`);
    return {
      ...options,
      deviceId: sessionInfo.deviceId,
      sessionId: sessionInfo.sessionId
    };
  }

  if ((options === undefined || options.type === 'obsidian-cdp') && transport instanceof DesktopCdpTransport) {
    const endpoint = transport.getOwnedInstanceEndpoint();
    if (endpoint) {
      log(`[integration-setup:${DEFAULT_TRANSPORT_TYPE}] Owned instance reuse info: host=${endpoint.host}, port=${String(endpoint.port)}`);
      return {
        ...options,
        host: endpoint.host,
        isHarnessOwnedInstance: true,
        port: endpoint.port,
        type: 'obsidian-cdp'
      };
    }
  }

  return options;
}

/**
 * Copies the built plugin into the temp vault and marks it as a community plugin.
 *
 * Reads `manifest.json` from the newer of `dist/dev`/`dist/build`, rejects a
 * desktop-only plugin on a mobile transport, copies the build into
 * `.obsidian/plugins/<id>`, and writes `.obsidian/community-plugins.json`.
 *
 * @param params - The copy parameters.
 * @returns The plugin id read from the manifest.
 */
async function copyPluginIntoVault(params: CopyPluginIntoVaultParams): Promise<string> {
  const { label, projectRoot, tempVault, transport } = params;
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

  const pluginDir = join(tempVault.path, OBSIDIAN_CONFIG_DIR, PLUGINS_DIR, pluginId);
  await mkdir(pluginDir, { recursive: true });
  await cp(distPath, pluginDir, { recursive: true });
  await writeFile(join(tempVault.path, OBSIDIAN_CONFIG_DIR, COMMUNITY_PLUGINS_JSON), JSON.stringify([pluginId]));

  return pluginId;
}

/**
 * Enables the plugin in the registered vault and verifies it loaded.
 *
 * Obsidian's `enablePlugin()` wraps `loadPlugin()` in a try-catch that swallows
 * errors and returns false, so {@link enablePluginWithErrorCapture} monkey-patches
 * `loadPlugin()` to capture the error before it's swallowed.
 *
 * @param params - The enable parameters.
 */
async function enablePluginInVault(params: EnablePluginInVaultParams): Promise<void> {
  const { label, pluginId, tempVault, transport, transportOptions } = params;
  log(`[integration-setup:${label}] Enabling plugin "${pluginId}"...`);

  /*
   * Open a native console-capture window (Layer 2, Android only) around the
   * enable so that if Obsidian swallows the load error before the monkey-patch
   * and the renderer console (Layer 1) came up empty, we can still recover the
   * real cause from `adb logcat`. No-op (undefined) on transports that don't
   * implement it (e.g. desktop).
   */
  const captureHandle = await transport.beginConsoleCapture?.();

  /*
   * On a freshly cold-booted emulator the plugin subsystem can still be settling
   * when we enable the plugin, so a single-shot enable races the load and loses
   * (the plugin lands in the enabled set but never loads). Retry the enable +
   * load-verification a few times with exponential backoff, which recovers the
   * transient race. A captured load error (`realError`) is a deterministic bug —
   * retrying cannot fix it, so we fail fast. Non-Android transports resolve to
   * the same defaults but never enter the retry path: their load either succeeds
   * on the first attempt or throws a captured error.
   */
  const maxAttempts = 1 + resolvePluginEnableRetryCount(transportOptions);
  const baseDelayInMilliseconds = resolvePluginEnableRetryDelayInMilliseconds(transportOptions);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: EnablePluginResult;
    try {
      result = await evalInObsidian({
        args: { pluginId },
        fn: enablePluginWithErrorCapture,
        shouldSkipPreflightChecks: true,
        transport,
        vaultPath: tempVault.path
      });
    } catch (error) {
      /*
       * The eval itself threw (e.g. the WebView context was lost mid-execution on
       * a churning guest) — a transport-level transient. Retry if attempts remain.
       */
      if (attempt < maxAttempts) {
        const delayInMilliseconds = computeBackoffDelayInMilliseconds(baseDelayInMilliseconds, attempt - 1);
        log(
          `[integration-setup:${label}] Enable attempt ${String(attempt)}/${String(maxAttempts)} threw `
            + `(${errorToString(error)}); retrying in ${String(delayInMilliseconds)}ms...`
        );
        await sleep(delayInMilliseconds);
        continue;
      }
      throw error;
    }

    /*
     * `errorMessage` is the real throw seen by the monkey-patch;
     * `rendererConsoleErrors` (Layer 1) is the real cause console-logged in the renderer.
     */
    const realError = result.errorMessage ?? result.rendererConsoleErrors;

    if (result.isLoaded && !realError) {
      const attemptSuffix = attempt > 1 ? ` (attempt ${String(attempt)}/${String(maxAttempts)})` : '';
      log(`[integration-setup:${label}] Plugin "${pluginId}" enabled successfully${attemptSuffix}.`);
      return;
    }

    // A captured load error is deterministic — fail fast rather than retry.
    if (!shouldRetryPluginEnable(result)) {
      throw new Error(`Plugin "${pluginId}" failed to load: ${realError ?? getGenericPluginLoadFailureMessage(pluginId)}`);
    }

    // Transient cold-boot race (enabled but not loaded, no cause captured): retry.
    if (attempt < maxAttempts) {
      const delayInMilliseconds = computeBackoffDelayInMilliseconds(baseDelayInMilliseconds, attempt - 1);
      log(
        `[integration-setup:${label}] Plugin "${pluginId}" enabled but not loaded `
          + `(attempt ${String(attempt)}/${String(maxAttempts)}); retrying in ${String(delayInMilliseconds)}ms...`
      );
      await sleep(delayInMilliseconds);
    }
  }

  /*
   * Exhausted every attempt on the transient signature: compose the most
   * specific detail available (`adb logcat` tail on Android, else the generic
   * message) — unchanged from the pre-retry single-shot failure.
   */
  const logcatTail = await transport.readConsoleCaptureSince?.(captureHandle);
  const detail = logcatTail ?? getGenericPluginLoadFailureMessage(pluginId);
  throw new Error(`Plugin "${pluginId}" failed to load: ${detail}`);
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
 * Resolves the cross-process lock scope for a transport, or `undefined` when no
 * lock is needed.
 *
 * Desktop runs use harness-owned, isolated instances (their own user-data dir
 * and CDP port), so they no longer contend and need no lock. Only the Android
 * transport, which shares the single emulator and Appium server, must serialize.
 *
 * @param transportOptions - The resolved transport options.
 * @returns The lock scope string, or `undefined` if no lock is needed.
 */
function getLockScope(transportOptions: ObsidianTransportOptions | undefined): string | undefined {
  return transportOptions?.type === 'obsidian-android-appium' ? ANDROID_LOCK_SCOPE : undefined;
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
        log(`[integration-teardown:${result.transportLabel}] Process cleanup error (non-fatal): ${errorToString(error)}`);
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
        log(`[integration-teardown:${result.transportLabel}] Rejection cleanup error (non-fatal): ${errorToString(error)}`);
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
        log(`[integration-teardown:${result.transportLabel}] Sync transport cleanup error (non-fatal): ${errorToString(error)}`);
      }
      try {
        rmSync(result.tempVault.path, { force: true, recursive: true });
      } catch (error: unknown) {
        log(`[integration-teardown:${result.transportLabel}] Sync vault cleanup error (non-fatal): ${errorToString(error)}`);
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
    log(`[integration-teardown:${result.transportLabel}] Vault cleanup error (non-fatal): ${errorToString(error)}`);
  }

  try {
    await result.transport.dispose?.();
  } catch (error: unknown) {
    log(`[integration-teardown:${result.transportLabel}] Transport cleanup error (non-fatal): ${errorToString(error)}`);
  }
}
