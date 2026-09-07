/**
 * @file
 *
 * Regression suite for the death of a harness-owned instance **mid-run**.
 *
 * It runs in its own project because it deliberately destroys the instance the
 * whole project shares — the same reason `failed-setup-fail-fast` has one — and
 * it reproduces, on purpose and in miniature, what cost `obsidian-patterns` 156
 * failing tests across 21 files on 2026-09-05: the app goes away, and every
 * later eval fails with `connect ECONNREFUSED` naming nothing.
 *
 * What it asserts is the fix: the process that owns the instance sees the exit,
 * records it, and a worker that only knows the port reports the death **by
 * name, with the exit code**, instead of a refused connection.
 */

import {
  describe,
  expect,
  inject,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { readOwnedInstanceExitMarker } from './owned-instance-exit-marker.ts';
import { OwnedInstanceExitedError } from './owned-instance-exited-error.ts';

const DEATH_REPORT_TIMEOUT_IN_MILLISECONDS = 30_000;
const DEATH_REPORT_POLL_INTERVAL_IN_MILLISECONDS = 250;

/**
 * Asks the renderer to destroy its own window, which — being the only one —
 * quits the app.
 *
 * `destroyCurrentWindow` schedules the destroy behind a timeout and resolves
 * immediately, so this eval returns normally and the instance dies just after
 * it: exactly the shape of the mid-run death, where a call that succeeded is
 * followed by a call with nothing to talk to.
 */
async function scheduleInstanceDeath(): Promise<void> {
  await evalInObsidian({
    /* v8 ignore start -- Evaluated inside Obsidian, not in the coverage-instrumented process. */
    async callback(): Promise<string> {
      interface IntegrationTestingNamespace {
        destroyCurrentWindow: () => Promise<void>;
      }
      interface IntegrationTestingHolder {
        __obsidianIntegrationTesting: IntegrationTestingNamespace;
      }

      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: `__obsidianIntegrationTesting` is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as IntegrationTestingHolder;
      // Resolves once the destroy is SCHEDULED (it is queued behind a timeout),
      // So this eval still returns normally and the death lands just after it.
      await holder.__obsidianIntegrationTesting.destroyCurrentWindow();
      return 'scheduled';
    }
    /* v8 ignore stop */
  });
}

/**
 * Evals until the instance's death is reported with its exit code.
 *
 * A retry loop rather than a single call, because the death is not
 * instantaneous from a worker's side: the window has to go, the process has to
 * exit, the owning process has to observe it, and only then does the worker's
 * open WebSocket start failing. Any eval before that point legitimately answers
 * something else.
 *
 * @returns The named error, once it carries what the owning process recorded.
 */
async function waitForReportedDeath(): Promise<OwnedInstanceExitedError> {
  const deadline = Date.now() + DEATH_REPORT_TIMEOUT_IN_MILLISECONDS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await evalInObsidian({ callback: () => 'still alive' });
    } catch (error: unknown) {
      lastError = error;
      if (error instanceof OwnedInstanceExitedError && error.code !== undefined) {
        return error;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DEATH_REPORT_POLL_INTERVAL_IN_MILLISECONDS);
    });
  }

  throw new Error(`The instance's death was never reported with its exit code. Last error: ${String(lastError)}`);
}

describe('a harness-owned instance that dies mid-run', () => {
  it('should report the death by name and with its exit code, not as a refused connection', async () => {
    await expect(evalInObsidian({ callback: () => 'alive' })).resolves.toBe('alive');

    await scheduleInstanceDeath();
    const error = await waitForReportedDeath();

    expect(error).toBeInstanceOf(OwnedInstanceExitedError);
    expect(error.message).toContain('is gone');
    expect(error.message).toContain('these failures are not test results');
    expect(error.message).not.toContain('ECONNREFUSED');

    // The exit marker is the cross-process channel: the worker never held the
    // Child, so an exit code here can only have come from the process that did.
    const transportOptions = inject('obsidianTransport');
    const port = transportOptions?.type === 'obsidian-cdp' ? transportOptions.port : undefined;
    expect(port).toBeDefined();
    const marker = readOwnedInstanceExitMarker(port ?? 0);
    expect(marker).toBeDefined();
    expect(marker?.pid).toBeGreaterThan(0);
    expect(error.code).toBe(marker?.code);
  });
});
