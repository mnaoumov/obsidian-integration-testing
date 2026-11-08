/**
 * @file
 *
 * Detects an owned instance that opened its vault in **restricted mode**, so
 * the community plugins in `community-plugins.json` were never loaded at
 * startup, and builds the expression that turns restricted mode off for the
 * reload that loads them.
 *
 * `Plugins.initialize` (Obsidian 1.15.0 `app.js`) reads
 * `community-plugins.json` into `enabledPlugins`, loads the manifests, and then
 * returns before loading anything while `isEnabled()` is false. `isEnabled()`
 * reads `localStorage.getItem('enable-plugin-' + app.appId) === 'true'`, and a
 * fresh owned profile has no such key, so without this a plugin the setup
 * enabled "so it loads with the vault" was first loaded after the layout, by
 * the setup's own `enablePlugin` call. The same early return also calls
 * `customCss.globallyDisable()`, so a fresh profile's theme and snippets were
 * off as well.
 *
 * `localStorage` only exists once a renderer does, and the owned vault opens
 * in the first renderer, so the key cannot be written before the vault opens.
 * Writing it and reloading the window is the next earliest point: the reload
 * re-runs `initialize` with the key set.
 *
 * Both expressions are ES5 for the same reason as the trust-dialog
 * expression: they must parse on the oldest supported renderer.
 */

/**
 * The outcome of {@link STARTUP_PLUGIN_LOAD_PROBE_EXPRESSION}.
 */
export type StartupPluginLoad = StartupPluginLoadLoaded | StartupPluginLoadSkipped | StartupPluginLoadUnsupported;

/**
 * Every plugin enabled in `community-plugins.json` that has a manifest was
 * loaded at startup, or none is enabled.
 */
export interface StartupPluginLoadLoaded {
  /**
   * The ids of the plugins loaded at startup.
   */
  readonly loadedPluginIds: readonly string[];

  /**
   * The discriminator.
   */
  readonly state: 'loaded';
}

/**
 * At least one enabled plugin with a manifest was not loaded at startup.
 */
export interface StartupPluginLoadSkipped {
  /**
   * The vault's `app.appId`, the suffix of the `enable-plugin-` key.
   */
  readonly appId: string;

  /**
   * Whether `isEnabled()` was true when probed. `false` means restricted mode,
   * the case a reload fixes.
   */
  readonly isCommunityPluginsEnabled: boolean;

  /**
   * The ids of the enabled plugins that were not loaded.
   */
  readonly skippedPluginIds: readonly string[];

  /**
   * The discriminator.
   */
  readonly state: 'skipped';
}

/**
 * The renderer has no community-plugin registry to inspect (Obsidian before
 * 0.9.7, or a renderer without `app`).
 */
export interface StartupPluginLoadUnsupported {
  /**
   * The discriminator.
   */
  readonly state: 'unsupported';
}

/**
 * Evaluated in the owned vault's window once it is ready. Returns a JSON
 * string that {@link parseStartupPluginLoad} reads.
 *
 * `isEnabled()` is read but not trusted for the verdict: the trust-dialog
 * dismissal writes the key after `initialize` has already returned, so
 * `isEnabled()` can be true in a window that loaded nothing. The verdict is
 * whether each enabled plugin is in `app.plugins.plugins`, which `loadPlugin`
 * fills before `onload` runs.
 */
export const STARTUP_PLUGIN_LOAD_PROBE_EXPRESSION = `(function() {
  var app = window.app;
  var plugins = app && app.plugins;
  if (!plugins || !plugins.enabledPlugins || !plugins.manifests || !plugins.plugins || typeof plugins.enabledPlugins.forEach !== 'function') {
    return JSON.stringify({ state: 'unsupported' });
  }
  var has = Object.prototype.hasOwnProperty;
  var loaded = [];
  var skipped = [];
  plugins.enabledPlugins.forEach(function(id) {
    if (!has.call(plugins.manifests, id)) { return; }
    if (has.call(plugins.plugins, id)) { loaded.push(id); } else { skipped.push(id); }
  });
  if (skipped.length === 0) {
    return JSON.stringify({ loadedPluginIds: loaded, state: 'loaded' });
  }
  var isEnabled = typeof plugins.isEnabled === 'function' ? plugins.isEnabled() === true : false;
  return JSON.stringify({ appId: String(app.appId), isCommunityPluginsEnabled: isEnabled, skippedPluginIds: skipped, state: 'skipped' });
})()`;

/**
 * Builds the expression that turns restricted mode off for a vault and reloads
 * its window, so `Plugins.initialize` runs again with community plugins on.
 *
 * The reload is deferred so the evaluation that schedules it can answer
 * before the page goes away.
 *
 * @param appId - The vault's `app.appId`.
 * @returns The expression.
 */
export function buildEnableCommunityPluginsAndReloadExpression(appId: string): string {
  return `(function() {
  localStorage.setItem(${JSON.stringify(`enable-plugin-${appId}`)}, 'true');
  window.setTimeout(function() { window.location.reload(); }, ${String(RELOAD_DELAY_IN_MILLISECONDS)});
  return true;
})()`;
}

/**
 * Whether a probe result calls for the reload: plugins were skipped while
 * restricted mode was, or had been, on.
 *
 * A skip with community plugins already on at startup would be a plugin whose
 * load failed before Obsidian recorded it, which a reload does not fix — but
 * the probe cannot tell that from restricted mode turned off later by the
 * trust-dialog dismissal, so any skip qualifies. The caller reloads at most
 * once.
 *
 * @param load - The probe result.
 * @returns Whether to reload.
 */
export function checkShouldReloadForStartupPlugins(load: StartupPluginLoad): load is StartupPluginLoadSkipped {
  return load.state === 'skipped' && load.appId !== '' && load.appId !== 'undefined';
}

/**
 * Parses the JSON string {@link STARTUP_PLUGIN_LOAD_PROBE_EXPRESSION} returns.
 * Anything that is not one of its shapes reads as `unsupported`, so a probe
 * that misfires never triggers a reload.
 *
 * @param value - The evaluated value.
 * @returns The parsed result.
 */
export function parseStartupPluginLoad(value: unknown): StartupPluginLoad {
  const unsupported: StartupPluginLoadUnsupported = { state: 'unsupported' };
  if (typeof value !== 'string') {
    return unsupported;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return unsupported;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return unsupported;
  }
  const record = parsed as Record<string, unknown>;
  if (record['state'] === 'loaded' && checkIsStringArray(record['loadedPluginIds'])) {
    return { loadedPluginIds: record['loadedPluginIds'], state: 'loaded' };
  }
  return record['state'] === 'skipped'
      && typeof record['appId'] === 'string'
      && typeof record['isCommunityPluginsEnabled'] === 'boolean'
      && checkIsStringArray(record['skippedPluginIds'])
    ? {
      appId: record['appId'],
      isCommunityPluginsEnabled: record['isCommunityPluginsEnabled'],
      skippedPluginIds: record['skippedPluginIds'],
      state: 'skipped'
    }
    : unsupported;
}

/**
 * How long the reload waits after the expression that schedules it answers.
 */
export const RELOAD_DELAY_IN_MILLISECONDS = 100;

function checkIsStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
