import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { GenericObject } from './eval-in-obsidian.ts';

import {
  getAppConfig,
  restoreAppConfig,
  setAppConfig,
  withAppConfig
} from './app-config.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { TemporaryVault } from './temporary-vault.ts';

/**
 * What the vault really stores for the key, alongside the effective value
 * Obsidian reads for it.
 *
 * The pair is the whole point: `value` alone cannot distinguish an unset key
 * from one set to Obsidian's own default, so only `isPresent` can witness the
 * delete an exact restore performs.
 */
interface AppConfigProbe {
  isPresent: boolean;
  value: unknown;
}

interface ProbeInput extends GenericObject {
  configKey: string;
}

/**
 * The key under test — the harness's own headless default, and the one
 * `obsidian-typings`' `ConfigItem` union omits.
 *
 * The suite stops at the config layer deliberately: `SettingsModal`'s
 * `shouldUsePopout()` is `getConfig('settingsPopoutWindow')` verbatim in the
 * shipped bundle, so asserting it would re-assert `value`, and the window
 * behaviour it drives is already measured by
 * `owned-instance-worker-attach.integration.test.ts`.
 */
const CONFIG_KEY = 'settingsPopoutWindow';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;

/*
 * A vault built in-worker carries NEITHER headless default — the write lives in
 * `coreSetup` / `connectToCdp`, not in `TemporaryVault` (see the project
 * `AGENTS.md`, L48). That is what this suite needs: the key starts ABSENT, so
 * both restore branches — delete a key that was never written, write a captured
 * value back — are reachable in one instance.
 */
const temporaryVault = new TemporaryVault();
let vaultPath: string;

async function probe(): Promise<AppConfigProbe> {
  return await evalInObsidian<ProbeInput, AppConfigProbe>({
    callback({ app, configKey }): AppConfigProbe {
      const getConfig = app.vault.getConfig.bind(app.vault) as (key: string) => unknown;

      return {
        isPresent: Object.hasOwn(app.vault.config, configKey),
        value: getConfig(configKey)
      };
    },
    input: { configKey: CONFIG_KEY },
    vaultPath
  });
}

beforeAll(async () => {
  await temporaryVault.register();
  vaultPath = temporaryVault.path;
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

describe('app-config integration', () => {
  it('should read Obsidian\'s own default for a key the vault never wrote', async () => {
    const before = await probe();
    expect(before.isPresent).toBe(false);

    // Obsidian ships the popout ON, and `getConfig` substitutes that default —
    // Which is exactly why a restore cannot be driven from this value alone.
    expect(before.value).toBe(true);
    expect(
      await getAppConfig({
        configKey: CONFIG_KEY,
        vaultPath
      })
    ).toBe(true);
  });

  it('should restore an absent key by deleting it again', async () => {
    const inside = await withAppConfig({
      callback: probe,
      configKey: CONFIG_KEY,
      value: false,
      vaultPath
    });

    expect(inside).toStrictEqual({
      isPresent: true,
      value: false
    });

    const after = await probe();
    expect(after).toStrictEqual({
      isPresent: false,
      value: true
    });
  });

  it('should write the captured value back for a key the vault carries', async () => {
    const initialRestore = await setAppConfig({
      configKey: CONFIG_KEY,
      value: false,
      vaultPath
    });
    expect(initialRestore.isPresent).toBe(false);
    expect(initialRestore.value).toBeUndefined();

    try {
      const inside = await withAppConfig({
        callback: probe,
        configKey: CONFIG_KEY,
        value: true,
        vaultPath
      });
      expect(inside).toStrictEqual({
        isPresent: true,
        value: true
      });

      const after = await probe();
      expect(after).toStrictEqual({
        isPresent: true,
        value: false
      });
    } finally {
      await restoreAppConfig(initialRestore);
    }

    // The suite leaves the instance as it found it — the contamination an inline
    // `setConfig` cannot avoid.
    const restored = await probe();
    expect(restored.isPresent).toBe(false);
  });

  it('should restore when the callback throws', async () => {
    await expect(withAppConfig({
      callback: (): Promise<never> => Promise.reject(new Error('callback failed')),
      configKey: CONFIG_KEY,
      value: false,
      vaultPath
    })).rejects.toThrow('callback failed');

    const restored = await probe();
    expect(restored.isPresent).toBe(false);
  });
});
