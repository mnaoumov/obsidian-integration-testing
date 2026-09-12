/**
 * @file
 *
 * Node-side read/write/restore seam for one of Obsidian's **vault config** keys,
 * for the few tests that need a different value than the harness's headless
 * default.
 *
 * `ensureHeadlessVaultConfig` writes `alwaysUpdateLinks: true` and
 * `settingsPopoutWindow: false` into every vault the harness provisions, before
 * that vault is ever opened, and neither is a knob a consumer configures — see
 * the project `AGENTS.md` (**L48**). That is right for almost every test, and
 * wrong for the few whose **subject is** the second Electron window the popout
 * creates: a test that waits on `activeWindow !== window`, or reads
 * `app.setting.popout`, never observes the thing it asserts and simply times out.
 *
 * Those tests opt back in through here rather than by hand, which buys three
 * things over an inline `setConfig` inside an `evalInObsidian` closure:
 *
 * - **The value is restored**, including deleting a key that had never been
 *   written. An inline setter writes into a vault shared with the rest of the
 *   run, so every later test in that instance inherits the change — the
 *   cross-test contamination the unconditional default exists to end.
 * - **The cast lives in one place.** `obsidian-typings`' `ConfigItem` union omits
 *   `settingsPopoutWindow`, so the key cannot be passed to `getConfig` /
 *   `setConfig` without widening them; every consumer that wrote the setter
 *   inline repeated that cast.
 * - **Per-test granularity.** A parameter on the provisioning write would be
 *   per-vault, and a project whose tests share one vault — the usual shape —
 *   cannot have it both ways.
 *
 * Everything here runs on the **Node** side. An `evalInObsidian` callback is
 * serialized into the driven Obsidian and can import nothing, so a helper
 * callable from inside one is not expressible; each function below is its own
 * short eval instead.
 *
 * ### Why presence is read off `app.vault.config`, not from `getConfig`
 *
 * Both facts were verified in the shipped 1.14.1 bundle rather than assumed:
 *
 * - `Vault.setConfig(key, value)` **deletes** the key when `value` is
 *   `undefined`, and does nothing at all when the value is unchanged (no save,
 *   no `config-changed` event). So an exact restore of a key that was never
 *   written is expressible.
 * - `Vault.getConfig(key)` falls back to Obsidian's defaults table when the key
 *   is absent, so it cannot tell *unset* from *set to the shipped default* —
 *   restoring from it would leave the key written where it had not been.
 *   `app.vault.config` holds only the keys changed from their default, so
 *   `Object.hasOwn` on it is the signal a restore needs.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian via evalInObsidian) covered by integration tests, not unit tests. */

import type {
  EvalInObsidianParams,
  GenericObject
} from './eval-in-obsidian.ts';
import type { ObsidianTransport } from './transport.ts';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { normalizeOptionalProperties } from './normalize-optional-properties.ts';

/**
 * Parameters for {@link getAppConfig}, and the shared shape of the writers below.
 */
export interface AppConfigParams {
  /**
   * The vault config key, e.g. `settingsPopoutWindow`. Not narrowed to
   * `obsidian-typings`' `ConfigItem`: that union omits keys Obsidian really
   * reads, `settingsPopoutWindow` among them, which is the whole reason a
   * consumer had to widen the setter by hand.
   */
  readonly configKey: string;

  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian instance to read or write. When omitted, the
   * current test context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * What {@link setAppConfig} captured before it wrote, and all
 * {@link restoreAppConfig} needs to put the key back exactly as it was —
 * including putting it back to *absent*.
 */
export interface AppConfigRestore {
  /**
   * The key that was written.
   */
  readonly configKey: string;

  /**
   * Whether the vault's config carried the key at all before the write. `false`
   * means the vault was running on Obsidian's own default, and restoring is a
   * delete rather than a write.
   */
  readonly isPresent: boolean;

  /**
   * The transport the capture was made against, so the restore lands in the
   * same instance.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The value the key held, or `undefined` when {@link isPresent} is `false`.
   */
  readonly value: unknown;

  /**
   * The vault the capture was made against, so the restore lands in the same
   * instance.
   */
  readonly vaultPath?: string;
}

/**
 * Parameters for {@link setAppConfig}.
 */
export interface SetAppConfigParams extends AppConfigParams {
  /**
   * The value to write. `undefined` deletes the key, leaving Obsidian's own
   * default in force.
   */
  readonly value: unknown;
}

/**
 * Parameters for {@link withAppConfig}.
 *
 * @typeParam T - What the wrapped work returns.
 */
export interface WithAppConfigParams<T> extends SetAppConfigParams {
  /**
   * The work to run while the key holds {@link SetAppConfigParams.value}.
   */
  readonly callback: (this: void) => Promise<T>;
}

/**
 * What a write captured about the key's state before it wrote.
 */
interface CapturedValue {
  isPresent: boolean;
  value: unknown;
}

/**
 * The serialized payload of a read.
 */
interface ReadInput extends GenericObject {
  configKey: string;
}

/**
 * The serialized payload of a restore.
 */
interface RestoreInput extends GenericObject {
  configKey: string;
  isPresent: boolean;
  value: unknown;
}

/**
 * The serialized payload of a write.
 */
interface WriteInput extends GenericObject {
  configKey: string;
  value: unknown;
}

/**
 * Reads a vault config key, resolving the transport and vault from the current
 * test context.
 *
 * This is Obsidian's own `Vault.getConfig`, so an absent key reads back as
 * Obsidian's **default** for it rather than as `undefined` — see this file's
 * header. Use {@link setAppConfig}'s {@link AppConfigRestore.isPresent} when the
 * difference matters.
 *
 * @param params - The key to read, and transport / vault overrides.
 * @returns A {@link Promise} resolving to the key's effective value.
 */
export async function getAppConfig(params: AppConfigParams): Promise<unknown> {
  const {
    configKey,
    transport,
    vaultPath
  } = params;

  return await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<ReadInput, unknown>>({
    callback({ app, configKey: key }): unknown {
      const getConfig = app.vault.getConfig.bind(app.vault) as (configKey: string) => unknown;
      return getConfig(key);
    },
    input: { configKey },
    transport,
    vaultPath
  }));
}

