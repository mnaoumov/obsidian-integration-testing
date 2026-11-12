/**
 * @file
 *
 * A closure that awaits a promise nothing references never settles, and Chromium may garbage-collect that
 * promise while `Runtime.evaluate` waits on it. CDP then answers the command with a protocol error,
 * `Promise was collected`, instead of a result. The desktop transport used to read only `result`, so that
 * answer came back as `undefined` with no error, and the failure surfaced later as an unrelated
 * `Cannot read properties of undefined`.
 *
 * The collection is forced here with `HeapProfiler.collectGarbage` rather than waited for, so the test
 * does not depend on when Chromium decides to collect.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { noop } from '../noop.ts';
import { getOrCreateTransport } from '../transport/transport-factory.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import { CollectedPromiseError } from './collected-promise-error.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 60_000;
const COLLECTION_DELAY_IN_MILLISECONDS = 1000;
const MAX_COLLECTION_ATTEMPTS = 5;

describe('a closure awaiting a collected promise', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  it('should reject with CollectedPromiseError rather than resolve to undefined', async () => {
    const transport = await getOrCreateTransport();
    const { collectGarbage } = transport;
    if (!collectGarbage) {
      throw new Error('The desktop transport must be able to force a garbage collection.');
    }

    const state = { isSettled: false };
    const evaluation = evalInObsidian({
      async callback(): Promise<string> {
        await new Promise<void>(() => {
          // Nothing keeps the resolver, so nothing can settle this promise and Chromium may collect it.
        });
        return 'unreachable';
      },
      vaultPath: vault.path
    }).finally(() => {
      state.isSettled = true;
    });
    // Keeps an early rejection from being reported as unhandled while the collections run.
    evaluation.catch(noop);

    for (let attempt = 0; attempt < MAX_COLLECTION_ATTEMPTS; attempt++) {
      if (state.isSettled) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, COLLECTION_DELAY_IN_MILLISECONDS);
      });
      await collectGarbage.call(transport, vault.path);
    }

    await expect(evaluation).rejects.toThrow(CollectedPromiseError);
    await expect(evaluation).rejects.toThrow(/garbage-collected/);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should leave the transport usable for the next evaluation', async () => {
    const markdownPaths = await evalInObsidian({
      callback({ app }): string[] {
        return app.vault.getMarkdownFiles().map((file) => file.path);
      },
      vaultPath: vault.path
    });

    expect(markdownPaths).toContain('note.md');
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
