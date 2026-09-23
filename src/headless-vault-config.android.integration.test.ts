/**
 * @file
 *
 * The decisive test for the headless vault defaults on **Android** (**L48**): it asserts that the
 * `app.json` the harness writes before the vault is opened is what the app on the device actually reads.
 *
 * It exists because that was false for ten majors and nothing noticed. `register` pushes the whole vault
 * to the device — dotfiles included, so the good `app.json` lands — and then `registerVault`'s first act
 * was an unconditional `adb push` of the 2-byte `{}` vault marker to the very same path. `adb push`
 * truncates, so `alwaysUpdateLinks: true` was destroyed one call after it arrived, Obsidian opened the
 * vault with the shipped default (off), and every Android rename that touched links stopped dead on the
 * interactive *"Update links?"* sheet — the rename wall `src/headless-vault-config.ts` exists to remove,
 * alive on Android alone.
 *
 * Nothing caught it because every existing check sat on one side of the clobber:
 * `src/headless-vault-config.test.ts` mocks `node:fs` and proves only the **host** write; the two
 * integration suites that assert these keys end to end run on the **desktop** transport, where no marker
 * is ever pushed; and the Android suites asserted nothing about `app.json` at all. What it cost was two
 * projects' capture and behaviour suites, diagnosed twice as something else — and it surfaces as an
 * `EvalCapExceededError` naming the transport's per-eval cap, which sends the reader after the waiting
 * rather than after the sheet the waiting is stuck behind.
 *
 * The keys are read through `app.vault.getConfig` rather than off the file, because what matters is not
 * what is on the device's disk but what the **running app** resolved — which is the only thing a rename
 * consults.
 *
 * `coreSetup` is what normally writes these defaults, and this project deliberately has no transport
 * global setup (see `scripts/vitest-config.ts`), so the suite performs that same
 * `ensureHeadlessVaultConfig`-then-`register` sequence by hand. That is the sequence under test.
 *
 * Runs in its own Vitest project (`integration-tests:android`) against a real emulator via Appium. It is
 * deliberately NOT part of the default `integration-tests` aggregate, which is desktop.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { ensureHeadlessVaultConfig } from './headless-vault-config.ts';
import { TemporaryVault } from './temporary-vault.ts';

/*
 * The same budget `mobile-trusted-input.android.integration.test.ts` carries, and for the same reasons:
 * 240s of emulator boot and Appium session, plus the 120s the network-ready gate (L45) can add on a guest
 * that never reports a validated default network.
 */
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 360_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

describe('headless vault defaults on Android', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });

    // Exactly what `coreSetup` does, in the order it does it: write the defaults into the host vault, then
    // let `register` carry the directory across. The clobber this suite guards against happened INSIDE
    // `register`, after the push, so reproducing the ordering faithfully is the whole point.
    await ensureHeadlessVaultConfig({
      label: 'android-headless-config',
      vaultPath: vault.path
    });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  // Guard, not a feature test — the same one the other Android suite opens with. Without a registered
  // transport resolver the harness silently falls back to the desktop owned-CDP default, and this file
  // would then pass on desktop while claiming to prove something about Android. Desktop pushes no marker,
  // so it is precisely the platform on which this suite cannot fail.
  it('should actually be running on mobile', async () => {
    const isMobile = await evalInObsidian({
      callback({ obsidianModule }): boolean {
        return obsidianModule.Platform.isMobile;
      },
      vaultPath: vault.path
    });

    expect(isMobile).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // The assertion the whole file is for. `getConfig` falls back to Obsidian's defaults table when the key
  // is absent, and the shipped default is `false` — so a `true` here can only have come from the
  // harness's own `app.json`, surviving all the way to the opened vault.
  it('should open the vault with the alwaysUpdateLinks the harness wrote, not the marker that replaced it', async () => {
    const alwaysUpdateLinks = await evalInObsidian({
      callback({ app }): unknown {
        return app.vault.getConfig('alwaysUpdateLinks');
      },
      vaultPath: vault.path
    });

    expect(alwaysUpdateLinks).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // The second key travels the same path and was lost the same way. It is harmless on mobile —
  // `Platform.canPopoutWindow` is desktop-only — so this asserts the TRANSPORT, not a mobile behaviour:
  // it is the cheapest way to show the surviving `app.json` is the harness's whole file rather than one
  // key of it.
  it('should carry the whole harness app.json across, not just the one key', async () => {
    const settingsPopoutWindow = await evalInObsidian({
      callback({ app }): unknown {
        return (app.vault.getConfig as (configKey: string) => unknown)('settingsPopoutWindow');
      },
      vaultPath: vault.path
    });

    expect(settingsPopoutWindow).toBe(false);
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
