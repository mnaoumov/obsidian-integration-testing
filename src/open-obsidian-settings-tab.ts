/**
 * @file
 *
 * Opens Obsidian's settings modal on a given tab in the instance the current
 * test context is already driving.
 *
 * The renderer-side work lives in the injected `lib` bag
 * (`lib.openSettingsTab`), where a callback that also probes the rendered DOM
 * can reach it. This is the context-resolving entry point for the far more
 * common case — a screenshot suite that only wants the tab on screen before it
 * calls `captureObsidianScreenshot`, and would otherwise write the same
 * `evalInObsidian` wrapper in every plugin.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type {
  EvalInObsidianParams,
  OpenSettingsTabParams
} from './eval-in-obsidian.ts';
import type { ObsidianTransport } from './transport.ts';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { normalizeOptionalProperties } from './normalize-optional-properties.ts';

/**
 * Options for {@link openObsidianSettingsTab}.
 */
export interface OpenObsidianSettingsTabOptions extends OpenSettingsTabParams {
  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to open the settings in. When omitted, the
   * current test context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * The serialized payload handed to the callback — the whole
 * {@link OpenSettingsTabParams} bag in one JSON-safe field.
 */
type OpenSettingsTabInput = Record<'openParams', OpenSettingsTabParams>;

/**
 * Opens Obsidian's settings modal on a given tab and waits until that tab has
 * actually rendered, resolving the transport and vault from the current test
 * context.
 *
 * See {@link Lib.openSettingsTab} for why simply calling `app.setting.open()`
 * renders nothing, and why the container must be attached **before** it.
 *
 * Close it again from a callback with `app.setting.close()`; re-opening works,
 * because the attach is idempotent.
 *
 * @param options - The tab to open, how long to wait, and transport / vault
 *   overrides.
 * @returns A {@link Promise} resolving to the names of the setting rows the tab
 *   rendered.
 * @throws Error if no tab carries {@link OpenSettingsTabParams.tabId}, or if the
 *   tab does not render within the timeout.
 */
export async function openObsidianSettingsTab(options: OpenObsidianSettingsTabOptions): Promise<string[]> {
  const {
    tabId,
    timeoutInMilliseconds,
    transport,
    vaultPath
  } = options;

  return await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<OpenSettingsTabInput, string[]>>({
    async callback({ lib, openParams }): Promise<string[]> {
      return await lib.openSettingsTab(openParams);
    },
    input: {
      openParams: normalizeOptionalProperties<OpenSettingsTabParams>({
        tabId,
        timeoutInMilliseconds
      })
    },
    transport,
    vaultPath
  }));
}

/* v8 ignore stop */