/**
 * Puts a key back exactly as {@link setAppConfig} found it — writing the captured
 * value back, or **deleting** the key when the vault had never carried it.
 *
 * The `beforeAll` / `afterAll` half of the seam. A test that scopes the change
 * to one callback wants {@link withAppConfig} instead, which cannot forget the
 * restore.
 *
 * @param restore - The token {@link setAppConfig} returned.
 * @returns A {@link Promise} that resolves once the key is back as it was.
 */
export async function restoreAppConfig(restore: AppConfigRestore): Promise<void> {
  const {
    configKey,
    isPresent,
    transport,
    value,
    vaultPath
  } = restore;

  await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<RestoreInput, undefined>>({
    callback({
      app,
      configKey: key,
      isPresent: wasPresent,
      value: previousValue
    }): undefined {
      const setConfig = app.vault.setConfig.bind(app.vault) as (configKey: string, value: unknown) => void;

      // `undefined` is not a no-op here: `setConfig` deletes the key for it,
      // Which is the only way to restore one the vault never carried.
      setConfig(key, wasPresent ? previousValue : undefined);
    },
    input: {
      configKey,
      isPresent,
      value
    },
    transport,
    vaultPath
  }));
}

/**
 * Writes a vault config key, capturing what it held first so the write can be
 * undone exactly.
 *
 * Obsidian persists the change (`requestSaveConfig`) and fires its
 * `config-changed` event, both of which the app's own settings UI does too — so
 * anything listening reacts as it would to a user flipping the toggle. A write
 * of the value the key already holds is a no-op in Obsidian itself, and the
 * returned token still describes the state that preceded it.
 *
 * @param params - The key, the value, and transport / vault overrides.
 * @returns A {@link Promise} resolving to the {@link AppConfigRestore} token to
 *   hand {@link restoreAppConfig}.
 */
export async function setAppConfig(params: SetAppConfigParams): Promise<AppConfigRestore> {
  const {
    configKey,
    transport,
    value,
    vaultPath
  } = params;

  const captured = await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<WriteInput, CapturedValue>>({
    callback({
      app,
      configKey: key,
      value: newValue
    }): CapturedValue {
      // `config` carries ONLY the keys changed from their default, which is what
      // Makes it the presence signal; `getConfig` substitutes the default and so
      // Cannot tell an unset key from one set to that default. The value itself
      // Still comes from `getConfig`, which returns the stored one whenever
      // There is one — so the read needs no cast of the config object.
      const isPresent = Object.hasOwn(app.vault.config, key);

      const getConfig = app.vault.getConfig.bind(app.vault) as (configKey: string) => unknown;
      const previousValue = isPresent ? getConfig(key) : undefined;

      const setConfig = app.vault.setConfig.bind(app.vault) as (configKey: string, value: unknown) => void;
      setConfig(key, newValue);

      return {
        isPresent,
        value: previousValue
      };
    },
    input: {
      configKey,
      value
    },
    transport,
    vaultPath
  }));

  return normalizeOptionalProperties<AppConfigRestore>({
    configKey,
    isPresent: captured.isPresent,
    transport,
    value: captured.value,
    vaultPath
  });
}

/**
 * Runs work with a vault config key temporarily set, and puts the key back
 * afterwards — on a throw as much as on a return.
 *
 * The shape a popout-subject test wants:
 *
 * ```ts
 * await withAppConfig({
 *   async callback() {
 *     await evalInObsidian({ ... }); // the settings window is a popout in here
 *   },
 *   configKey: 'settingsPopoutWindow',
 *   value: true,
 *   vaultPath
 * });
 * ```
 *
 * The callback runs on the **Node** side, so it is free to make several evals,
 * take a screenshot, or assert between them.
 *
 * @typeParam T - What the wrapped work returns.
 * @param params - The key, the value to hold it at, the work, and transport /
 *   vault overrides.
 * @returns A {@link Promise} resolving to whatever the callback returned.
 */
export async function withAppConfig<T>(params: WithAppConfigParams<T>): Promise<T> {
  const {
    callback,
    configKey,
    transport,
    value,
    vaultPath
  } = params;

  const restore = await setAppConfig(normalizeOptionalProperties<SetAppConfigParams>({
    configKey,
    transport,
    value,
    vaultPath
  }));

  try {
    return await callback();
  } finally {
    await restoreAppConfig(restore);
  }
}

/* v8 ignore stop */
