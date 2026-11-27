import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import { PageNotSettledError } from './settle-options.ts';
import { waitForSettledPage } from './wait-for-settled-page.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 30_000;
const CHURN_INTERVAL_IN_MILLISECONDS = 20;

const temporaryVault = new TemporaryVault();

interface ChurnHolder {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- The test sets and clears its interval id.
  __oitSettleChurn?: ReturnType<typeof setInterval>;
}

interface SettleWatchProbe {
  readonly __obsidianIntegrationTestingSettleWatch?: unknown;
}

// Starts an element that changes its text every 20 ms, for `durationInMilliseconds` or for good.
async function startChurn(durationInMilliseconds: null | number): Promise<void> {
  await evalInObsidian({
    callback({ durationInMilliseconds: duration, intervalInMilliseconds }): void {
      const probe = document.body.createDiv({ attr: { id: 'oit-settle-probe' } });
      const churn = probe.createDiv({ cls: 'oit-churn' });
      probe.createDiv({ cls: 'oit-still', text: 'still' });
      let count = 0;
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: a test-local window property.
      const holder = globalThis as unknown as ChurnHolder;
      holder.__oitSettleChurn = globalThis.setInterval(() => {
        count++;
        churn.setText(String(count));
        if (duration !== null && count * intervalInMilliseconds >= duration) {
          globalThis.clearInterval(holder.__oitSettleChurn);
        }
      }, intervalInMilliseconds);
    },
    input: { durationInMilliseconds, intervalInMilliseconds: CHURN_INTERVAL_IN_MILLISECONDS },
    vaultPath: temporaryVault.path
  });
}

beforeAll(async () => {
  await temporaryVault.register();
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterEach(async () => {
  await evalInObsidian({
    callback(): void {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: a test-local window property.
      globalThis.clearInterval((globalThis as unknown as ChurnHolder).__oitSettleChurn);
      document.querySelector('#oit-settle-probe')?.remove();
    },
    vaultPath: temporaryVault.path
  });
});

afterAll(async () => {
  await temporaryVault.dispose();
});

describe('waitForSettledPage', () => {
  it('should wait until a burst of changes has stopped', async () => {
    await startChurn(600);
    const startTime = Date.now();
    await waitForSettledPage({ root: '#oit-settle-probe', vaultPath: temporaryVault.path });
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeGreaterThanOrEqual(600);

    // The burst is over: nothing changes the probe any more.
    const text = await evalInObsidian({ callback: (): null | string => document.querySelector('#oit-settle-probe .oit-churn')?.textContent ?? null, vaultPath: temporaryVault.path });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    expect(await evalInObsidian({ callback: (): null | string => document.querySelector('#oit-settle-probe .oit-churn')?.textContent ?? null, vaultPath: temporaryVault.path })).toBe(text);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should name the DOM change when the page never settles', async () => {
    await startChurn(null);
    const error: unknown = await waitForSettledPage({ root: '#oit-settle-probe', timeoutInMilliseconds: 1000, vaultPath: temporaryVault.path }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(PageNotSettledError);
    const notSettled = error as PageNotSettledError;
    expect(notSettled.reasons).toHaveLength(1);
    expect(notSettled.reasons[0]).toMatch(/^the DOM changed \d+ ms ago$/);
    expect(notSettled.message).toContain('"#oit-settle-probe" was not quiet for 150 ms within 1000 ms');

    // The watch is stopped afterwards.
    expect(
      await evalInObsidian({
        // eslint-disable-next-line no-restricted-syntax -- Approved double cast: reads the harness's own window property.
        callback: (): boolean => (globalThis as unknown as SettleWatchProbe).__obsidianIntegrationTestingSettleWatch !== undefined,
        vaultPath: temporaryVault.path
      })
    ).toBe(false);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should ignore changes outside the root', async () => {
    await startChurn(null);
    await waitForSettledPage({ root: '#oit-settle-probe .oit-still', timeoutInMilliseconds: 2000, vaultPath: temporaryVault.path });
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should refuse a root that matches nothing', async () => {
    await expect(waitForSettledPage({ root: '.oit-nothing-here', vaultPath: temporaryVault.path })).rejects.toThrow('nothing matches root ".oit-nothing-here"');
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
