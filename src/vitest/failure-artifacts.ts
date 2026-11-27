/**
 * @file
 *
 * Wires the failure artifacts to every test of a Vitest integration project: a screenshot of the Obsidian window
 * when a test fails and, when opted in, the most recent frames of a screencast that ran for the test.
 *
 * Registered by the per-worker `vitest-setup`. The screenshot only uses a transport the worker already has: a test
 * that failed before it ever reached Obsidian must not provision one, which on Android boots an emulator.
 */

/* v8 ignore start -- Integration-time glue (Vitest hooks over a live Obsidian) covered by integration tests, not unit tests. */

import type { TestContext } from 'vitest';

import process from 'node:process';
import { beforeEach } from 'vitest';

import type { ScreencastRecording } from '../transport/transport.ts';

import {
  buildFailureArtifactBaseName,
  resolveFailureArtifactsSettings
} from '../capture/failure-artifacts-options.ts';
import {
  describeFailureArtifacts,
  startFailureScreencast,
  writeFailureArtifacts
} from '../capture/failure-artifacts.ts';
import { errorToString } from '../error-to-string.ts';
import { log } from '../log.ts';
import {
  getTransportOptions,
  getVaultPath
} from '../transport/context-provider.ts';
import {
  getCachedTransport,
  getOrCreateTransport
} from '../transport/transport-factory.ts';
import { getMostRecentRegisteredVault } from '../vault/registered-vaults.ts';

/**
 * How long a failure hook may run. Each of its steps has a bound of its own, well inside this.
 */
const FAILURE_HOOK_TIMEOUT_IN_MILLISECONDS = 60_000;

interface CaptureTarget {
  readonly transport: NonNullable<ReturnType<typeof getCachedTransport>>;
  readonly vaultPath: string;
}

/**
 * Registers the failure-artifact hooks for every test in the worker.
 */
export function registerFailureArtifactHooks(): void {
  beforeEach(async (context: TestContext) => {
    const settings = resolveFailureArtifactsSettings({
      environment: process.env,
      options: getTransportOptions(),
      projectRoot: process.cwd()
    });
    if (!settings.shouldCaptureScreenshot && settings.screencastFrameCount === 0) {
      return;
    }

    const screencast = settings.screencastFrameCount > 0
      ? await startScreencastForTest(settings.screencastFrameCount)
      : null;

    context.onTestFailed(async (failedContext: TestContext) => {
      const target = resolveCaptureTarget();
      if (target === null) {
        log(`[failure-artifacts] "${failedContext.task.name}" failed before this worker reached Obsidian, so there is no window to capture.`);
        return;
      }
      const baseName = buildFailureArtifactBaseName({
        filePath: failedContext.task.file.filepath,
        fullTestName: failedContext.task.fullTestName,
        retryCount: failedContext.task.result?.retryCount ?? 0
      });
      const result = await writeFailureArtifacts({
        baseName,
        outputDirectory: settings.outputDirectory,
        screencast,
        shouldCaptureScreenshot: settings.shouldCaptureScreenshot,
        transport: target.transport,
        vaultPath: target.vaultPath
      });
      // Logged rather than attached: Vitest refuses `annotate` once the test has finished in the fail state.
      log(describeFailureArtifacts(result, failedContext.task.name));
    }, FAILURE_HOOK_TIMEOUT_IN_MILLISECONDS);

    if (!screencast) {
      return;
    }
    context.onTestFinished(async () => {
      await screencast.stop();
    }, FAILURE_HOOK_TIMEOUT_IN_MILLISECONDS);
  }, FAILURE_HOOK_TIMEOUT_IN_MILLISECONDS);
}

function resolveCaptureTarget(): CaptureTarget | null {
  const registered = getMostRecentRegisteredVault();
  if (registered) {
    return { transport: registered.transport, vaultPath: registered.path };
  }
  const transport = getCachedTransport();
  const vaultPath = getVaultPath();
  return transport === null || vaultPath === null ? null : { transport, vaultPath };
}

async function startScreencastForTest(frameCount: number): Promise<null | ScreencastRecording> {
  try {
    const registered = getMostRecentRegisteredVault();
    const transport = registered?.transport ?? await getOrCreateTransport(getTransportOptions());
    const vaultPath = registered?.path ?? getVaultPath();
    if (vaultPath === null) {
      log('[failure-artifacts] No vault is open in this worker yet, so this test runs without a failure screencast.');
      return null;
    }
    return await startFailureScreencast({ frameCount, transport, vaultPath });
  } catch (error: unknown) {
    log(`[failure-artifacts] Could not start the failure screencast (non-fatal): ${errorToString(error)}`);
    return null;
  }
}

/* v8 ignore stop */
