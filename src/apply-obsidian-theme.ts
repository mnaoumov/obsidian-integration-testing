/**
 * @file
 *
 * Switches the driven Obsidian to its dark or light theme, and makes the switch
 * survive a config reload.
 *
 * `app.changeTheme` only sets the theme in the in-memory config and SCHEDULES
 * the save, a second later (`requestSaveConfig` is debounced). Until that save
 * lands, any file-watcher event on `.obsidian/app.json` or
 * `.obsidian/appearance.json` makes Obsidian run `vault.reloadConfig`, which
 * re-reads both files and deletes every in-memory key the disk does not have —
 * `theme` included. The body then falls back to the light theme, and a capture
 * suite that set the dark theme shoots every frame light, silently writing over
 * the frames it has committed. Read from the 1.14.2 `app.js`, and reproduced in a
 * plugin's capture suite: one external rewrite of `app.json` straight after
 * `changeTheme` turned all five of its desktop frames light.
 *
 * {@link applyObsidianTheme} saves the config at once, so a reload finds the
 * theme on disk and has nothing to drop, and waits until the body carries the
 * theme's class and `appearance.json` carries its name. It also records the
 * theme it applied, so `captureObsidianScreenshot` can refuse a frame the theme
 * has left since.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type {
  EvalInObsidianParams,
  GenericObject
} from './eval-in-obsidian.ts';
import type { ObsidianTransport } from './transport.ts';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { normalizeOptionalProperties } from './normalize-optional-properties.ts';

/**
 * Parameters for {@link applyObsidianTheme}.
 */
export interface ApplyObsidianThemeParams {
  /**
   * The theme to switch to.
   */
  readonly theme: ObsidianTheme;

  /**
   * How long to wait for the theme to be applied and saved.
   *
   * @default 10000
   */
  readonly timeoutInMilliseconds?: number;

  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to switch. When omitted, the current test
   * context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * Parameters for {@link assertObsidianThemeUnchanged}.
 */
export interface AssertObsidianThemeUnchangedParams {
  /**
   * What the refusal is refusing, for its message, e.g. `capture a screenshot`.
   */
  readonly action: string;

  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to check. When omitted, the current test
   * context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * One of Obsidian's two built-in base themes.
 */
export type ObsidianTheme = 'dark' | 'light';

interface AppearanceConfig {
  readonly theme?: unknown;
}

// A `window` property rather than a closure variable: the apply and the check
// are separate evaluations. Spelled out in the holder rather than shared through
// a constant, because a closure is serialized and cannot reach module scope.
//
// Kept local rather than declared globally, like every other holder of a
// harness `window` property, so it never leaks into consumer types.
interface AppliedThemeHolder {
  __obsidianIntegrationTestingAppliedTheme?: ObsidianTheme | undefined;
}

interface ApplyThemeInput extends GenericObject {
  readonly theme: ObsidianTheme;
  readonly timeoutInMilliseconds: number;
}

const DEFAULT_TIMEOUT_IN_MILLISECONDS = 10_000;

/**
 * Switches Obsidian to its dark or light theme, saves the config at once, and
 * waits until the theme is both on screen and on disk.
 *
 * Use it instead of `app.changeTheme` in a capture suite: see the module
 * comment for the reload that silently undoes a bare `changeTheme`. The theme
 * is recorded, and `captureObsidianScreenshot` then refuses any frame whose body
 * is no longer in it, so a theme lost after this call fails the capture by name
 * instead of rewriting a committed frame.
 *
 * @param params - The theme, how long to wait, and transport / vault overrides.
 * @returns A {@link Promise} that resolves once the theme is applied and saved.
 * @throws Error if the theme is not applied and saved within the timeout.
 */
export async function applyObsidianTheme(params: ApplyObsidianThemeParams): Promise<void> {
  const {
    theme,
    timeoutInMilliseconds = DEFAULT_TIMEOUT_IN_MILLISECONDS,
    transport,
    vaultPath
  } = params;

  await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<ApplyThemeInput, undefined>>({
    async callback({ app, lib: { waitUntil }, theme: requestedTheme, timeoutInMilliseconds: timeout }): Promise<undefined> {
      const themeName = requestedTheme === 'dark' ? 'obsidian' : 'moonstone';
      const bodyClass = `theme-${requestedTheme}`;

      app.changeTheme(themeName);
      // Saving now, rather than on `changeTheme`'s own debounced schedule, is the
      // whole fix: a reload that finds the theme on disk has nothing to drop.
      await app.vault.saveConfig();

      await waitUntil({
        message: `the ${requestedTheme} theme to be applied and saved to appearance.json`,
        async predicate(): Promise<boolean> {
          const appearance = await app.vault.readConfigJson('appearance') as AppearanceConfig | null;
          return document.body.classList.contains(bodyClass) && appearance?.theme === themeName;
        },
        timeoutInMilliseconds: timeout
      });

      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the applied theme is this helper's own Window property, kept local rather than declared globally.
      (globalThis as unknown as AppliedThemeHolder).__obsidianIntegrationTestingAppliedTheme = requestedTheme;
      return undefined;
    },
    input: {
      theme,
      timeoutInMilliseconds
    },
    transport,
    vaultPath
  }));
}

/**
 * Throws when the body has left the theme {@link applyObsidianTheme} applied.
 *
 * Nothing is checked when no theme was applied through it, since there is then
 * no expectation to hold the frame to.
 *
 * @param params - What is being refused, and transport / vault overrides.
 * @returns A {@link Promise} that resolves when the theme still holds, or none
 *   was applied.
 * @throws Error naming the applied theme and the one on screen, if they differ.
 */
export async function assertObsidianThemeUnchanged(params: AssertObsidianThemeUnchangedParams): Promise<void> {
  const {
    action,
    transport,
    vaultPath
  } = params;

  const mismatch = await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, null | string>>({
    callback(): null | string {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the applied theme is this helper's own Window property, kept local rather than declared globally.
      const appliedTheme = (globalThis as unknown as AppliedThemeHolder).__obsidianIntegrationTestingAppliedTheme;
      if (appliedTheme === undefined || document.body.classList.contains(`theme-${appliedTheme}`)) {
        return null;
      }

      let shownTheme = 'neither dark nor light';
      if (document.body.classList.contains('theme-dark')) {
        shownTheme = 'dark';
      } else if (document.body.classList.contains('theme-light')) {
        shownTheme = 'light';
      }
      return `applyObsidianTheme applied the ${appliedTheme} theme, but the body is now ${shownTheme}`;
    },
    input: {},
    transport,
    vaultPath
  }));

  if (mismatch !== null) {
    throw new Error(
      `Refusing to ${action}: ${mismatch}. Something reset the theme after it was applied - typically a bare app.changeTheme, or a config reload. Call applyObsidianTheme again, or pass shouldVerifyTheme: false to capture the frame as it is.`
    );
  }
}

/* v8 ignore stop */
