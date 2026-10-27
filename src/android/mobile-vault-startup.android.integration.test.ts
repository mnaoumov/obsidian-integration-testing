import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  afterAll,
  expect,
  it
} from 'vitest';

import type { MobileVaultStartupProbeResult } from './mobile-vault-startup.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { pollUntil } from '../eval/poll-until.ts';
import { getCachedTransport } from '../transport/transport-factory.ts';
import { ensureNonNullable } from '../type-guards.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import { probeMobileVaultStartup } from './mobile-vault-startup.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 540_000;
const STARTUP_TIMEOUT_IN_MILLISECONDS = 180_000;
const POLL_INTERVAL_IN_MILLISECONDS = 500;
const oldVault = new TemporaryVault();
const requestedVault = new TemporaryVault();
const nextVault = new TemporaryVault();

afterAll(async () => {
  await nextVault.dispose();
  await requestedVault.dispose();
  await oldVault.dispose();
});

it('opens the exact requested vault from a real picker with an older registration', async () => {
  oldVault.populate({ 'old.md': 'old' });
  requestedVault.populate({ 'requested.md': 'requested' });
  await oldVault.register();
  await requestedVault.register();
  const transport = ensureNonNullable(getCachedTransport());
  const deviceVaultPath = `/sdcard/Documents/${basename(requestedVault.path)}`;
  const oldDeviceVaultPath = `/sdcard/Documents/${basename(oldVault.path)}`;
  await transport.evaluate(
    `(() => {
    const paths = JSON.parse(localStorage.getItem('mobile-external-vaults') ?? '[]');
    paths.push(${JSON.stringify(oldDeviceVaultPath)});
    localStorage.setItem('mobile-external-vaults', JSON.stringify(paths));
    app.openVaultChooser();
    return 'opening-picker';
  })()`,
    { cwd: requestedVault.path }
  );
  await pollUntil({
    attempt: () => transport.evaluate('String(!window.app && !!document.querySelector(\'.mobile-vault-chooser-screen.mod-main\'))', { cwd: requestedVault.path }),
    intervalInMilliseconds: POLL_INTERVAL_IN_MILLISECONDS,
    nowInMilliseconds: Date.now,
    sleep,
    timeoutInMilliseconds: STARTUP_TIMEOUT_IN_MILLISECONDS,
    until: (result) => result === 'true'
  });
  let hasOpenedVault = false;
  const actions: string[] = [];
  const result = await pollUntil({
    attempt: async () => {
      const params = { deviceVaultPath, shouldRecoverPicker: !hasOpenedVault };
      const probe = JSON.parse(await transport.evaluate(`JSON.stringify((${probeMobileVaultStartup.toString()})(${JSON.stringify(params)}))`, { cwd: requestedVault.path })) as MobileVaultStartupProbeResult;
      actions.push(probe.pickerAction);
      hasOpenedVault ||= probe.pickerAction === 'opened-vault';
      return probe;
    },
    intervalInMilliseconds: POLL_INTERVAL_IN_MILLISECONDS,
    nowInMilliseconds: Date.now,
    sleep,
    timeoutInMilliseconds: STARTUP_TIMEOUT_IN_MILLISECONDS,
    until: (probe) => probe.isLayoutReady
  });
  expect(actions).toContain('selected-vault');
  expect(actions).toContain('opened-vault');
  expect(result.vaultPath).toBe(deviceVaultPath);
  expect(await evalInObsidian({ callback: ({ obsidianModule }) => obsidianModule.Platform.isMobile, vaultPath: requestedVault.path })).toBe(true);
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

it('registers a new vault while the real app is on its picker', async () => {
  const transport = ensureNonNullable(getCachedTransport());
  await transport.evaluate('(app.openVaultChooser(), \'opening-picker\')', { cwd: requestedVault.path });
  await pollUntil({
    attempt: () => transport.evaluate('String(!window.app && !!document.querySelector(\'.mobile-vault-chooser-screen.mod-main\'))', { cwd: requestedVault.path }),
    intervalInMilliseconds: POLL_INTERVAL_IN_MILLISECONDS,
    nowInMilliseconds: Date.now,
    sleep,
    timeoutInMilliseconds: STARTUP_TIMEOUT_IN_MILLISECONDS,
    until: (result) => result === 'true'
  });
  nextVault.populate({ 'next.md': 'next' });
  await nextVault.register();
  expect(await evalInObsidian({ callback: ({ app }) => app.vault.getName(), vaultPath: nextVault.path })).toBe(basename(nextVault.path));
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);
